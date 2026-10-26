import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { DecompositionDiagnostic, DecompositionDocumentV1, DecompositionEdit, DecompositionMode, HydeAssemblyReplacementImpact, HydeDecompositionExport, PartRecord, ReconstructionSettings, RegionMask, RegionRecord } from '../decomposer';
import { poseNativeDecomposition } from '../decomposer/pose';
import type { ReconstructionQualityReport } from '../decomposer/quality';
import type { ShapePath } from '../model';
import { removePathPoint, setPathHandle, splitPathSegment } from '../shapePath';
import { DecomposerWorkerClient } from './client';
import {HelpDialog,HelpHint,HelpTooltips,Walkthrough} from './HelpSystem';
import {CONTROL_HELP,ONBOARDING_PREFERENCE} from './helpContent';

type View = 'original' | 'reconstruction' | 'overlay' | 'side-by-side';
type Tool = 'select' | 'path' | 'paint-add' | 'paint-erase' | 'seed-add' | 'seed-erase' | 'landmark' | 'background' | 'pivot';
const TOOL_HELP_KEYS:Record<Tool,string>={select:'select',path:'path','paint-add':'paintAdd','paint-erase':'paintErase','seed-add':'seedAdd','seed-erase':'seedErase',landmark:'landmark',background:'background',pivot:'pivotTool'};
type WorkerState = { revision: number; document: DecompositionDocumentV1 };
type RegenerationRequest = { kind: 'analysis'; mode?: DecompositionMode; settings?: Partial<ReconstructionSettings> } |
  { kind: 'selected'; regionIds: string[]; settings?: Partial<ReconstructionSettings> };
type RegenerationImpact = { baseRevision: number; kind: RegenerationRequest['kind']; mode: DecompositionMode; settings: ReconstructionSettings;
  beforeActiveCount: number; afterActiveCount: number; addedIds: string[]; changedUnlockedIds: string[];
  removedUnlockedIds: string[]; retainedUnlockedIds: string[]; retainedProtectedIds: string[];
  changedProtectedIds: string[]; removedProtectedIds: string[]; diagnosticCount: number; remapped: Record<string, string>;
  previewContours: { id: string; sourceId: string; bounds: RegionRecord['bounds']; path: ShapePath; kind: 'removed' | 'before' | 'after' }[];
  omittedPreviewContours: number };
type NativeQualityReport = Omit<ReconstructionQualityReport, 'residualOverlayPng'>;
type CoarsePreview = { kind: 'coarse-preview'; scale: number; regionCount: number; omitted: number;
  contours: RegenerationImpact['previewContours'] };
type AssemblyReview = { name: string; bytes: Uint8Array; impact: HydeAssemblyReplacementImpact; revision: number; documentId: string };
const color = (hex: string): [number, number, number] => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
const current = (region: RegionRecord) => region.generationStatus !== 'historical';
const active = (region: RegionRecord) => current(region) && !region.suppressed;
const percentage = (value: number | null) => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
const displayScaleFor = (width: number, height: number, zoom: 'fit' | number): number =>
  zoom === 'fit' ? 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(width, height) / 1024))) : 1;
type CanvasTile = { x: number; y: number; width: number; height: number };
const viewportTile = (width: number, height: number, zoom: number, scrollLeft = 0, scrollTop = 0, viewportWidth = 0, viewportHeight = 0): CanvasTile => {
  const x = Math.min(width - 1, Math.floor(Math.max(0, scrollLeft) / zoom / 256) * 256);
  const y = Math.min(height - 1, Math.floor(Math.max(0, scrollTop) / zoom / 256) * 256);
  return { x, y, width: Math.min(width - x, Math.min(2048, Math.max(1024, Math.ceil(viewportWidth / zoom) + 256))),
    height: Math.min(height - y, Math.min(2048, Math.max(1024, Math.ceil(viewportHeight / zoom) + 256))) };
};
const download = (bytes: Uint8Array, name: string, mime: string) => {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

function drawPath(ctx: CanvasRenderingContext2D, region: RegionRecord, path: ShapePath, selectedIndex?: number): void {
  const { bounds } = region, points = path.points;
  if (!points.length) return;
  ctx.save(); ctx.lineWidth = Math.max(.35, Math.min(bounds.width, bounds.height) / 80); ctx.strokeStyle = '#02e5ce'; ctx.fillStyle = '#f8ffff';
  ctx.beginPath(); ctx.moveTo(bounds.x + points[0].x * bounds.width, bounds.y + points[0].y * bounds.height);
  for (let index = 0; index < points.length; index++) {
    const from = points[index], to = points[(index + 1) % points.length];
    const destination = { x: bounds.x + to.x * bounds.width, y: bounds.y + to.y * bounds.height };
    if (from.out || to.in) {
      const a = from.out ?? from, b = to.in ?? to;
      ctx.bezierCurveTo(bounds.x + a.x * bounds.width, bounds.y + a.y * bounds.height, bounds.x + b.x * bounds.width, bounds.y + b.y * bounds.height, destination.x, destination.y);
    } else ctx.lineTo(destination.x, destination.y);
  }
  ctx.closePath(); ctx.stroke();
  points.forEach((point, index) => {
    ctx.beginPath(); ctx.arc(bounds.x + point.x * bounds.width, bounds.y + point.y * bounds.height, index === selectedIndex ? 1.35 : .85, 0, Math.PI * 2);
    ctx.fillStyle = index === selectedIndex ? '#ffdd78' : '#f8ffff'; ctx.fill();
  });
  const selected = selectedIndex === undefined ? undefined : points[selectedIndex];
  if (selected) for (const side of ['in', 'out'] as const) {
    const handle = selected[side]; if (!handle) continue;
    const x = bounds.x + selected.x * bounds.width, y = bounds.y + selected.y * bounds.height;
    const hx = bounds.x + handle.x * bounds.width, hy = bounds.y + handle.y * bounds.height;
    ctx.strokeStyle = '#ffce74'; ctx.lineWidth = .55;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.fillStyle = side === 'in' ? '#ff8b86' : '#ffce74';
    ctx.beginPath(); ctx.arc(hx, hy, 1.1, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawRegenerationContour(ctx: CanvasRenderingContext2D, item: RegenerationImpact['previewContours'][number]): void {
  const { bounds, path } = item;
  ctx.save(); ctx.strokeStyle = item.kind === 'removed' ? '#ff5e78' : item.kind === 'before' ? '#ffbd64' : '#00ead3';
  ctx.lineWidth = 1.4; ctx.setLineDash([3, 2]);
  for (const contour of [path, ...(path.holes ?? [])]) {
    const points = contour.points; if (points.length < 3) continue;
    ctx.beginPath(); ctx.moveTo(bounds.x + points[0].x * bounds.width, bounds.y + points[0].y * bounds.height);
    for (let index = 0; index < points.length; index++) {
      const from = points[index], to = points[(index + 1) % points.length];
      const x = bounds.x + to.x * bounds.width, y = bounds.y + to.y * bounds.height;
      if (from.out || to.in) {
        const a = from.out ?? from, b = to.in ?? to;
        ctx.bezierCurveTo(bounds.x + a.x * bounds.width, bounds.y + a.y * bounds.height,
          bounds.x + b.x * bounds.width, bounds.y + b.y * bounds.height, x, y);
      } else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.stroke();
  }
  ctx.restore();
}

function paintDisc(mask: RegionMask, bounds: RegionRecord['bounds'], x: number, y: number, radius: number, value: number, hardness: number): void {
  const left = Math.max(0, Math.floor(x - radius - bounds.x)), right = Math.min(mask.width - 1, Math.ceil(x + radius - bounds.x));
  const top = Math.max(0, Math.floor(y - radius - bounds.y)), bottom = Math.min(mask.height - 1, Math.ceil(y + radius - bounds.y));
  if (hardness < 1 && !mask.alpha) mask.alpha = Uint8Array.from(mask.bytes, bit => bit ? 255 : 0);
  for (let row = top; row <= bottom; row++) for (let column = left; column <= right; column++) {
    const px = bounds.x + column + .5, py = bounds.y + row + .5;
    const distance = Math.hypot(px - x, py - y);
    if (distance > radius) continue;
    const coverage = hardness >= 1 || distance <= radius * hardness ? 255 : Math.round(255 * (radius - distance) / (radius * (1 - hardness)));
    if (!coverage) continue;
    const index = row * mask.width + column;
    const old = mask.alpha?.[index] ?? (mask.bytes[index] ? 255 : 0);
    const next = value ? Math.max(old, coverage) : Math.min(old, 255 - coverage);
    mask.bytes[index] = next > 0 ? 1 : 0;
    if (mask.alpha) mask.alpha[index] = next;
  }
}

function expandBrushMask(mask: RegionMask, bounds: RegionRecord['bounds'], points: { x: number; y: number }[], radius: number, width: number, height: number): { mask: RegionMask; bounds: RegionRecord['bounds'] } {
  const left = Math.max(0, Math.min(bounds.x, ...points.map(point => Math.floor(point.x - radius))));
  const top = Math.max(0, Math.min(bounds.y, ...points.map(point => Math.floor(point.y - radius))));
  const right = Math.min(width, Math.max(bounds.x + bounds.width, ...points.map(point => Math.ceil(point.x + radius))));
  const bottom = Math.min(height, Math.max(bounds.y + bounds.height, ...points.map(point => Math.ceil(point.y + radius))));
  const expanded = { x: left, y: top, width: right - left, height: bottom - top };
  if (expanded.x === bounds.x && expanded.y === bounds.y && expanded.width === bounds.width && expanded.height === bounds.height) return { mask, bounds };
  const bytes = new Uint8Array(expanded.width * expanded.height);
  const alpha = mask.alpha ? new Uint8Array(bytes.length) : undefined;
  for (let y = 0; y < mask.height; y++) {
    const offset = (bounds.y + y - top) * expanded.width + bounds.x - left;
    bytes.set(mask.bytes.subarray(y * mask.width, (y + 1) * mask.width), offset);
    if (alpha) alpha.set(mask.alpha!.subarray(y * mask.width, (y + 1) * mask.width), offset);
  }
  return { mask: { width: expanded.width, height: expanded.height, bytes, ...(alpha ? { alpha } : {}) }, bounds: expanded };
}

/** Snap only to a measured local alpha/color transition. Avoid moving a point on flat artwork. */
function snapToSourceEdge(point: { x: number; y: number }, pixels: Uint8ClampedArray, width: number, height: number, radius: number): { x: number; y: number } {
  const difference = (x: number, y: number, nx: number, ny: number): number => {
    const a = (y * width + x) * 4, b = (ny * width + nx) * 4;
    const alpha = Math.abs(pixels[a + 3] - pixels[b + 3]);
    const rgb = (Math.abs(pixels[a] - pixels[b]) + Math.abs(pixels[a + 1] - pixels[b + 1]) + Math.abs(pixels[a + 2] - pixels[b + 2])) / 3;
    return Math.max(alpha, rgb * Math.min(pixels[a + 3], pixels[b + 3]) / 255);
  };
  let best = { ...point }, score = 20;
  const cx = Math.floor(point.x), cy = Math.floor(point.y);
  for (let y = Math.max(1, cy - radius); y <= Math.min(height - 2, cy + radius); y++)
    for (let x = Math.max(1, cx - radius); x <= Math.min(width - 2, cx + radius); x++) {
      const distance = Math.hypot(x + .5 - point.x, y + .5 - point.y);
      if (distance > radius) continue;
      const edge = Math.max(difference(x, y, x - 1, y), difference(x, y, x + 1, y), difference(x, y, x, y - 1), difference(x, y, x, y + 1));
      const candidate = edge - distance * 5;
      if (candidate > score) { score = candidate; best = { x: x + .5, y: y + .5 }; }
    }
  return best;
}

export default function App() {
  const [helpOpen,setHelpOpen]=useState(false);
  const [walkthroughOpen,setWalkthroughOpen]=useState(()=>{try{return localStorage.getItem(ONBOARDING_PREFERENCE)!=='done';}catch{return true;}});
  const [walkthroughVersion,setWalkthroughVersion]=useState(0);
  const dismissWalkthrough=useCallback(()=>{setWalkthroughOpen(false);try{localStorage.setItem(ONBOARDING_PREFERENCE,'done');}catch{/* Browser preferences may be unavailable. */}},[]);
  const restartWalkthrough=useCallback(()=>{try{localStorage.removeItem(ONBOARDING_PREFERENCE);}catch{/* Continue without persistence. */}setWalkthroughVersion(value=>value+1);setWalkthroughOpen(true);setHelpOpen(false);},[]);
  const client = useRef<DecomposerWorkerClient>(null!);
  if (!client.current) client.current = new DecomposerWorkerClient();
  const sourceUrl = useRef<string | undefined>(undefined);
  const sourceImage = useRef<HTMLImageElement | undefined>(undefined);
  const sourcePixelsRef = useRef<Uint8ClampedArray | undefined>(undefined);
  const originalCanvas = useRef<HTMLCanvasElement>(null), reconstructionCanvas = useRef<HTMLCanvasElement>(null);
  const reconstructionRaster = useRef<{ document: DecompositionDocumentV1 | undefined; masks: Map<string, RegionMask>;
    pixels: Uint8ClampedArray; sourceId: string; scale: number; isolateId: string | undefined;
    tiles: { tile: CanvasTile; image: ImageData }[] } | undefined>(undefined);
  const [documentModel, setDocumentModel] = useState<DecompositionDocumentV1>();
  const [revision, setRevision] = useState(0), [selectedSourceId, setSelectedSourceId] = useState<string>();
  const [masks, setMasks] = useState<Map<string, RegionMask>>(new Map());
  const [selectedRegionId, setSelectedRegionId] = useState<string>();
  const [selectedPartId, setSelectedPartId] = useState<string>();
  const [view, setView] = useState<View>('side-by-side'), [tool, setTool] = useState<Tool>('select');
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [tileView, setTileView] = useState<{ key: string; original?: CanvasTile; reconstruction?: CanvasTile }>({ key: '' });
  const [diagnosticFocus, setDiagnosticFocus] = useState<{ sourceId: string; x: number; y: number }>();
  const originalCardRef = useRef<HTMLDivElement | null>(null), reconstructionCardRef = useRef<HTMLDivElement | null>(null);
  const [brushRadius, setBrushRadius] = useState(3), [brushHardness, setBrushHardness] = useState(1), [overlayAlpha, setOverlayAlpha] = useState(.5);
  const [featherRadius, setFeatherRadius] = useState(2), [featherStrength, setFeatherStrength] = useState(.65);
  const [selectedPoint, setSelectedPoint] = useState<number>(), [draftPoint, setDraftPoint] = useState<{ x: number; y: number }>();
  const [pathOffsetX, setPathOffsetX] = useState(0), [pathOffsetY, setPathOffsetY] = useState(0);
  const [draftHandle, setDraftHandle] = useState<{ side: 'in' | 'out'; x: number; y: number }>();
  const [edgeSnap, setEdgeSnap] = useState(false), [edgeSnapRadius, setEdgeSnapRadius] = useState(4);
  const [seedTolerance, setSeedTolerance] = useState(36), [seedRadius, setSeedRadius] = useState(24);
  const [pendingLandmark, setPendingLandmark] = useState<{ sourceId: string; x: number; y: number }>();
  const [renderVersion, setRenderVersion] = useState(0), [isolate, setIsolate] = useState(false);
  const [loadedSourceId, setLoadedSourceId] = useState<string>();
  const [primaryComparisonUrl, setPrimaryComparisonUrl] = useState<string>();
  const [hiddenTextureUrl, setHiddenTextureUrl] = useState<string>();
  const [showInferred, setShowInferred] = useState(true);
  const [requestedInference, setRequestedInference] = useState<boolean>();
  const [requestedMode, setRequestedMode] = useState<DecompositionMode>();
  const [draftSettings, setDraftSettings] = useState<ReconstructionSettings>();
  const [pendingRegeneration, setPendingRegeneration] = useState<{ label: string; request: RegenerationRequest; impact: RegenerationImpact }>();
  const [coarsePreview, setCoarsePreview] = useState<CoarsePreview>();
  const [busy, setBusy] = useState(false), [status, setStatus] = useState('Import one or more illustrations to begin.');
  const [restoring, setRestoring] = useState(false);
  const [cancellable, setCancellable] = useState(false);
  const [exportFormat, setExportFormat] = useState<'hyde' | 'hyproj'>('hyproj'), [allowHoleApproximation, setAllowHoleApproximation] = useState(false);
  const [assemblyReview, setAssemblyReview] = useState<AssemblyReview>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [posePreview, setPosePreview] = useState(false), [poseOffset, setPoseOffset] = useState(0);
  const previewUrlRef = useRef<string | undefined>(undefined);
  const [residualUrl, setResidualUrl] = useState<string>();
  const residualUrlRef = useRef<string | undefined>(undefined);
  const [nativeQuality, setNativeQuality] = useState<NativeQualityReport>();
  const [showResidual, setShowResidual] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<string>(), [partTarget, setPartTarget] = useState<string>();
  const [relationTarget, setRelationTarget] = useState<string>(), [matchTarget, setMatchTarget] = useState<string>();
  const [quality, setQuality] = useState<{ meanSampledMaskIoU: number; pointCount: number }>();
  const pointer = useRef<{ tool: Tool; points: { x: number; y: number }[]; anchor?: number; side?: 'in' | 'out' } | undefined>(undefined);
  const checkpoint = useRef<Uint8Array | undefined>(undefined);
  const workGeneration = useRef(0);
  const activeRenderAbort = useRef<AbortController | undefined>(undefined);

  const clearNativePreview = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    if (residualUrlRef.current) URL.revokeObjectURL(residualUrlRef.current);
    previewUrlRef.current = undefined; residualUrlRef.current = undefined;
    setPreviewUrl(undefined); setResidualUrl(undefined); setNativeQuality(undefined); setShowResidual(false); setPosePreview(false);
  }, []);
  useEffect(() => () => {
    activeRenderAbort.current?.abort();
    client.current.close();
    if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    if (residualUrlRef.current) URL.revokeObjectURL(residualUrlRef.current);
  }, []);
  const source = documentModel?.sources.find(item => item.id === selectedSourceId) ?? documentModel?.sources[0];
  const visibleRegions = useMemo(() => documentModel?.regions.filter(region => active(region) && region.sourceId === source?.id) ?? [], [documentModel, source?.id]);
  const suppressedRegions = useMemo(() => documentModel?.regions.filter(region => current(region) && region.suppressed && region.sourceId === source?.id) ?? [], [documentModel, source?.id]);
  const inferredRegions = useMemo(() => visibleRegions.filter(region => region.geometry.status === 'inferred'), [visibleRegions]);
  const selectedRegion = documentModel?.regions.find(item => item.id === selectedRegionId && active(item));
  const selectedSuppressedRegion = documentModel?.regions.find(item => item.id === selectedRegionId && current(item) && item.suppressed);
  useEffect(() => {
    setHiddenTextureUrl(undefined);
    if (!selectedRegion?.alignedTexture) return;
    let canceled = false, url: string | undefined;
    void client.current.call<{ bytes: Uint8Array }>('region.texturePreview', { id: selectedRegion.id }).then(response => {
      url = URL.createObjectURL(new Blob([response.bytes as BlobPart], { type: 'image/png' }));
      if (canceled) URL.revokeObjectURL(url); else setHiddenTextureUrl(url);
    }).catch(() => { if (!canceled) setHiddenTextureUrl(undefined); });
    return () => { canceled = true; if (url) URL.revokeObjectURL(url); };
  }, [selectedRegion?.id, selectedRegion?.alignedTexture?.sourceId, revision]);
  const selectedPart = documentModel?.parts.find(item => item.id === selectedPartId) ?? documentModel?.parts.find(item => item.id === selectedRegion?.partId);
  useEffect(() => { setPathOffsetX(0); setPathOffsetY(0); }, [selectedRegion?.id]);
  useEffect(() => setPoseOffset(0), [selectedPart?.id]);
  const selectedPath = selectedRegion?.geometry.manualPath ?? selectedRegion?.geometry.generatedPath;
  const primarySourceId = documentModel?.sources.find(item => item.role === 'primary')?.id;
  const primarySource = documentModel?.sources.find(item => item.id === primarySourceId);
  useEffect(() => {
    setPrimaryComparisonUrl(undefined);
    if (!primarySource || !source || source.role === 'primary') return;
    let canceled = false, url: string | undefined;
    void client.current.call<{ bytes: Uint8Array }>('source', { id: primarySource.id }).then(response => {
      url = URL.createObjectURL(new Blob([response.bytes as BlobPart], { type: 'image/png' }));
      if (canceled) URL.revokeObjectURL(url); else setPrimaryComparisonUrl(url);
    }).catch(() => { if (!canceled) setPrimaryComparisonUrl(undefined); });
    return () => { canceled = true; if (url) URL.revokeObjectURL(url); };
  }, [primarySource?.id, primarySource?.byteHash, source?.id, source?.role]);
  const referenceRegionLabel = (region: RegionRecord) => {
    const sourceName = documentModel?.sources.find(item => item.id === region.sourceId)?.name ?? region.sourceId;
    return `${sourceName} · (${region.bounds.x}, ${region.bounds.y}) · ${region.bounds.width}×${region.bounds.height} px`;
  };
  const selectedMatches = documentModel?.correspondences.filter(item => selectedRegion && item.regionIds?.includes(selectedRegion.id) &&
    item.kind !== 'landmark' && item.kind !== 'source-alignment') ?? [];
  const alignedTextureChoices = selectedRegion?.geometry.status === 'inferred' && documentModel
    ? documentModel.sources.filter(candidate => candidate.role !== 'primary' && candidate.transformToPrimary &&
      documentModel.correspondences.some(match => match.origin === 'manual' && match.kind === 'same-part' && match.accepted &&
        match.regionIds?.some(id => documentModel.regions.some(region => region.id === id && region.sourceId === candidate.id && active(region))) &&
        match.regionIds?.some(id => documentModel.regions.some(region => region.id === id && region.sourceId === selectedRegion.sourceId && region.partId === selectedRegion.partId && region.geometry.status === 'visible' && active(region)))))
    : [];
  const matchByAlternate = new Map<string, typeof selectedMatches[number]>();
  for (const item of selectedMatches) {
    const otherId = item.regionIds?.find(id => id !== selectedRegion?.id);
    if (otherId && (!matchByAlternate.has(otherId) || item.accepted)) matchByAlternate.set(otherId, item);
  }
  const alignmentLandmarkIds = documentModel?.correspondences.filter(item => item.kind === 'landmark' && item.accepted && primarySourceId && source && item.sourceIds.includes(primarySourceId) && item.sourceIds.includes(source.id)).map(item => item.id) ?? [];
  const canvasZoomStyle = source && zoom !== 'fit' ? { width: source.width * zoom, height: source.height * zoom } : undefined;
  const tiled = Boolean(source && zoom !== 'fit' && Math.max(source.width, source.height) > 1024);
  const tileKey = source && tiled ? `${source.id}:${zoom}` : '';
  const fallbackTile = source && zoom !== 'fit' ? viewportTile(source.width, source.height, zoom) : undefined;
  const originalTile = tileView.key === tileKey ? tileView.original ?? fallbackTile : fallbackTile;
  const reconstructionTile = tileView.key === tileKey ? tileView.reconstruction ?? fallbackTile : fallbackTile;
  const updateTile = (side: 'original' | 'reconstruction', card: HTMLDivElement) => {
    if (!source || zoom === 'fit' || !tiled) return;
    const next = viewportTile(source.width, source.height, zoom, card.scrollLeft, card.scrollTop, card.clientWidth, card.clientHeight);
    setTileView(previous => {
      const current = previous.key === tileKey ? previous : { key: tileKey };
      const old = current[side];
      return old && old.x === next.x && old.y === next.y && old.width === next.width && old.height === next.height
        ? previous : { ...current, [side]: next };
    });
  };
  useEffect(() => {
    if (!tiled || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (originalCardRef.current) updateTile('original', originalCardRef.current);
      if (reconstructionCardRef.current) updateTile('reconstruction', reconstructionCardRef.current);
    });
    if (originalCardRef.current) observer.observe(originalCardRef.current);
    if (reconstructionCardRef.current) observer.observe(reconstructionCardRef.current);
    return () => observer.disconnect();
  }, [tileKey, view, tiled]);
  useEffect(() => {
    if (!diagnosticFocus || source?.id !== diagnosticFocus.sourceId || loadedSourceId !== diagnosticFocus.sourceId || zoom === 'fit') return;
    const frame = requestAnimationFrame(() => {
      for (const card of [originalCardRef.current, reconstructionCardRef.current]) {
        if (!card) continue;
        card.scrollLeft = Math.max(0, diagnosticFocus.x * zoom - card.clientWidth / 2);
        card.scrollTop = Math.max(0, diagnosticFocus.y * zoom - card.clientHeight / 2);
        updateTile(card === originalCardRef.current ? 'original' : 'reconstruction', card);
      }
      setDiagnosticFocus(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [diagnosticFocus, source?.id, loadedSourceId, zoom, view]);

  const readSource = useCallback(async (sourceId: string, doc: DecompositionDocumentV1) => {
    const generation = workGeneration.current;
    const metadata = doc.sources.find(item => item.id === sourceId); if (!metadata) return;
    const response = await client.current.call<{ bytes: Uint8Array; rgba: Uint8Array }>('source', { id: sourceId, pixels: true });
    if (generation !== workGeneration.current) return;
    const url = URL.createObjectURL(new Blob([response.bytes as BlobPart], { type: 'image/png' }));
    const image = new Image(); image.src = url; await image.decode();
    if (generation !== workGeneration.current) { URL.revokeObjectURL(url); return; }
    if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
    sourceUrl.current = url; sourceImage.current = image; sourcePixelsRef.current = new Uint8ClampedArray(response.rgba.buffer);
    setLoadedSourceId(sourceId);
    setRenderVersion(value => value + 1);
  }, []);
  async function navigateDiagnostic(item: DecompositionDiagnostic) {
    if (!documentModel || busy) return;
    const region = item.regionId ? documentModel.regions.find(candidate => candidate.id === item.regionId && current(candidate))
      : item.partId ? documentModel.regions.find(candidate => candidate.partId === item.partId && active(candidate)) : undefined;
    const target = documentModel.sources.find(candidate => candidate.id === (item.sourceId ?? region?.sourceId));
    if (!target) return;
    const bounds = item.bounds ?? region?.bounds;
    setSelectedSourceId(target.id); setSelectedRegionId(region?.id); setSelectedPartId(item.partId ?? region?.partId);
    setView('side-by-side'); setZoom(value => value === 'fit' ? 2 : value);
    setDiagnosticFocus({ sourceId: target.id, x: bounds ? bounds.x + bounds.width / 2 : target.width / 2,
      y: bounds ? bounds.y + bounds.height / 2 : target.height / 2 });
    if (target.id !== loadedSourceId) {
      const generation = workGeneration.current;
      setBusy(true);
      try {
        await readSource(target.id, documentModel);
        if (generation !== workGeneration.current) return;
        const response = await client.current.call<{ id: string; mask: RegionMask }[]>('masks', { sourceId: target.id });
        if (generation !== workGeneration.current) return;
        setMasks(new Map(response.map(entry => [entry.id, entry.mask])));
      } catch (error) { if (generation === workGeneration.current) setStatus(error instanceof Error ? error.message : 'Diagnostic navigation failed.'); return; }
      finally { if (generation === workGeneration.current) setBusy(false); }
    }
    setStatus(`Focused ${item.code} on ${target.name}${region ? `, region ${region.id}` : ''}.`);
  }
  const refresh = useCallback(async (state: WorkerState, loadSource = false) => {
    const generation = workGeneration.current;
    clearNativePreview();
    setCoarsePreview(undefined);
    setPendingRegeneration(undefined); setDraftSettings(state.document.settings);
    setRequestedMode(undefined); setRequestedInference(undefined);
    setDocumentModel(state.document); setRevision(state.revision);
    const primary = state.document.sources.find(item => item.role === 'primary') ?? state.document.sources[0];
    const sourceId = loadSource || !selectedSourceId || !state.document.sources.some(item => item.id === selectedSourceId) ? primary?.id : selectedSourceId;
    if (sourceId) {
      setSelectedSourceId(sourceId);
      const response = await client.current.call<{ id: string; mask: RegionMask }[]>('masks', { sourceId });
      if (generation !== workGeneration.current) return;
      setMasks(new Map(response.map(item => [item.id, item.mask])));
      if (loadSource || sourceImage.current === undefined || source?.id !== sourceId) await readSource(sourceId, state.document);
      if (generation !== workGeneration.current) return;
    }
    const comparison = await client.current.call('compare');
    if (generation !== workGeneration.current) return;
    setQuality(comparison);
    setRenderVersion(value => value + 1);
  }, [clearNativePreview, readSource, selectedSourceId, source?.id]);

  const perform = useCallback(async (edits: DecompositionEdit[], mask?: RegionMask) => {
    if (!documentModel || busy) return;
    const generation = workGeneration.current;
    setBusy(true);
    try {
      const response = await client.current.call<{ result: { ok: boolean; error?: { message: string } }; revision: number; document: DecompositionDocumentV1 }>('execute', { expectedRevision: revision, edits, mask });
      if (generation !== workGeneration.current) return;
      if (!response.result.ok) throw new Error(response.result.error?.message ?? 'Edit failed.');
      await refresh(response);
      if (generation !== workGeneration.current) return;
      setStatus(`${edits.map(item => item.op).join(', ')} saved in revision ${response.revision}.`);
    } catch (error) { if (generation === workGeneration.current) setStatus(error instanceof Error ? error.message : 'Edit failed.'); }
    finally { if (generation === workGeneration.current) setBusy(false); }
  }, [documentModel, busy, revision, refresh]);

  async function importImages(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])]; event.target.value = '';
    if (!files.length || busy) return;
    const generation = workGeneration.current;
    setBusy(true); setCancellable(true); setCoarsePreview(undefined); setStatus('Importing original references locally…');
    try {
      if (documentModel) checkpoint.current = (await client.current.call<{ bytes: Uint8Array }>('save')).bytes;
      if (generation !== workGeneration.current) return;
      const inputs = await Promise.all(files.map(async (file, index) => ({ name: file.name, mime: file.type, role: index === 0 ? 'primary' : 'alternate-view', bytes: new Uint8Array(await file.arrayBuffer()) })));
      if (generation !== workGeneration.current) return;
      const imported = await client.current.call<WorkerState>('import', { inputs, options: { name: files[0].name.replace(/\.[^.]+$/, '') } });
      if (generation !== workGeneration.current) return;
      setLoadedSourceId(undefined);
      await refresh(imported, true);
      if (generation !== workGeneration.current) return;
      setSelectedRegionId(undefined); setSelectedPartId(undefined); setPendingLandmark(undefined);
      checkpoint.current = (await client.current.call<{ bytes: Uint8Array }>('save')).bytes;
      if (generation !== workGeneration.current) return;
      setStatus(`Imported ${files.length} reference${files.length === 1 ? '' : 's'}. Analyzing…`);
      await new Promise(resolve => window.setTimeout(resolve, 0));
      if (generation !== workGeneration.current) return;
      const analyzed = await client.current.call<WorkerState>('analyze', { coarsePreview: true }, (progress: CoarsePreview) => {
        if (progress.kind !== 'coarse-preview' || generation !== workGeneration.current) return;
        setCoarsePreview(progress);
        setStatus(`Coarse ${progress.scale}× source preview: ${progress.regionCount} provisional regions. Full-resolution analysis continues…`);
      });
      if (generation !== workGeneration.current) return;
      await refresh(analyzed, true);
      if (generation !== workGeneration.current) return;
      checkpoint.current = (await client.current.call<{ bytes: Uint8Array }>('save')).bytes;
      if (generation !== workGeneration.current) return;
      setStatus(`Automatic first pass found ${analyzed.document.regions.filter(active).length} editable regions. Inspect boundaries and diagnostics before export.`);
    } catch (error) { if (generation === workGeneration.current) setStatus(error instanceof Error ? error.message : 'Import failed.'); }
    finally { if (generation === workGeneration.current) { setCoarsePreview(undefined); setCancellable(false); setBusy(false); } }
  }
  async function openDocument(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file || busy) return;
    const generation = workGeneration.current;
    setBusy(true); setCancellable(true);
    try {
      if (documentModel) checkpoint.current = (await client.current.call<{ bytes: Uint8Array }>('save')).bytes;
      if (generation !== workGeneration.current) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (generation !== workGeneration.current) return;
      const opened = await client.current.call<WorkerState>('open', { bytes });
      if (generation !== workGeneration.current) return;
      setLoadedSourceId(undefined);
      await refresh(opened, true);
      if (generation !== workGeneration.current) return;
      checkpoint.current = bytes;
      setSelectedRegionId(undefined); setSelectedPartId(undefined); setPendingLandmark(undefined); setStatus(`Opened ${file.name}; original references and edits are available.`);
    } catch (error) { if (generation === workGeneration.current) setStatus(error instanceof Error ? error.message : 'Open failed.'); }
    finally { if (generation === workGeneration.current) { setCancellable(false); setBusy(false); } }
  }
  async function saveDocument() {
    if (!documentModel || busy) return;
    const generation = workGeneration.current;
    setBusy(true);
    try { const response = await client.current.call<{ bytes: Uint8Array }>('save'); if (generation !== workGeneration.current) return; checkpoint.current = response.bytes; download(response.bytes, `${documentModel.name}.hydecomp`, 'application/zip'); setStatus('Editable .hydecomp document saved.'); }
    catch (error) { if (generation === workGeneration.current) setStatus(error instanceof Error ? error.message : 'Save failed.'); }
    finally { if (generation === workGeneration.current) setBusy(false); }
  }
  async function reviewAssembly(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    setAssemblyReview(undefined);
    if (!file || !documentModel || busy) return;
    if (file.size > 256 * 1024 * 1024) { setStatus('Selected assembly exceeds the 256 MiB review limit.'); return; }
    const generation = workGeneration.current, documentId = documentModel.id, baseRevision = revision;
    setBusy(true); setStatus(`Reviewing ${file.name} against the current decomposition…`);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (generation !== workGeneration.current) return;
      const impact = await client.current.call<HydeAssemblyReplacementImpact>('replacement.plan', { bytes });
      if (generation !== workGeneration.current) return;
      setAssemblyReview({ name: file.name, bytes, impact, revision: baseRevision, documentId });
      setStatus(`Review ready for ${file.name}. Inspect the native IDs before exporting a replacement.`);
    } catch (error) { if (generation === workGeneration.current) setStatus(error instanceof Error ? error.message : 'Assembly review failed.'); }
    finally { if (generation === workGeneration.current) setBusy(false); }
  }
  async function nativeExport(preview = false, pose?: { partId: string; value: number }, replacement?: AssemblyReview) {
    if (!documentModel || busy) return;
    if (replacement && (replacement.revision !== revision || replacement.documentId !== documentModel.id)) {
      setStatus('The decomposition changed after this review. Select the target assembly again.'); return;
    }
    const generation = workGeneration.current;
    const renderAbort = new AbortController();
    if (preview) activeRenderAbort.current = renderAbort;
    setBusy(true); setCancellable(true); setStatus(preview ? 'Rendering the native Hyde project…' : replacement ? `Preparing replacement for ${replacement.name}…` : `Exporting editable .${exportFormat}…`);
    try {
      checkpoint.current = (await client.current.call<{ bytes: Uint8Array }>('save')).bytes;
      if (generation !== workGeneration.current) return;
      const result = await client.current.call<HydeDecompositionExport>('export', { options: { format: replacement ? 'hyproj' : preview ? 'hyde' : exportFormat, allowHoleApproximation,
        ...(replacement ? { targetAssemblyBytes: replacement.bytes, expectedTargetFingerprint: replacement.impact.targetFingerprint, replaceExisting: true } : {}) } });
      if (generation !== workGeneration.current) return;
      if (preview) {
        clearNativePreview();
        const posed = pose ? poseNativeDecomposition(result, pose.partId, pose.value) : undefined;
        const renderProject = posed?.project ?? result.project;
        const { HydeRenderHost } = await import('../browserHost');
        if (generation !== workGeneration.current) return;
        const host = await HydeRenderHost.connect(() => renderProject);
        try {
          const frame = await host.renderFrame({ timeSeconds: 0, width: renderProject.width, height: renderProject.height, signal: renderAbort.signal });
          if (generation !== workGeneration.current) return;
          const url = URL.createObjectURL(new Blob([frame.bytes as BlobPart], { type: frame.mime }));
          previewUrlRef.current = url;
          setPreviewUrl(url);
          setPosePreview(Boolean(posed));
          if (posed) setStatus(`Temporary Hyde joint pose ready at ${posed.appliedValue.toFixed(1)} ${renderProject.elements.find(item => item.id === result.mapping.partIds[pose!.partId])?.attachment?.type === 'hinge' ? 'degrees' : 'pixels'}. No motion or pose was saved.`);
          else try {
            const comparison = await client.current.call<{ report: NativeQualityReport; overlayPng: Uint8Array }>('native.compare', { renderedPng: frame.bytes });
            if (generation !== workGeneration.current) return;
            const overlayUrl = URL.createObjectURL(new Blob([comparison.overlayPng as BlobPart], { type: 'image/png' }));
            residualUrlRef.current = overlayUrl;
            setResidualUrl(overlayUrl);
            setNativeQuality(comparison.report);
            setStatus(`Native Hyde preview and measured pixel comparison ready. ${result.warnings.length} export warning${result.warnings.length === 1 ? '' : 's'}.`);
          } catch (error) {
            if (generation === workGeneration.current) setStatus(`Native Hyde preview rendered, but pixel comparison failed: ${error instanceof Error ? error.message : 'unknown error'}`);
          }
        } finally { host.close(); }
      } else {
        download(result.bytes, replacement ? replacement.name : `${documentModel.name}.${exportFormat}`, 'application/zip');
        setStatus(replacement ? `Replacement .hyproj downloaded for ${replacement.name}; the selected source file remains available for recovery. ${result.warnings.map(item => item.message).join(' ')}`
          : `Editable .${exportFormat} exported through Hyde SDK. ${result.warnings.map(item => item.message).join(' ')}`);
        if (replacement) setAssemblyReview(undefined);
      }
    } catch (error) { if (generation === workGeneration.current) setStatus(error instanceof Error ? error.message : 'Native export failed.'); }
    finally { if (activeRenderAbort.current === renderAbort) activeRenderAbort.current = undefined; if (generation === workGeneration.current) { setCancellable(false); setBusy(false); } }
  }
  async function planRegeneration(label: string, request: RegenerationRequest) {
    if (!documentModel || busy || pendingRegeneration) return;
    const generation = workGeneration.current;
    setBusy(true); setCancellable(true); setCoarsePreview(undefined); setStatus(`Preparing ${label.toLowerCase()} impact preview…`);
    try {
      checkpoint.current = (await client.current.call<{ bytes: Uint8Array }>('save')).bytes;
      if (generation !== workGeneration.current) return;
      const impact = await client.current.call<RegenerationImpact>('regeneration.preview', { ...request, expectedRevision: revision }, (progress: CoarsePreview) => {
        if (progress.kind !== 'coarse-preview' || generation !== workGeneration.current) return;
        setCoarsePreview(progress);
        setStatus(`Coarse ${progress.scale}× settings preview ready; calculating full-resolution impact…`);
      });
      if (generation !== workGeneration.current) return;
      setCoarsePreview(undefined);
      setPendingRegeneration({ label, request, impact });
      setStatus(`Review ${label.toLowerCase()}: ${impact.changedUnlockedIds.length} unlocked changed, ${impact.removedUnlockedIds.length} removed, ${impact.addedIds.length} added. Current document is unchanged.`);
    } catch (error) { if (generation === workGeneration.current) setStatus(error instanceof Error ? error.message : 'Regeneration preview failed.'); }
    finally { if (generation === workGeneration.current) { setCoarsePreview(undefined); setRequestedMode(undefined); setRequestedInference(undefined); setCancellable(false); setBusy(false); } }
  }
  async function applyPlannedRegeneration() {
    if (!pendingRegeneration || busy) return;
    const generation = workGeneration.current;
    const { request, impact, label } = pendingRegeneration;
    if (impact.changedProtectedIds.length || impact.removedProtectedIds.length) return;
    setBusy(true); setCancellable(true); setStatus(`Applying ${label.toLowerCase()}…`);
    try {
      let state: WorkerState;
      if (request.kind === 'analysis') state = await client.current.call<WorkerState>('analyze', {
        mode: request.mode, settings: request.settings, expectedRevision: impact.baseRevision,
      });
      else {
        const response = await client.current.call<WorkerState & { result: { ok: boolean; error?: { message: string } } }>('execute', {
          expectedRevision: impact.baseRevision, edits: [{ op: 'regenerate.selected', regionIds: request.regionIds, settings: request.settings }],
        });
        if (!response.result.ok) throw new Error(response.result.error?.message ?? 'Selected regeneration failed.');
        state = response;
      }
      if (generation !== workGeneration.current) return;
      await refresh(state);
      if (generation !== workGeneration.current) return;
      checkpoint.current = (await client.current.call<{ bytes: Uint8Array }>('save')).bytes;
      if (generation !== workGeneration.current) return;
      setStatus(`${label} applied in revision ${state.revision}; ${state.document.regions.filter(active).length} regions active.`);
    } catch (error) { if (generation === workGeneration.current) setStatus(error instanceof Error ? error.message : 'Regeneration failed.'); }
    finally { if (generation === workGeneration.current) { setCancellable(false); setBusy(false); } }
  }
  async function setHiddenContinuations(enabled: boolean) {
    if (!documentModel || busy || pendingRegeneration || documentModel.mode !== 'animation-ready') return;
    setRequestedInference(enabled);
    await planRegeneration(enabled ? 'Enable hidden continuations' : 'Disable hidden continuations', {
      kind: 'analysis', settings: { ...(draftSettings ?? documentModel.settings), inferHiddenGeometry: enabled },
    });
  }
  async function cancelWork() {
    if (!busy || !cancellable || restoring) return;
    setRestoring(true);
    workGeneration.current++;
    activeRenderAbort.current?.abort();
    client.current.restart();
    setCoarsePreview(undefined); setStatus('Canceled. Restoring the last complete document checkpoint…');
    try {
      if (checkpoint.current) await refresh(await client.current.call<WorkerState>('open', { bytes: checkpoint.current }), true);
      else {
        setDocumentModel(undefined); setSelectedSourceId(undefined); setSelectedRegionId(undefined); setSelectedPartId(undefined);
        sourceImage.current = undefined; sourcePixelsRef.current = undefined; setMasks(new Map());
        if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
        sourceUrl.current = undefined;
      }
      setStatus('Canceled. The last complete document has been restored.');
    }
    catch (error) { setStatus(error instanceof Error ? error.message : 'Could not restore checkpoint.'); }
    finally { setRestoring(false); setCancellable(false); setBusy(false); }
  }
  async function undoRedo(direction: 'undo' | 'redo') {
    if (!documentModel || busy) return;
    try {
      const response = await client.current.call<WorkerState & { changed: boolean }>(direction, { expectedRevision: revision });
      if (response.changed) { await refresh(response); setStatus(`${direction === 'undo' ? 'Undo' : 'Redo'} applied.`); }
      else setStatus(`Nothing to ${direction}.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : `${direction} failed.`); }
  }

  useEffect(() => {
    if (!source || !sourceImage.current) return;
    const image = sourceImage.current, rgba = sourcePixelsRef.current;
    if (!rgba) return;
    const displayScale = displayScaleFor(source.width, source.height, zoom);
    const fullWindow: CanvasTile = { x: 0, y: 0, width: source.width, height: source.height };
    const originalWindow = tiled && originalTile ? originalTile : fullWindow;
    const reconstructionWindow = tiled && reconstructionTile ? reconstructionTile : fullWindow;
    const displayWidth = Math.ceil(reconstructionWindow.width / displayScale), displayHeight = Math.ceil(reconstructionWindow.height / displayScale);
    const drawOriginal = (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return; canvas.width = Math.ceil(originalWindow.width / displayScale); canvas.height = Math.ceil(originalWindow.height / displayScale);
      const ctx = canvas.getContext('2d'); if (!ctx) return;
      ctx.setTransform(1 / displayScale, 0, 0, 1 / displayScale, -originalWindow.x / displayScale, -originalWindow.y / displayScale);
      ctx.clearRect(0, 0, source.width, source.height); ctx.drawImage(image, 0, 0, source.width, source.height);
      const landmarks = documentModel?.correspondences.filter(item => item.kind === 'landmark' && item.landmarkPoints);
      for (const item of landmarks ?? []) {
        const index = item.sourceIds.indexOf(source.id);
        if (index < 0) continue;
        const point = item.landmarkPoints![index];
        ctx.strokeStyle = '#ffcd70'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(point.x - 3, point.y); ctx.lineTo(point.x + 3, point.y);
        ctx.moveTo(point.x, point.y - 3); ctx.lineTo(point.x, point.y + 3); ctx.stroke();
      }
      if (pendingLandmark?.sourceId === source.id) {
        ctx.strokeStyle = '#20ead1'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(pendingLandmark.x, pendingLandmark.y, 3, 0, Math.PI * 2); ctx.stroke();
      }
      for (const item of pendingRegeneration?.impact.previewContours ?? []) if (item.sourceId === source.id) drawRegenerationContour(ctx, item);
    };
    drawOriginal(originalCanvas.current);
    const canvas = reconstructionCanvas.current; if (!canvas) return;
    canvas.width = displayWidth; canvas.height = displayHeight;
    const context = canvas.getContext('2d'); if (!context) return;
    // Keep a few bounded base tiles so backscroll and overlay changes avoid rewalking every region mask.
    const isolateId = isolate ? selectedRegionId : undefined;
    let cache = reconstructionRaster.current;
    if (!cache || cache.document !== documentModel || cache.masks !== masks || cache.pixels !== rgba || cache.sourceId !== source.id ||
      cache.scale !== displayScale || cache.isolateId !== isolateId) {
      cache = { document: documentModel, masks, pixels: rgba, sourceId: source.id, scale: displayScale, isolateId, tiles: [] };
      reconstructionRaster.current = cache;
    }
    const cachedIndex = cache.tiles.findIndex(entry => entry.tile.x === reconstructionWindow.x && entry.tile.y === reconstructionWindow.y &&
      entry.tile.width === reconstructionWindow.width && entry.tile.height === reconstructionWindow.height);
    const cached = cachedIndex >= 0;
    const imageData = cached ? cache.tiles[cachedIndex].image : context.createImageData(displayWidth, displayHeight);
    if (cached && cachedIndex !== cache.tiles.length - 1) cache.tiles.push(cache.tiles.splice(cachedIndex, 1)[0]);
    if (!cached) {
      const ordered = [...visibleRegions].sort((a, b) => (documentModel?.parts.find(part => part.id === a.partId)?.zOrder ?? 0) - (documentModel?.parts.find(part => part.id === b.partId)?.zOrder ?? 0));
      for (const region of ordered) {
      if (region.geometry.status === 'inferred') continue;
      if (isolate && selectedRegionId && region.id !== selectedRegionId) continue;
      const mask = masks.get(region.id); if (!mask) continue;
      const rgb = color(region.color);
      for (let row = Math.max(Math.floor(region.bounds.y / displayScale), Math.floor(reconstructionWindow.y / displayScale)); row < Math.min(Math.ceil((region.bounds.y + region.bounds.height) / displayScale), Math.ceil((reconstructionWindow.y + reconstructionWindow.height) / displayScale)); row++)
        for (let column = Math.max(Math.floor(region.bounds.x / displayScale), Math.floor(reconstructionWindow.x / displayScale)); column < Math.min(Math.ceil((region.bounds.x + region.bounds.width) / displayScale), Math.ceil((reconstructionWindow.x + reconstructionWindow.width) / displayScale)); column++) {
          const left = column * displayScale, top = row * displayScale;
          const right = Math.min(source.width, left + displayScale), bottom = Math.min(source.height, top + displayScale);
          if (displayScale === 1) {
            const x = left - region.bounds.x, y = top - region.bounds.y;
            if (x < 0 || y < 0 || x >= mask.width || y >= mask.height || !mask.bytes[y * mask.width + x]) continue;
            const index = ((row - reconstructionWindow.y) * displayWidth + column - reconstructionWindow.x) * 4, sourceIndex = (top * source.width + left) * 4;
            const incoming = ((rgba[sourceIndex + 3] || 255) * (mask.alpha?.[y * mask.width + x] ?? 255)) / (255 * 255);
            if (!incoming) continue;
            const previous = imageData.data[index + 3] / 255, combined = incoming + previous * (1 - incoming);
            const colorSource = region.geometry.texture === 'source-crop' ? rgba : rgb;
            const offset = region.geometry.texture === 'source-crop' ? sourceIndex : 0;
            for (let channel = 0; channel < 3; channel++)
              imageData.data[index + channel] = Math.round((colorSource[offset + channel] * incoming +
                imageData.data[index + channel] * previous * (1 - incoming)) / combined);
            imageData.data[index + 3] = Math.round(combined * 255);
            continue;
          }
          let alpha = 0, red = 0, green = 0, blue = 0;
          for (let sy = Math.max(top, region.bounds.y); sy < Math.min(bottom, region.bounds.y + mask.height); sy++)
            for (let sx = Math.max(left, region.bounds.x); sx < Math.min(right, region.bounds.x + mask.width); sx++) {
              const local = (sy - region.bounds.y) * mask.width + sx - region.bounds.x;
              if (!mask.bytes[local]) continue;
              const at = (sy * source.width + sx) * 4;
              const coverage = (rgba[at + 3] || 255) * (mask.alpha?.[local] ?? 255) / 255;
              const sourceColor = region.geometry.texture === 'source-crop';
              alpha += coverage;
              red += (sourceColor ? rgba[at] : rgb[0]) * coverage;
              green += (sourceColor ? rgba[at + 1] : rgb[1]) * coverage;
              blue += (sourceColor ? rgba[at + 2] : rgb[2]) * coverage;
            }
          if (!alpha) continue;
          const area = (right - left) * (bottom - top), index = ((row - reconstructionWindow.y / displayScale) * displayWidth + column - reconstructionWindow.x / displayScale) * 4;
          const incoming = alpha / (area * 255), previous = imageData.data[index + 3] / 255;
          const combined = incoming + previous * (1 - incoming);
          imageData.data[index] = Math.round((red / (area * 255) + imageData.data[index] * previous * (1 - incoming)) / combined);
          imageData.data[index + 1] = Math.round((green / (area * 255) + imageData.data[index + 1] * previous * (1 - incoming)) / combined);
          imageData.data[index + 2] = Math.round((blue / (area * 255) + imageData.data[index + 2] * previous * (1 - incoming)) / combined);
          imageData.data[index + 3] = Math.round(combined * 255);
      }
      }
      cache.tiles.push({ tile: reconstructionWindow, image: imageData });
      if (cache.tiles.length > 3) cache.tiles.shift();
    }
    context.putImageData(imageData, 0, 0);
    context.setTransform(1 / displayScale, 0, 0, 1 / displayScale, -reconstructionWindow.x / displayScale, -reconstructionWindow.y / displayScale);
    if (view === 'overlay') { context.globalAlpha = overlayAlpha; context.drawImage(image, 0, 0, source.width, source.height); context.globalAlpha = 1; }
    if (showInferred) for (const region of inferredRegions) {
      if (isolate && selectedRegionId && region.id !== selectedRegionId) continue;
      const path = region.geometry.manualPath ?? region.geometry.generatedPath;
      if (path.points.length < 3) continue;
      context.save(); context.beginPath();
      context.moveTo(region.bounds.x + path.points[0].x * region.bounds.width, region.bounds.y + path.points[0].y * region.bounds.height);
      for (let index = 0; index < path.points.length; index++) {
        const from = path.points[index], to = path.points[(index + 1) % path.points.length];
        const x = region.bounds.x + to.x * region.bounds.width, y = region.bounds.y + to.y * region.bounds.height;
        if (from.out || to.in) {
          const a = from.out ?? from, b = to.in ?? to;
          context.bezierCurveTo(region.bounds.x + a.x * region.bounds.width, region.bounds.y + a.y * region.bounds.height,
            region.bounds.x + b.x * region.bounds.width, region.bounds.y + b.y * region.bounds.height, x, y);
        } else context.lineTo(x, y);
      }
      context.closePath(); context.fillStyle = '#ffcb7044'; context.fill();
      context.lineWidth = .75; context.strokeStyle = '#ffcb70'; context.setLineDash([2, 2]); context.stroke(); context.restore();
    }
    if (selectedRegion?.sourceId === source.id) {
      const path = structuredClone(selectedRegion.geometry.manualPath ?? selectedRegion.geometry.generatedPath);
      if (draftPoint && selectedPoint !== undefined && path.points[selectedPoint]) {
        const anchor = path.points[selectedPoint], dx = draftPoint.x - anchor.x, dy = draftPoint.y - anchor.y;
        anchor.x = draftPoint.x; anchor.y = draftPoint.y;
        if (anchor.in) { anchor.in.x += dx; anchor.in.y += dy; }
        if (anchor.out) { anchor.out.x += dx; anchor.out.y += dy; }
      }
      if (draftHandle && selectedPoint !== undefined && path.points[selectedPoint]) path.points[selectedPoint][draftHandle.side] = { x: draftHandle.x, y: draftHandle.y };
      drawPath(context, selectedRegion, path, selectedPoint);
    }
    if (selectedPart && tool === 'pivot') {
      context.save(); context.strokeStyle = '#ffcf67'; context.lineWidth = 2;
      context.beginPath(); context.moveTo(selectedPart.pivot.x - 7, selectedPart.pivot.y); context.lineTo(selectedPart.pivot.x + 7, selectedPart.pivot.y);
      context.moveTo(selectedPart.pivot.x, selectedPart.pivot.y - 7); context.lineTo(selectedPart.pivot.x, selectedPart.pivot.y + 7); context.stroke(); context.restore();
    }
    for (const item of pendingRegeneration?.impact.previewContours ?? []) if (item.sourceId === source.id) drawRegenerationContour(context, item);
    for (const item of coarsePreview?.contours ?? []) if (item.sourceId === source.id) drawRegenerationContour(context, item);
    if (pointer.current?.tool.startsWith('paint')) {
      context.save(); context.strokeStyle = pointer.current.tool === 'paint-add' ? '#06f0aa' : '#ff6378'; context.lineWidth = Math.max(1, brushRadius * 2); context.lineCap = 'round';
      context.beginPath(); pointer.current.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)); context.stroke(); context.restore();
    }
  }, [source?.id, source?.width, source?.height, zoom, tiled, originalTile?.x, originalTile?.y, originalTile?.width, originalTile?.height, reconstructionTile?.x, reconstructionTile?.y, reconstructionTile?.width, reconstructionTile?.height, visibleRegions, inferredRegions, documentModel?.parts, documentModel?.correspondences, masks, selectedRegion, selectedRegionId, selectedPart, view, overlayAlpha, isolate, showInferred, selectedPoint, draftPoint, draftHandle, pendingLandmark, pendingRegeneration, coarsePreview, tool, brushRadius, renderVersion]);

  const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!source) return { x: 0, y: 0 };
    const rect = event.currentTarget.getBoundingClientRect();
    const tileX = Number(event.currentTarget.dataset.tileX ?? 0), tileY = Number(event.currentTarget.dataset.tileY ?? 0);
    const tileWidth = Number(event.currentTarget.dataset.tileWidth ?? source.width), tileHeight = Number(event.currentTarget.dataset.tileHeight ?? source.height);
    return { x: Math.max(0, Math.min(source.width, tileX + (event.clientX - rect.left) / rect.width * tileWidth)),
      y: Math.max(0, Math.min(source.height, tileY + (event.clientY - rect.top) / rect.height * tileHeight)) };
  };
  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!documentModel || busy || !source) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    if (tool === 'landmark') {
      const picked = { sourceId: source.id, x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 };
      if (!pendingLandmark || pendingLandmark.sourceId === source.id) {
        setPendingLandmark(picked);
        setStatus('Landmark selected. Choose the matching point in another reference.');
      } else {
        setPendingLandmark(undefined);
        void perform([{ op: 'reference.correspond', correspondence: {
          id: `manual_landmark_${revision + 1}`, sourceIds: [pendingLandmark.sourceId, source.id],
          landmarkPoints: [{ x: pendingLandmark.x, y: pendingLandmark.y }, { x: picked.x, y: picked.y }],
          kind: 'landmark', origin: 'manual', evidence: ['user-selected source pixels'], accepted: true,
        } }]);
      }
    } else if (tool === 'background') {
      const pixels = sourcePixelsRef.current;
      if (!pixels) return;
      const x = Math.min(source.width - 1, Math.floor(point.x)), y = Math.min(source.height - 1, Math.floor(point.y));
      const at = (y * source.width + x) * 4;
      const sampled = `#${[pixels[at], pixels[at + 1], pixels[at + 2]].map(value => value.toString(16).padStart(2, '0')).join('')}`;
      void perform([{ op: 'reference.setBackground', sourceId: source.id, color: sampled }]);
    } else if (tool === 'select') {
      const hit = [...visibleRegions].reverse().find(region => {
        const mask = masks.get(region.id), x = Math.floor(point.x - region.bounds.x), y = Math.floor(point.y - region.bounds.y);
        return mask && x >= 0 && y >= 0 && x < mask.width && y < mask.height && mask.bytes[y * mask.width + x];
      });
      setSelectedRegionId(hit?.id); setSelectedPartId(hit?.partId); setSelectedPoint(undefined);
    } else if (tool === 'pivot' && selectedPart) {
      void perform([{ op: 'part.setPivot', partId: selectedPart.id, x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 }]);
    } else if (tool === 'path' && selectedRegion) {
      const path = selectedRegion.geometry.manualPath ?? selectedRegion.geometry.generatedPath;
      const selected = selectedPoint === undefined ? undefined : path.points[selectedPoint];
      if (selected) {
        const handle = (['in', 'out'] as const).map(side => ({ side, position: selected[side] })).filter(item => item.position)
          .map(item => ({ side: item.side, distance: Math.hypot(selectedRegion.bounds.x + item.position!.x * selectedRegion.bounds.width - point.x, selectedRegion.bounds.y + item.position!.y * selectedRegion.bounds.height - point.y) }))
          .sort((a, b) => a.distance - b.distance)[0];
        if (handle && handle.distance < Math.max(2, source.width / 150)) { pointer.current = { tool, points: [point], anchor: selectedPoint, side: handle.side }; return; }
      }
      const nearest = path.points.map((anchor, index) => ({ index, distance: Math.hypot(selectedRegion.bounds.x + anchor.x * selectedRegion.bounds.width - point.x, selectedRegion.bounds.y + anchor.y * selectedRegion.bounds.height - point.y) }))
        .sort((a, b) => a.distance - b.distance)[0];
      if (nearest && nearest.distance < Math.max(5, source.width / 100)) { setSelectedPoint(nearest.index); pointer.current = { tool, points: [point], anchor: nearest.index }; }
    } else if ((tool === 'paint-add' || tool === 'paint-erase') && selectedRegion) {
      pointer.current = { tool, points: [point] }; setRenderVersion(value => value + 1);
    } else if ((tool === 'seed-add' || tool === 'seed-erase') && selectedRegion) {
      void perform([{ op: 'region.seedMask', regionId: selectedRegion.id, x: Math.floor(point.x), y: Math.floor(point.y), action: tool === 'seed-add' ? 'add' : 'subtract', colorTolerance: seedTolerance, radius: seedRadius }]);
    }
  }
  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!pointer.current || !source) return;
    const point = pointFromEvent(event);
    pointer.current.points.push(point);
    if (pointer.current.tool === 'path' && selectedRegion) {
      const candidate = edgeSnap && !pointer.current.side && sourcePixelsRef.current
        ? snapToSourceEdge(point, sourcePixelsRef.current, source.width, source.height, edgeSnapRadius) : point;
      const normalized = { x: (candidate.x - selectedRegion.bounds.x) / selectedRegion.bounds.width, y: (candidate.y - selectedRegion.bounds.y) / selectedRegion.bounds.height };
      if (pointer.current.side) setDraftHandle({ side: pointer.current.side, ...normalized });
      else setDraftPoint(normalized);
    } else setRenderVersion(value => value + 1);
  }
  function onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    const stroke = pointer.current; pointer.current = undefined;
    if (!stroke || !selectedRegion) return;
    const point = pointFromEvent(event);
    if (stroke.tool === 'path' && stroke.anchor !== undefined) {
      const path = structuredClone(selectedRegion.geometry.manualPath ?? selectedRegion.geometry.generatedPath);
      const anchor = path.points[stroke.anchor];
      if (anchor) {
        const snapped = edgeSnap && !stroke.side && sourcePixelsRef.current && source
          ? snapToSourceEdge(point, sourcePixelsRef.current, source.width, source.height, edgeSnapRadius) : point;
        const x = (snapped.x - selectedRegion.bounds.x) / selectedRegion.bounds.width, y = (snapped.y - selectedRegion.bounds.y) / selectedRegion.bounds.height;
        if (stroke.side) anchor[stroke.side] = { x, y };
        else {
          const dx = x - anchor.x, dy = y - anchor.y;
          anchor.x = x; anchor.y = y;
          if (anchor.in) { anchor.in.x += dx; anchor.in.y += dy; }
          if (anchor.out) { anchor.out.x += dx; anchor.out.y += dy; }
        }
        void perform([{ op: 'region.setPath', regionId: selectedRegion.id, path }]);
      }
      setDraftPoint(undefined); setDraftHandle(undefined);
    } else if (stroke.tool === 'paint-add' || stroke.tool === 'paint-erase') {
      const old = masks.get(selectedRegion.id); if (!old) return;
      const points = [...stroke.points, point];
      if (stroke.tool === 'paint-add' && selectedRegion.geometry.manualPath && points.some(item =>
        item.x - brushRadius < selectedRegion.bounds.x || item.y - brushRadius < selectedRegion.bounds.y ||
        item.x + brushRadius > selectedRegion.bounds.x + selectedRegion.bounds.width ||
        item.y + brushRadius > selectedRegion.bounds.y + selectedRegion.bounds.height)) {
        setStatus('Unlock the manual contour and use its generated path before brushing beyond this region.');
        setRenderVersion(value => value + 1); return;
      }
      const copy: RegionMask = { width: old.width, height: old.height, bytes: Uint8Array.from(old.bytes), ...(old.alpha ? { alpha: Uint8Array.from(old.alpha) } : {}) };
      const { mask, bounds } = stroke.tool === 'paint-add' && source && !selectedRegion.geometry.manualPath
        ? expandBrushMask(copy, selectedRegion.bounds, points, brushRadius, source.width, source.height)
        : { mask: copy, bounds: selectedRegion.bounds };
      for (let index = 0; index < points.length; index++) {
        const from = points[Math.max(0, index - 1)], to = points[index];
        const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(1, brushRadius / 2)));
        for (let step = 0; step <= steps; step++) paintDisc(mask, bounds, from.x + (to.x - from.x) * step / steps, from.y + (to.y - from.y) * step / steps, brushRadius, stroke.tool === 'paint-add' ? 1 : 0, brushHardness);
      }
      void perform([{ op: 'region.refineMask', regionId: selectedRegion.id, handle: 'worker', ...(bounds === selectedRegion.bounds ? {} : { bounds }) }], mask);
    }
    setRenderVersion(value => value + 1);
  }

  const primaryRegions = documentModel?.regions.filter(region => active(region) && region.sourceId === documentModel.sources.find(source => source.role === 'primary')?.id) ?? [];
  const alternateRegions = documentModel?.regions.filter(region => active(region) && region.sourceId !== documentModel.sources.find(source => source.role === 'primary')?.id) ?? [];
  return <div className="decomposer-app">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">i<span>•</span></span><div><strong>Hyde Image Decomposer</strong><small>Local, deterministic, editable art</small></div></div>
      <div className="toolbar">
        <a className="button" href={import.meta.env.DEV?'./':'../'}>← Story Studio</a>
        <label className="button accent" data-tour="import" data-help="references" aria-description={CONTROL_HELP.references}>Import images<input aria-label="Import images" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={importImages}/></label>
        <label className="button" data-help="save" aria-description={CONTROL_HELP.save}>Open .hydecomp<input aria-label="Open .hydecomp" type="file" accept=".hydecomp,application/zip" hidden onChange={openDocument}/></label>
        <button data-help="save" aria-description={CONTROL_HELP.save} disabled={!documentModel || busy} onClick={saveDocument}>Save source</button>
        <button disabled={!documentModel || busy} onClick={() => void undoRedo('undo')}>Undo</button>
        <button disabled={!documentModel || busy} onClick={() => void undoRedo('redo')}>Redo</button>
        <button type="button" className="help-open-button" onClick={()=>setHelpOpen(true)}>Help</button>
      </div>
    </header>
    <div className="workspace">
      <aside className="left-pane pane">
        <h2>References <HelpHint id="references" label="references"/></h2>
        {documentModel ? <div className="stack">{documentModel.sources.map(item => <button key={item.id} className={source?.id === item.id ? 'row selected' : 'row'} onClick={async () => { setSelectedSourceId(item.id); setSelectedRegionId(undefined); setSelectedPartId(undefined); await readSource(item.id, documentModel); const response = await client.current.call<{ id: string; mask: RegionMask }[]>('masks', { sourceId: item.id }); setMasks(new Map(response.map(entry => [entry.id, entry.mask]))); }}><span>{item.name}</span><small>{item.role} · {item.width} × {item.height}</small></button>)}</div> : <p className="hint">PNG, JPEG and WebP. Select multiple files to compare views.</p>}
        {pendingLandmark && <div className="reference-guide"><span>Pending landmark on {documentModel?.sources.find(item => item.id === pendingLandmark.sourceId)?.name} at {pendingLandmark.x}, {pendingLandmark.y}</span><button onClick={() => setPendingLandmark(undefined)}>Cancel point</button></div>}
        {documentModel?.correspondences.some(item => item.kind === 'landmark') && <div className="reference-guide"><strong>Paired landmarks</strong>{documentModel.correspondences.filter(item => item.kind === 'landmark' && item.landmarkPoints).map(item => <small key={item.id}>{item.sourceIds.map((id, index) => `${documentModel.sources.find(source => source.id === id)?.name ?? id} (${item.landmarkPoints![index].x.toFixed(1)}, ${item.landmarkPoints![index].y.toFixed(1)})`).join(' ↔ ')}</small>)}</div>}
        {source && source.role !== 'primary' && <div className="reference-guide"><strong>Alignment to primary</strong><small>Optional affine mapping of this source into primary pixels. Use only where one transform describes both images.</small><button disabled={!alignmentLandmarkIds.length || busy} onClick={() => void perform([{ op: 'reference.alignFromLandmarks', sourceId: source.id, landmarkIds: alignmentLandmarkIds }])}>Align from paired landmarks</button><div className="affine-grid">{(['a', 'b', 'c', 'd', 'tx', 'ty'] as const).map((name, index) => <label key={`${source.id}-${name}`}>{name}<input aria-label={`Alignment ${name}`} type="number" step="0.01" key={`${source.id}-${name}-${source.transformToPrimary?.[index] ?? ''}`} defaultValue={(source.transformToPrimary ?? [1, 0, 0, 1, 0, 0])[index]} onBlur={event => { const value = Number(event.target.value); if (!Number.isFinite(value)) return; const next = [...(source.transformToPrimary ?? [1, 0, 0, 1, 0, 0])] as [number, number, number, number, number, number]; if (next[index] === value) return; next[index] = value; void perform([{ op: 'reference.setTransform', sourceId: source.id, transformToPrimary: next }]); }}/></label>)}</div><small>x′ = ax + cy + tx; y′ = bx + dy + ty</small><button disabled={!source.transformToPrimary || busy} onClick={() => void perform([{ op: 'reference.setTransform', sourceId: source.id }])}>Clear alignment</button></div>}
        {source && <div className="reference-guide" aria-label="Opaque background correction"><strong>Opaque background</strong><small>{source.backgroundColor === undefined ? 'Automatic border estimate' : source.backgroundColor === null ? 'All opaque pixels kept' : `Chosen border color ${source.backgroundColor}`}. Transparent pixels continue to follow source alpha.</small><small>Choose “Mark background color” and click a border pixel in either canvas, or keep every opaque pixel. Then preview regeneration before applying the new segmentation.</small><button disabled={busy || source.backgroundColor === null} onClick={() => void perform([{ op: 'reference.setBackground', sourceId: source.id, color: null }])}>Keep all opaque pixels</button><button disabled={busy || source.backgroundColor === undefined} onClick={() => void perform([{ op: 'reference.setBackground', sourceId: source.id }])}>Use automatic background</button><button disabled={busy || Boolean(pendingRegeneration)} onClick={() => void planRegeneration('Apply background correction', { kind: 'analysis' })}>Preview background impact</button></div>}
        <div className="divider"/><h2 data-tour="regions">Regions <HelpHint id="regions" label="regions"/></h2>
        <div className="scroll-list">{visibleRegions.map(region => { const impact = pendingRegeneration?.impact; const risk = impact?.removedUnlockedIds.includes(region.id) ? 'Will be removed' : impact?.changedUnlockedIds.includes(region.id) ? 'Will change' : undefined; return <button key={region.id} className={`row${selectedRegionId === region.id ? ' selected' : ''}${region.geometry.status === 'inferred' ? ' inferred-row' : ''}${risk ? ' regeneration-affected' : ''}`} onClick={() => { setSelectedRegionId(region.id); setSelectedPartId(region.partId); setSelectedPoint(undefined); }}><span><i className="swatch" style={{ background: region.geometry.status === 'inferred' ? '#ffcb70' : region.color }}/> {region.id.split('_').slice(-2).join(' ')}</span><small>{risk ? `${risk} on confirmation · ` : ''}{region.geometry.status === 'inferred' ? 'Inferred · unseen and uncertain · ' : ''}{region.pixelCount} px · {region.geometry.texture === 'source-crop' ? 'texture' : 'vector'} {region.holeCount ? `· ${region.holeCount} hole` : ''}</small></button>; })}{suppressedRegions.map(region => <button key={region.id} className={`row suppressed-row${selectedRegionId === region.id ? ' selected' : ''}`} onClick={() => { setSelectedRegionId(region.id); setSelectedPartId(region.partId); setSelectedPoint(undefined); }}><span><i className="swatch" style={{ background: '#876c45' }}/> {region.id.split('_').slice(-2).join(' ')}</span><small>Suppressed inferred region · source evidence retained</small></button>)}</div>
        <div className="divider"/><h2 data-tour="parts">Parts <HelpHint id="parts" label="parts"/></h2>
        <div className="scroll-list">{documentModel?.parts.filter(part => part.regionIds.some(id => documentModel.regions.some(region => region.id === id && active(region) && region.sourceId === source?.id))).map(part => <button key={part.id} className={selectedPart?.id === part.id ? 'row selected' : 'row'} onClick={() => { setSelectedPartId(part.id); setSelectedRegionId(part.regionIds.find(id => visibleRegions.some(region => region.id === id))); }}><span>{part.name}</span><small>{part.regionIds.length} region{part.regionIds.length === 1 ? '' : 's'} · pivot {part.pivot.x.toFixed(1)}, {part.pivot.y.toFixed(1)}{part.hiddenGeometry !== 'none' ? ` · ${part.hiddenGeometry} hidden area` : ''}{part.attachmentProposal ? ` · ${part.attachmentProposal.type} proposed` : ''}</small></button>)}</div>
      </aside>
      <main className="center-pane">
        <div className="canvas-toolbar" data-tour="views"><div className="segmented">{(['original', 'reconstruction', 'overlay', 'side-by-side'] as View[]).map(item => <button key={item} data-help={item==='side-by-side'?'sideBySide':item} aria-description={CONTROL_HELP[item==='side-by-side'?'sideBySide':item]} aria-pressed={view === item} onClick={() => setView(item)}>{item === 'side-by-side' ? 'Side by side' : item[0].toUpperCase() + item.slice(1)}</button>)}</div><label>Zoom<select aria-label="Canvas zoom" value={String(zoom)} onChange={event => setZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))}><option value="fit">Fit</option><option value="1">1× pixels</option><option value="2">2× pixels</option><option value="4">4× pixels</option><option value="8">8× pixels</option></select></label><label>Tool <select aria-label="Canvas tool" data-help={TOOL_HELP_KEYS[tool]} aria-description={CONTROL_HELP[TOOL_HELP_KEYS[tool]]} value={tool} onChange={event => setTool(event.target.value as Tool)}><option value="select">Select</option><option value="path">Edit path and handles</option><option value="paint-add">Add mask brush</option><option value="paint-erase">Subtract mask brush</option><option value="seed-add">Foreground seed</option><option value="seed-erase">Background seed</option><option value="landmark">Pair reference landmark</option><option value="background">Mark background color</option><option value="pivot">Set pivot</option></select></label><HelpHint id={TOOL_HELP_KEYS[tool]} label="tool choice"/><label><input type="checkbox" checked={isolate} onChange={event => setIsolate(event.target.checked)}/> Isolate</label></div>
        {source && source.role !== 'primary' && <section className="reference-comparison" aria-label="Compare references"><strong>Compare the two stills</strong><p>The primary image defines the editable Hyde construction pose. This additional view supplies evidence for a same-part match, front/back order and possible hidden contours. Confirm matches yourself; alignment maps coordinates only when one transform fits both images. No motion is generated.</p><div className="reference-comparison-images"><figure><figcaption>Primary construction pose · {primarySource?.name}</figcaption>{primaryComparisonUrl && <img alt="Primary construction pose" src={primaryComparisonUrl}/>}</figure><figure><figcaption>Additional reference · {source.name}</figcaption>{loadedSourceId === source.id && sourceUrl.current && <img alt="Additional reference" src={sourceUrl.current}/>}</figure></div></section>}
        {coarsePreview && <div className="coarse-preview-banner" role="note">Provisional {coarsePreview.scale}× pyramid preview · {coarsePreview.regionCount} candidate regions · {coarsePreview.contours.length} outlines shown{coarsePreview.omitted ? `, ${coarsePreview.omitted} omitted` : ''}. Full-resolution masks and editable paths are still processing.</div>}
        {(tool === 'path' || tool.startsWith('paint') || tool.startsWith('seed') || view === 'overlay' || inferredRegions.length > 0) && <div className="canvas-subbar">
          {tool.startsWith('paint') && <><label>Brush radius <input aria-label="Brush radius" data-help="brush" aria-description={CONTROL_HELP.brush} type="range" min="1" max="40" value={brushRadius} onChange={event => setBrushRadius(Number(event.target.value))}/>{brushRadius}px</label><label>Brush hardness <input aria-label="Brush hardness" data-help="brush" aria-description={CONTROL_HELP.brush} type="range" min="0.1" max="1" step="0.1" value={brushHardness} onChange={event => setBrushHardness(Number(event.target.value))}/>{Math.round(brushHardness * 100)}%</label></>}
          {tool.startsWith('seed') && <><label>Seed tolerance <input aria-label="Seed tolerance" data-help="seed" aria-description={CONTROL_HELP.seed} type="range" min="0" max="255" value={seedTolerance} onChange={event => setSeedTolerance(Number(event.target.value))}/>{seedTolerance}</label><label>Seed reach <input aria-label="Seed reach" data-help="seed" aria-description={CONTROL_HELP.seed} type="range" min="1" max="256" value={seedRadius} onChange={event => setSeedRadius(Number(event.target.value))}/>{seedRadius}px</label></>}
          {tool === 'path' && <><label><input aria-label="Snap path to source edges" data-help="snap" aria-description={CONTROL_HELP.snap} type="checkbox" checked={edgeSnap} onChange={event => setEdgeSnap(event.target.checked)}/> Snap anchors to source edges</label>{edgeSnap && <label>Snap reach <input aria-label="Snap reach" data-help="snap" aria-description={CONTROL_HELP.snap} type="range" min="1" max="12" value={edgeSnapRadius} onChange={event => setEdgeSnapRadius(Number(event.target.value))}/>{edgeSnapRadius}px</label>}</>}
          {view === 'overlay' && <label>Overlay opacity <input aria-label="Overlay opacity" type="range" min="0" max="1" step="0.05" value={overlayAlpha} onChange={event => setOverlayAlpha(Number(event.target.value))}/></label>}
          {inferredRegions.length > 0 && <label><input aria-label="Show inferred overlay" type="checkbox" checked={showInferred} onChange={event => setShowInferred(event.target.checked)}/> Show {inferredRegions.length} uncertain hidden contour{inferredRegions.length === 1 ? '' : 's'} in amber</label>}
        </div>}
        <div className={`canvas-grid ${view === 'side-by-side' ? 'two' : ''}`}>{source ? <>
          {(view === 'original' || view === 'side-by-side') && <div ref={originalCardRef} className="canvas-card" onScroll={event => updateTile('original', event.currentTarget)}><div className="canvas-label">Original · {source.name}</div><div className={`canvas-plane${tiled ? '' : ' normal'}`} style={tiled && zoom !== 'fit' ? { width: source.width * zoom, height: source.height * zoom } : undefined}><canvas ref={originalCanvas} style={tiled && originalTile && zoom !== 'fit' ? { width: originalTile.width * zoom, height: originalTile.height * zoom, left: originalTile.x * zoom, top: originalTile.y * zoom } : canvasZoomStyle} data-tile-x={tiled ? originalTile?.x : undefined} data-tile-y={tiled ? originalTile?.y : undefined} data-tile-width={tiled ? originalTile?.width : undefined} data-tile-height={tiled ? originalTile?.height : undefined} className={`${zoom !== 'fit' ? 'zoomed ' : ''}${tool === 'landmark' || tool === 'background' ? 'interactive-canvas' : ''}`} onPointerDown={tool === 'landmark' || tool === 'background' ? onPointerDown : undefined}/></div></div>}
          {(view !== 'original') && <div ref={reconstructionCardRef} className="canvas-card" onScroll={event => updateTile('reconstruction', event.currentTarget)}><div className="canvas-label">{view === 'overlay' ? 'Overlay' : 'Reconstruction'} · source masks and geometry</div><div className={`canvas-plane${tiled ? '' : ' normal'}`} style={tiled && zoom !== 'fit' ? { width: source.width * zoom, height: source.height * zoom } : undefined}><canvas ref={reconstructionCanvas} style={tiled && reconstructionTile && zoom !== 'fit' ? { width: reconstructionTile.width * zoom, height: reconstructionTile.height * zoom, left: reconstructionTile.x * zoom, top: reconstructionTile.y * zoom } : canvasZoomStyle} data-tile-x={tiled ? reconstructionTile?.x : undefined} data-tile-y={tiled ? reconstructionTile?.y : undefined} data-tile-width={tiled ? reconstructionTile?.width : undefined} data-tile-height={tiled ? reconstructionTile?.height : undefined} className={`interactive-canvas${zoom !== 'fit' ? ' zoomed' : ''}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}/></div></div>}
        </> : <div className="empty-state"><div className="empty-art">◇</div><h1>Turn illustrations into editable Hyde art</h1><p>Import a stylized image to get an automatic first pass. Refine regions, inspect uncertainty, and export a native project or assembly.</p><label className="button accent">Choose images<input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={importImages}/></label></div>}</div>
        {previewUrl && <div className="native-preview">
          <div className="section-heading"><h3>{posePreview ? 'Temporary Hyde joint pose' : 'Native Hyde render · primary reference'} <HelpHint id="quality" label="render measurements"/></h3><button onClick={clearNativePreview}>Close</button></div>
          <div className="native-preview-visual"><img alt={posePreview ? 'Temporary Hyde joint pose' : 'Native Hyde render of current export'} src={previewUrl}/>{showResidual && residualUrl && <img className="residual-image" alt="Native residual overlay" src={residualUrl}/>}</div>
          {posePreview && <p className="hint">This render uses a disposable copy of the native Hyde project. The saved decomposition, exported assembly and construction pose have not changed.</p>}
          {nativeQuality && <>
            <div className="native-metrics" aria-label="Native quality metrics" data-help="quality" aria-description={CONTROL_HELP.quality}>
              <div><strong>Silhouette IoU</strong><span>{percentage(nativeQuality.silhouette.iou)}</span><small>Boundary mean {nativeQuality.boundary.meanDistancePixels === null ? 'n/a' : `${nativeQuality.boundary.meanDistancePixels.toFixed(2)} px`}</small></div>
              <div><strong>Color error</strong><span>{percentage(nativeQuality.color.meanAbsoluteSrgbChannelError)}</span><small>{nativeQuality.color.residualPixels} residual pixels</small></div>
              <div><strong>Coverage missing</strong><span>{percentage(nativeQuality.coverage.uncoveredFraction)}</span><small>{nativeQuality.coverage.uncoveredPixels} missing · {nativeQuality.coverage.excessPixels} excess px</small></div>
              <div><strong>Complexity</strong><span>{nativeQuality.complexity.activeRegionCount} regions · {nativeQuality.complexity.activePartCount} parts</span><small>{nativeQuality.complexity.pathPointCount} path anchors</small></div>
            </div>
            <label className="residual-toggle"><input aria-label="Show residual overlay" data-help="quality" aria-description={CONTROL_HELP.quality} type="checkbox" checked={showResidual} onChange={event => setShowResidual(event.target.checked)}/> Show measured residual overlay</label>
            {showResidual && <div className="residual-legend">{Object.entries(nativeQuality.overlayLegend).map(([name, swatch]) => <span key={name}><i style={{ background: swatch }}/>{name.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>)}</div>}
            <p className="hint">Pixel measurements at source resolution; judge visual quality from the rendered image.</p>
          </>}
        </div>}
        <div className="status-panel"><div className="section-heading"><h3>{busy ? 'Processing' : 'Status'}</h3>{busy && cancellable && <button disabled={restoring} onClick={() => void cancelWork()}>{restoring ? 'Restoring…' : 'Cancel and restore'}</button>}</div><p role="status">{status}</p>{quality && <p className="metric">Sampled path to mask IoU: {(quality.meanSampledMaskIoU * 100).toFixed(1)}% · {quality.pointCount} path anchors. Color and texture fidelity require the native render preview.</p>}</div>
      </main>
      <aside className="right-pane pane"><h2 data-tour="settings">Reconstruction <HelpHint id="modes" label="analysis choices"/></h2>
        {documentModel && <><label>Mode<select aria-label="Reconstruction mode" data-help="modes" aria-description={CONTROL_HELP.modes} value={pendingRegeneration?.impact.mode ?? requestedMode ?? documentModel.mode} disabled={busy || Boolean(pendingRegeneration)} onChange={event => { const mode = event.target.value as DecompositionMode; setRequestedMode(mode); void planRegeneration(`Switch to ${mode}`, { kind: 'analysis', mode }); }}><option value="appearance">Appearance first</option><option value="animation-ready">Animation ready</option></select></label>
          <label><input aria-label="Infer hidden continuations" data-help="hidden" aria-description={CONTROL_HELP.hidden} type="checkbox" checked={pendingRegeneration?.impact.settings.inferHiddenGeometry ?? requestedInference ?? documentModel.settings.inferHiddenGeometry} disabled={busy || Boolean(pendingRegeneration) || documentModel.mode !== 'animation-ready'} onChange={event => void setHiddenContinuations(event.target.checked)}/> Propose hidden continuations</label>
          <p className="hint">Animation ready only. Enclosed opaque overlaps may support a conservative unseen piece beneath a front region. The inferred shape and color remain uncertain; pinned edits survive when automatic proposals are turned off.</p>
          <label>Color granularity <input aria-label="Color granularity" data-help="color" aria-description={CONTROL_HELP.color} type="range" min="8" max="96" value={(draftSettings ?? documentModel.settings).colorStep} disabled={busy || Boolean(pendingRegeneration)} onChange={event => setDraftSettings({ ...(draftSettings ?? documentModel.settings), colorStep: Number(event.target.value) })}/><span>{(draftSettings ?? documentModel.settings).colorStep}</span></label>
          <label>Edge sensitivity <input aria-label="Edge sensitivity" data-help="edge" aria-description={CONTROL_HELP.edge} type="range" min="0.25" max="2" step="0.05" value={(draftSettings ?? documentModel.settings).edgeSensitivity ?? 1} disabled={busy || Boolean(pendingRegeneration)} onChange={event => setDraftSettings({ ...(draftSettings ?? documentModel.settings), edgeSensitivity: Number(event.target.value) })}/><span>{((draftSettings ?? documentModel.settings).edgeSensitivity ?? 1).toFixed(2)}</span></label>
          <p className="hint">Higher values retain subtler paint boundaries; lower values join more neighboring color bands. Preview changes before applying them.</p>
          <label>Minimum feature size <input aria-label="Minimum feature size" data-help="feature" aria-description={CONTROL_HELP.feature} type="range" min="1" max="64" step="1" value={(draftSettings ?? documentModel.settings).minRegionPixels} disabled={busy || Boolean(pendingRegeneration)} onChange={event => setDraftSettings({ ...(draftSettings ?? documentModel.settings), minRegionPixels: Number(event.target.value) })}/><span>{(draftSettings ?? documentModel.settings).minRegionPixels} px</span></label>
          <p className="hint">Small color islands can join adjacent paint when their area is below this size. Thin, high-contrast lines stay separate where the source supports them.</p>
          <label><input aria-label="Preserve thin lines" data-help="thin" aria-description={CONTROL_HELP.thin} type="checkbox" checked={(draftSettings ?? documentModel.settings).preserveThinLines !== false} disabled={busy || Boolean(pendingRegeneration)} onChange={event => setDraftSettings({ ...(draftSettings ?? documentModel.settings), preserveThinLines: event.target.checked })}/> Preserve thin lines during cleanup</label>
          <label>Path tolerance <input aria-label="Path tolerance" data-help="tolerance" aria-description={CONTROL_HELP.tolerance} type="range" min="0" max="8" step="0.25" value={(draftSettings ?? documentModel.settings).pathTolerance} disabled={busy || Boolean(pendingRegeneration)} onChange={event => setDraftSettings({ ...(draftSettings ?? documentModel.settings), pathTolerance: Number(event.target.value) })}/><span>{(draftSettings ?? documentModel.settings).pathTolerance}</span></label>
          {draftSettings && JSON.stringify(draftSettings) !== JSON.stringify(documentModel.settings) && <p className="hint">Settings are staged. Preview their impact before applying.</p>}
          <button data-help="regenerate" aria-description={CONTROL_HELP.regenerate} disabled={busy || Boolean(pendingRegeneration)} onClick={() => void planRegeneration('Apply settings', { kind: 'analysis', settings: draftSettings ?? documentModel.settings })}>Preview settings impact</button>
          <button data-help="regenerate" aria-description={CONTROL_HELP.regenerate} disabled={busy || Boolean(pendingRegeneration)} onClick={() => void planRegeneration('Regenerate first pass', { kind: 'analysis', mode: documentModel.mode, settings: draftSettings ?? documentModel.settings })}>Regenerate first pass</button>
          {pendingRegeneration && <section className="regeneration-preview" aria-label="Regeneration impact preview">
            <strong>{pendingRegeneration.label} · proposed <HelpHint id="impact" label="proposed changes"/></strong>
            <p>The current document and masks are unchanged. Confirm to apply this result at revision {pendingRegeneration.impact.baseRevision}.</p>
            <p>{pendingRegeneration.impact.beforeActiveCount} current → {pendingRegeneration.impact.afterActiveCount} proposed active regions · {pendingRegeneration.impact.diagnosticCount} proposed diagnostics.</p>
            <p>Canvas contours: <span style={{ color: '#ffbd64' }}>amber current</span> · <span style={{ color: '#00ead3' }}>teal proposed</span> · <span style={{ color: '#ff5e78' }}>red removed</span>. {pendingRegeneration.impact.previewContours.length} shown{pendingRegeneration.impact.omittedPreviewContours ? `; ${pendingRegeneration.impact.omittedPreviewContours} omitted by the preview budget` : ''}.</p>
            <p>Target: {pendingRegeneration.impact.mode === 'animation-ready' ? 'Animation ready' : 'Appearance first'} · color step {pendingRegeneration.impact.settings.colorStep} · edge sensitivity {(pendingRegeneration.impact.settings.edgeSensitivity ?? 1).toFixed(2)} · minimum feature {pendingRegeneration.impact.settings.minRegionPixels} px · thin lines {pendingRegeneration.impact.settings.preserveThinLines !== false ? 'preserved' : 'mergeable'} · path tolerance {pendingRegeneration.impact.settings.pathTolerance} · hidden proposals {pendingRegeneration.impact.settings.inferHiddenGeometry ? 'on' : 'off'}.</p>
            <p>{Object.keys(pendingRegeneration.impact.remapped).length} region IDs matched to the current document. Unmatched old and new IDs are listed below; no uncertain ID mapping is assumed.</p>
            <div className="impact-list"><b>At-risk unlocked · {pendingRegeneration.impact.changedUnlockedIds.length + pendingRegeneration.impact.removedUnlockedIds.length}</b><small>{pendingRegeneration.impact.changedUnlockedIds.length} will change; {pendingRegeneration.impact.removedUnlockedIds.length} will be removed.</small>{[...pendingRegeneration.impact.changedUnlockedIds.map(id => `Change ${id}`), ...pendingRegeneration.impact.removedUnlockedIds.map(id => `Remove ${id}`)].slice(0, 8).map(item => <code key={item}>{item}</code>)}</div>
            <div className="impact-list"><b>Retained unlocked · {pendingRegeneration.impact.retainedUnlockedIds.length}</b>{pendingRegeneration.impact.retainedUnlockedIds.slice(0, 6).map(id => <code key={id}>{id}</code>)}</div>
            <div className="impact-list"><b>New candidates · {pendingRegeneration.impact.addedIds.length}</b>{pendingRegeneration.impact.addedIds.slice(0, 8).map(id => <code key={id}>{id}</code>)}</div>
            <div className="impact-list"><b>User-edited or locked regions retained · {pendingRegeneration.impact.retainedProtectedIds.length}</b>{pendingRegeneration.impact.retainedProtectedIds.slice(0, 6).map(id => <code key={id}>{id}</code>)}</div>
            {(pendingRegeneration.impact.changedProtectedIds.length > 0 || pendingRegeneration.impact.removedProtectedIds.length > 0) && <p className="impact-conflict">Cannot apply: {pendingRegeneration.impact.changedProtectedIds.length} protected regions would change and {pendingRegeneration.impact.removedProtectedIds.length} would be removed. Adjust the selection or settings and preview again.</p>}
            <div className="inline-actions"><button disabled={busy} onClick={() => { setPendingRegeneration(undefined); setStatus('Regeneration preview canceled. Current document is unchanged.'); }}>Cancel preview</button><button className="accent" disabled={busy || pendingRegeneration.impact.changedProtectedIds.length > 0 || pendingRegeneration.impact.removedProtectedIds.length > 0} onClick={() => void applyPlannedRegeneration()} data-help="impact" aria-description={CONTROL_HELP.impact}>Confirm regeneration</button></div>
          </section>}
        </>}
        <div className="divider"/>
        <h2>Selected region <HelpHint id="mask" label="region masks and contours"/></h2>{selectedRegion ? <div className="inspector"><p className="identity">{selectedRegion.id}</p><p>{selectedRegion.bounds.width} × {selectedRegion.bounds.height} at {selectedRegion.bounds.x}, {selectedRegion.bounds.y} · {selectedRegion.geometry.quality.pathPointCount} anchors</p>{selectedRegion.geometry.status === 'inferred' && <div className="inferred-callout"><strong>Unseen continuation · uncertain <HelpHint id="uncertainty" label="inferred geometry"/></strong><span>This amber contour is estimated beneath the foreground. Its hidden appearance is not visible in the source. Isolate and edit it before articulating the part.</span><button disabled={busy || Boolean(selectedRegion.geometry.manualPath)} onClick={() => void perform([{ op: 'region.setPath', regionId: selectedRegion.id, path: selectedRegion.geometry.generatedPath }])}>{selectedRegion.geometry.manualPath ? 'Contour pinned as manual edit' : 'Pin current hidden contour'}</button></div>}<p className="hint">Evidence: {selectedRegion.confidence.reasons.join('; ')}</p>
          {selectedRegion.geometry.texture === 'flat' ? <><label>{selectedRegion.alignedTexture ? 'Fallback fill color' : 'Flat fill color'}<input aria-label="Flat fill color" key={`${selectedRegion.id}-${selectedRegion.color}`} defaultValue={selectedRegion.color} disabled={busy} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} onBlur={event => { const next = event.target.value.trim().toLowerCase(); if (next === selectedRegion.color) return; if (!/^#[0-9a-f]{6}$/.test(next)) { event.target.value = selectedRegion.color; setStatus('Flat fill color must be a six-digit hex value, such as #aabbcc.'); return; } void perform([{ op: 'region.setColor', regionId: selectedRegion.id, color: next }]); }}/></label>{selectedRegion.authoredColor && <button disabled={busy} onClick={() => void perform([{ op: 'region.setColor', regionId: selectedRegion.id, color: null }])}>Reset generated color</button>}<p className="hint">{selectedRegion.alignedTexture ? 'This color fills pixels not supplied by the aligned still. Regeneration keeps it and updates the underlying estimate for reset.' : 'This editable fill changes independently of the generated contour. Regeneration keeps your color and updates the underlying estimate for reset.'}</p></> : <><p className="hint">This region uses source pixels as a texture; edit its mask or path to change the visible area. <HelpHint id="texture" label="source pixels"/></p>{selectedRegion.authoredColor && <button disabled={busy} onClick={() => void perform([{ op: 'region.setColor', regionId: selectedRegion.id, color: null }])}>Clear previous flat color correction</button>}</>}
          {selectedRegion.geometry.status === 'inferred' && <div className="inferred-callout"><strong>Hidden texture from an aligned still <HelpHint id="texture" label="source textures"/></strong><span>The primary pose hides these pixels. A manually matched alternate can provide an uncertain texture inside this editable Hyde path. The amber canvas marks the estimate; inspect the isolated crop below before trying a temporary Hyde joint pose.</span>{selectedRegion.alignedTexture && <><small>Using {documentModel?.sources.find(item => item.id === selectedRegion.alignedTexture?.sourceId)?.name ?? selectedRegion.alignedTexture.sourceId} with alignment saved at selection time.</small>{hiddenTextureUrl && <img className="hidden-texture-preview" src={hiddenTextureUrl} alt="Isolated uncertain hidden texture crop"/>}<button disabled={busy} onClick={() => void perform([{ op: 'region.setAlignedTexture', regionId: selectedRegion.id, sourceId: null }])}>Use flat inferred color</button></>}{alignedTextureChoices.map(choice => <button key={choice.id} disabled={busy || selectedRegion.alignedTexture?.sourceId === choice.id} onClick={() => void perform([{ op: 'region.setAlignedTexture', regionId: selectedRegion.id, sourceId: choice.id }])}>Use pixels from {choice.name}</button>)}{!alignedTextureChoices.length && !selectedRegion.alignedTexture && <small>Confirm the same part in both stills and align the alternate reference to enable this choice.</small>}</div>}
          {selectedRegion.geometry.status === 'inferred' && <button disabled={busy} onClick={() => void perform([{ op: 'region.setSuppressed', regionId: selectedRegion.id, suppressed: true }])}>Suppress inferred region</button>}
          <label>Assign to part<select aria-label="Assign to part" data-help="parts" aria-description={CONTROL_HELP.parts} value={selectedRegion.partId ?? ''} onChange={event => { if (event.target.value) void perform([{ op: 'part.assignRegion', regionId: selectedRegion.id, partId: event.target.value }]); }}><option value="">Unassigned</option>{documentModel?.parts.map(part => <option key={part.id} value={part.id}>{part.name}</option>)}</select></label>
          <p className="hint">The add brush can extend a generated contour within the source image. Seed edits stay bounded and split or merge changes topology. Brush hardness stores editable soft coverage beside binary contour topology; source alpha remains separate.</p>
          <div className="inferred-callout"><strong>Feather outside the contour</strong><span>This user-authored edit extends the mask into free neighboring pixels and regenerates its editable outer path. It keeps the original source mask for undo and recovery.</span><label>Radius <input aria-label="Outward feather radius" data-help="feather" aria-description={CONTROL_HELP.feather} type="range" min="1" max="12" value={featherRadius} onChange={event => setFeatherRadius(Number(event.target.value))}/>{featherRadius} px</label><label>Strength <input aria-label="Outward feather strength" data-help="feather" aria-description={CONTROL_HELP.feather} type="range" min="0.1" max="1" step="0.05" value={featherStrength} onChange={event => setFeatherStrength(Number(event.target.value))}/>{Math.round(featherStrength * 100)}%</label><button disabled={busy || selectedRegion.locked.mask || selectedRegion.locked.geometry || Boolean(selectedRegion.geometry.manualPath)} onClick={() => void perform([{ op: 'region.featherOutside', regionId: selectedRegion.id, radius: featherRadius, strength: featherStrength }])}>Apply outward feather</button>{selectedRegion.geometry.manualPath && <small>Unlock the path and switch to its generated contour before applying outward feather.</small>}</div>
          <label><input type="checkbox" data-help="locks" aria-description={CONTROL_HELP.locks} checked={selectedRegion.locked.mask} onChange={event => void perform([{ op: 'annotation.lock', regionId: selectedRegion.id, target: 'mask', locked: event.target.checked }])}/> Lock mask</label>
          <label><input type="checkbox" data-help="locks" aria-description={CONTROL_HELP.locks} checked={selectedRegion.locked.geometry} onChange={event => void perform([{ op: 'annotation.lock', regionId: selectedRegion.id, target: 'geometry', locked: event.target.checked }])}/> Lock path</label>
          {selectedRegion.geometry.manualPath && <button disabled={busy || selectedRegion.locked.geometry} onClick={() => void perform([{ op: 'region.clearManualPath', regionId: selectedRegion.id }])}>Use generated contour</button>}
          <label><input type="checkbox" data-help="locks" aria-description={CONTROL_HELP.locks} checked={selectedRegion.locked.part} onChange={event => void perform([{ op: 'annotation.lock', regionId: selectedRegion.id, target: 'part', locked: event.target.checked }])}/> Lock part assignment</label>
          {selectedPath && <div className="path-controls"><strong>Editable contour <HelpHint id="contour" label="contours and Bézier handles"/></strong><p className="hint">Click an anchor to select it. Drag its colored handle to adjust the Bézier curve.</p><span>{selectedPoint === undefined ? 'Select an anchor on the canvas' : `Anchor ${selectedPoint + 1} of ${selectedPath.points.length}`}</span>
            <div className="columns"><label>Shift X (px)<input aria-label="Contour shift X" type="number" step="0.25" value={pathOffsetX} onChange={event => setPathOffsetX(Number(event.target.value))}/></label><label>Shift Y (px)<input aria-label="Contour shift Y" type="number" step="0.25" value={pathOffsetY} onChange={event => setPathOffsetY(Number(event.target.value))}/></label></div><button disabled={busy || (!pathOffsetX && !pathOffsetY) || !Number.isFinite(pathOffsetX) || !Number.isFinite(pathOffsetY)} onClick={() => { void perform([{ op: 'region.offsetPath', regionId: selectedRegion.id, dx: pathOffsetX, dy: pathOffsetY }]); setPathOffsetX(0); setPathOffsetY(0); }}>Shift and pin contour</button><small>The mask stays in place. Anchors, handles and holes shift together; the result is one undoable manual contour.</small>
            <div className="inline-actions"><button aria-label="Add path anchor" disabled={busy || selectedPoint === undefined || selectedPath.points.length >= 4096} onClick={() => { if (selectedPoint === undefined) return; const path = splitPathSegment(selectedPath, selectedPoint); setSelectedPoint(selectedPoint + 1); void perform([{ op: 'region.setPath', regionId: selectedRegion.id, path }]); }}>Add after</button><button aria-label="Remove path anchor" disabled={busy || selectedPoint === undefined || selectedPath.points.length <= 3} onClick={() => { if (selectedPoint === undefined) return; const path = removePathPoint(selectedPath, selectedPoint); setSelectedPoint(Math.min(selectedPoint, path.points.length - 1)); void perform([{ op: 'region.setPath', regionId: selectedRegion.id, path }]); }}>Remove</button></div>
            {selectedPoint !== undefined && selectedPath.points[selectedPoint] && <div className="inline-actions">{(['in', 'out'] as const).map(side => <button key={side} aria-label={`${selectedPath.points[selectedPoint]?.[side] ? 'Remove' : 'Add'} ${side === 'in' ? 'incoming' : 'outgoing'} handle`} disabled={busy} onClick={() => { const point = selectedPath.points[selectedPoint]; const position = point[side] ? undefined : { x: point.x + (side === 'in' ? -.08 : .08), y: point.y }; void perform([{ op: 'region.setPath', regionId: selectedRegion.id, path: setPathHandle(selectedPath, selectedPoint, side, position) }]); }}>{selectedPath.points[selectedPoint][side] ? 'Remove' : 'Add'} {side} handle</button>)}</div>}
          </div>}
          <div className="inline-actions"><button data-help="splitMerge" aria-description={CONTROL_HELP.splitMerge} disabled={busy} onClick={() => void perform([{ op: 'region.split', regionId: selectedRegion.id, axis: 'x', coordinate: selectedRegion.bounds.x + selectedRegion.bounds.width / 2 }])}>Split vertical</button><button data-help="splitMerge" aria-description={CONTROL_HELP.splitMerge} disabled={busy} onClick={() => void perform([{ op: 'region.split', regionId: selectedRegion.id, axis: 'y', coordinate: selectedRegion.bounds.y + selectedRegion.bounds.height / 2 }])}>Split horizontal</button></div>
          <label>Merge with<select aria-label="Merge target" value={mergeTarget ?? ''} onChange={event => setMergeTarget(event.target.value)}><option value="">Choose region</option>{visibleRegions.filter(item => item.id !== selectedRegion.id).map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><button disabled={!mergeTarget || busy} onClick={() => { if (mergeTarget) void perform([{ op: 'region.merge', firstId: selectedRegion.id, secondId: mergeTarget }]); }}>Merge selected</button>
          <button disabled={busy || Boolean(pendingRegeneration)} onClick={() => void planRegeneration('Regenerate selected path', { kind: 'selected', regionIds: [selectedRegion.id] })}>Regenerate selected path</button>
          <label>Front of<select aria-label="Layer target" data-help="layer" aria-description={CONTROL_HELP.layer} value={relationTarget ?? ''} onChange={event => setRelationTarget(event.target.value)}><option value="">Choose region</option>{visibleRegions.filter(item => item.id !== selectedRegion.id).map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><button disabled={!relationTarget || busy} onClick={() => { if (relationTarget) void perform([{ op: 'layer.setRelation', frontRegionId: selectedRegion.id, backRegionId: relationTarget, approved: true }]); }}>Approve front relation</button>
          {documentModel?.layers.filter(item => item.status === 'proposed' && (item.frontRegionId === selectedRegion.id || item.backRegionId === selectedRegion.id)).map(item => { const other = documentModel.regions.find(region => region.id === (item.frontRegionId === selectedRegion.id ? item.backRegionId : item.frontRegionId)); return <div key={item.id} className="inferred-callout" aria-label="Layer proposal"><strong>Suggested front/back order · unapproved <HelpHint id="layer" label="draw order"/></strong><span>{item.frontRegionId === selectedRegion.id ? 'Selected region in front of' : 'Selected region behind'} {other ? referenceRegionLabel(other) : 'another region'}.</span><span>Evidence: {item.evidence.join('; ')}</span><div className="inline-actions"><button disabled={busy} onClick={() => void perform([{ op: 'layer.setRelation', frontRegionId: item.frontRegionId, backRegionId: item.backRegionId, approved: true }])}>Approve layer proposal</button><button disabled={busy} onClick={() => void perform([{ op: 'layer.rejectProposal', frontRegionId: item.frontRegionId, backRegionId: item.backRegionId }])}>Reject layer proposal</button></div></div>; })}
          {alternateRegions.length > 0 && primaryRegions.some(item => item.id === selectedRegion.id) && <div className="reference-guide" aria-label="Cross-reference identity"><strong>Which alternate shape is this same part? <HelpHint id="match" label="reference correspondence"/></strong><small>References are separate views, not animation frames. Repeated shapes can have several plausible matches; Hyde exports the primary construction pose only.</small><small>Selected primary: {referenceRegionLabel(selectedRegion)}</small>{[...matchByAlternate.values()].map(item => { const otherId = item.regionIds?.find(id => id !== selectedRegion.id); const other = documentModel?.regions.find(region => region.id === otherId); return other ? <div key={item.id} className="match-candidate"><small>{item.origin === 'manual' ? item.accepted ? 'Confirmed manually' : 'Rejected manually' : item.ambiguity ? 'Unresolved candidate' : 'Suggested candidate'}: {referenceRegionLabel(other)}{item.ambiguity && !item.accepted && item.origin !== 'manual' ? ` · ${item.ambiguity}` : ''}</small>{item.evidence.length > 0 && <small>Evidence: {item.evidence.join('; ')}</small>}{item.origin !== 'manual' && <button disabled={busy} onClick={() => void perform([{ op: 'reference.correspond', correspondence: { ...item, origin: 'manual', accepted: false, evidence: [...item.evidence, 'user rejected this candidate'] } }])}>Reject candidate</button>}</div> : null; })}<label>Match alternate region<select aria-label="Alternate match" data-help="match" aria-description={CONTROL_HELP.match} value={matchTarget ?? ''} onChange={event => setMatchTarget(event.target.value)}><option value="">Choose region</option>{alternateRegions.map(item => <option key={item.id} value={item.id}>{referenceRegionLabel(item)}</option>)}</select></label><button disabled={!matchTarget || busy} onClick={() => { const other = alternateRegions.find(item => item.id === matchTarget); if (other) void perform([{ op: 'reference.correspond', correspondence: { id: `${selectedRegion.id}_manual_${other.id}`, sourceIds: [selectedRegion.sourceId, other.sourceId], regionIds: [selectedRegion.id, other.id], kind: 'same-part', origin: 'manual', evidence: ['user confirmed'], accepted: true } }]); }}>Confirm same part</button><small>After matching and aligning stills, preview regeneration to inspect any new front/back evidence.</small></div>}
        </div> : selectedSuppressedRegion ? <div className="inspector"><p className="identity">{selectedSuppressedRegion.id}</p><p className="hint">This inferred region is suppressed. Its original mask and path remain in the editable source document.</p><button disabled={busy} onClick={() => void perform([{ op: 'region.setSuppressed', regionId: selectedSuppressedRegion.id, suppressed: false }])}>Restore inferred region</button></div> : <p className="hint">Select a region on the canvas or in the outliner.</p>}
        <div className="divider"/><h2>Selected part <HelpHint id="attachment" label="part hierarchy and attachments"/></h2>{selectedPart ? <div className="inspector"><label>Name<input aria-label="Part name" key={`${selectedPart.id}-${selectedPart.name}`} defaultValue={selectedPart.name} onBlur={event => { if (event.target.value !== selectedPart.name) void perform([{ op: 'part.rename', partId: selectedPart.id, name: event.target.value }]); }}/></label>
          {selectedPart.attachmentProposal && <div className="inferred-callout attachment-proposal"><strong>Suggested {selectedPart.attachmentProposal.type} attachment · unapproved <HelpHint id="attachment" label="attachment proposals"/></strong><span>Parent: {documentModel?.parts.find(part => part.id === selectedPart.attachmentProposal?.parentId)?.name ?? selectedPart.attachmentProposal.parentId}. Contact pivot: {selectedPart.attachmentProposal.pivot.x.toFixed(1)}, {selectedPart.attachmentProposal.pivot.y.toFixed(1)} px.</span><span>{selectedPart.attachmentProposal.evidence.join('; ')}{selectedPart.attachmentProposal.ambiguity ? ` ${selectedPart.attachmentProposal.ambiguity}` : ''}</span><div className="inline-actions"><button disabled={busy || selectedPart.attachmentLocked} onClick={() => void perform([{ op: 'part.acceptAttachmentProposal', partId: selectedPart.id }])}>Accept attachment proposal</button><button disabled={busy || selectedPart.attachmentLocked} onClick={() => void perform([{ op: 'part.rejectAttachmentProposal', partId: selectedPart.id }])}>Reject attachment proposal</button></div></div>}
          <div className="columns"><label>Pivot X<input aria-label="Pivot X" data-help="pivot" aria-description={CONTROL_HELP.pivot} type="number" key={`${selectedPart.id}-x-${selectedPart.pivot.x}`} defaultValue={selectedPart.pivot.x} onBlur={event => void perform([{ op: 'part.setPivot', partId: selectedPart.id, x: Number(event.target.value), y: selectedPart.pivot.y }])}/></label><label>Pivot Y<input aria-label="Pivot Y" data-help="pivot" aria-description={CONTROL_HELP.pivot} type="number" key={`${selectedPart.id}-y-${selectedPart.pivot.y}`} defaultValue={selectedPart.pivot.y} onBlur={event => void perform([{ op: 'part.setPivot', partId: selectedPart.id, x: selectedPart.pivot.x, y: Number(event.target.value) }])}/></label></div>
          <label><input type="checkbox" checked={selectedPart.pivotLocked} onChange={event => void perform([{ op: 'annotation.lock', partId: selectedPart.id, target: 'pivot', locked: event.target.checked }])}/> Lock pivot</label>
          <label><input aria-label="Lock attachment" data-help="locks" aria-description={CONTROL_HELP.locks} type="checkbox" checked={Boolean(selectedPart.attachmentLocked)} onChange={event => void perform([{ op: 'annotation.lock', partId: selectedPart.id, target: 'attachment', locked: event.target.checked }])}/> Lock attachment</label>
          <label>Parent part<select aria-label="Parent part" data-help="parent" aria-description={CONTROL_HELP.parent} disabled={selectedPart.attachmentLocked} value={selectedPart.parentId ?? ''} onChange={event => void perform([{ op: 'part.reparent', partId: selectedPart.id, parentId: event.target.value || undefined }])}><option value="">Assembly root</option>{documentModel?.parts.filter(item => item.id !== selectedPart.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Attachment<select aria-label="Attachment type" data-help="attachment" aria-description={CONTROL_HELP.attachment} disabled={selectedPart.attachmentLocked} value={selectedPart.attachment?.type ?? 'none'} onChange={event => void perform([{ op: 'part.setAttachment', partId: selectedPart.id, type: event.target.value === 'none' ? undefined : event.target.value as 'fixed' | 'hinge' | 'slider', approved: event.target.value !== 'none' }])}><option value="none">Unattached</option><option value="fixed">Fixed</option><option value="hinge">Hinge</option><option value="slider">Slider</option></select></label>
          {selectedPart.attachment && selectedPart.attachment.type !== 'fixed' && <div className="columns"><label>Min<input aria-label="Joint minimum" type="number" disabled={selectedPart.attachmentLocked} defaultValue={selectedPart.attachment.min ?? ''} onBlur={event => void perform([{ op: 'part.setAttachment', partId: selectedPart.id, type: selectedPart.attachment!.type, min: event.target.value === '' ? undefined : Number(event.target.value), max: selectedPart.attachment!.max, approved: true }])}/></label><label>Max<input aria-label="Joint maximum" type="number" disabled={selectedPart.attachmentLocked} defaultValue={selectedPart.attachment.max ?? ''} onBlur={event => void perform([{ op: 'part.setAttachment', partId: selectedPart.id, type: selectedPart.attachment!.type, min: selectedPart.attachment!.min, max: event.target.value === '' ? undefined : Number(event.target.value), approved: true }])}/></label></div>}
          {selectedPart.attachmentApproved && selectedPart.attachment && selectedPart.attachment.type !== 'fixed' && <div className="inferred-callout"><strong>Inspect temporary joint pose <HelpHint id="pose" label="temporary joint poses"/></strong><span>Enter an offset from the construction pose. Hyde's joint limits are applied to this preview only.</span><label>{selectedPart.attachment.type === 'hinge' ? 'Angle offset (degrees)' : 'Slide offset (parent-local pixels)'}<input aria-label="Temporary joint offset" data-help="pose" aria-description={CONTROL_HELP.pose} type="number" step="1" value={poseOffset} onChange={event => setPoseOffset(Number(event.target.value))}/></label><button disabled={busy || !Number.isFinite(poseOffset)} onClick={() => void nativeExport(true, { partId: selectedPart.id, value: poseOffset })}>Preview temporary pose in Hyde</button></div>}
          <label>Move region to<select aria-label="Move region to part" value={partTarget ?? ''} onChange={event => setPartTarget(event.target.value)}><option value="">Choose part</option>{documentModel?.parts.filter(item => item.id !== selectedPart.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <button disabled={!partTarget || !selectedRegion || busy} onClick={() => { if (partTarget && selectedRegion) void perform([{ op: 'part.assignRegion', regionId: selectedRegion.id, partId: partTarget }]); }}>Reassign region</button>
        </div> : <p className="hint">Parts keep stable IDs as regions are refined.</p>}
        {documentModel && <div className="inspector"><button disabled={busy} onClick={() => { const id = `manual_part_${Date.now()}`; void perform([{ op: 'part.create', id, name: `Part ${documentModel.parts.length + 1}`, regionIds: selectedRegion ? [selectedRegion.id] : [] }]); }}>New part {selectedRegion ? 'from region' : ''}</button></div>}
        <div className="divider"/><h2 data-tour="delivery">Native delivery <HelpHint id="export" label="native file formats"/></h2><div className="inspector"><label>Format<select aria-label="Export format" data-help="export" aria-description={CONTROL_HELP.export} value={exportFormat} onChange={event => setExportFormat(event.target.value as 'hyde' | 'hyproj')}><option value="hyproj">Editable assembly · .hyproj</option><option value="hyde">Editable story · .hyde</option></select></label><label><input type="checkbox" checked={allowHoleApproximation} onChange={event => setAllowHoleApproximation(event.target.checked)}/> Allow raster fallback for unrepresentable holes</label><div className="inline-actions"><button data-help="quality" aria-description={CONTROL_HELP.quality} disabled={!documentModel || busy} onClick={() => void nativeExport(true)}>Preview in Hyde</button><button data-help="export" aria-description={CONTROL_HELP.export} className="accent" disabled={!documentModel || busy} onClick={() => void nativeExport(false)}>Export</button></div>
          <div className="inferred-callout"><strong>Update an exported assembly</strong><span>Choose a previous .hyproj from this decomposition. Review the IDs that will be replaced, added, or removed, then download a replacement. Your selected file is not changed.</span><label className="button">Review existing .hyproj<input type="file" accept=".hyproj" hidden disabled={busy} onChange={event => void reviewAssembly(event)}/></label>
            {assemblyReview && <div aria-label="Assembly replacement impact"><p><strong>{assemblyReview.name}</strong> · {assemblyReview.impact.targetName}</p><p>SHA-256: <code>{assemblyReview.impact.targetFingerprint}</code></p><p>Elements: {assemblyReview.impact.replacedIds.length} replaced, {assemblyReview.impact.addedIds.length} added, {assemblyReview.impact.removedIds.length} removed. Assets: {assemblyReview.impact.replacedAssetIds.length} replaced, {assemblyReview.impact.addedAssetIds.length} added, {assemblyReview.impact.removedAssetIds.length} removed.</p><details><summary>Show affected native IDs</summary>{(['replacedIds', 'addedIds', 'removedIds', 'replacedAssetIds', 'addedAssetIds', 'removedAssetIds'] as const).map(kind => <p key={kind}><strong>{kind}</strong>: {assemblyReview.impact[kind].join(', ') || 'none'}</p>)}</details>{(assemblyReview.revision !== revision || assemblyReview.documentId !== documentModel?.id) && <p>This review is stale. Select the assembly again.</p>}<div className="inline-actions"><button onClick={() => setAssemblyReview(undefined)}>Dismiss</button><button className="accent" disabled={busy || assemblyReview.revision !== revision || assemblyReview.documentId !== documentModel?.id} onClick={() => void nativeExport(false, undefined, assemblyReview)}>Download replacement .hyproj</button></div></div>}
          </div></div>
      </aside>
    </div>
    <footer className="diagnostics"><strong>Diagnostics <HelpHint id="diagnostics" label="diagnostics"/></strong><div className="diagnostic-list">{documentModel?.diagnostics.length ? documentModel.diagnostics.map((item, index) => item.sourceId || item.regionId || item.partId ? <button key={`${item.code}-${index}`} className={`diagnostic navigable ${item.severity}`} disabled={busy} onClick={() => void navigateDiagnostic(item)} title="Focus source region for this diagnostic"><b>{item.code}</b><span>{item.message}</span>{item.suggestion && <small>{item.suggestion}</small>}{item.evidence?.length ? <small>Heuristic evidence: {item.evidence.join('; ')}</small> : null}</button> : <div key={`${item.code}-${index}`} className={`diagnostic ${item.severity}`}><b>{item.code}</b><span>{item.message}</span>{item.suggestion && <small>{item.suggestion}</small>}{item.evidence?.length ? <small>Heuristic evidence: {item.evidence.join('; ')}</small> : null}</div>) : <span className="hint">No diagnostics yet. Automatic suggestions are heuristic evidence, not certainty.</span>}</div></footer>
    <HelpTooltips disabled={helpOpen}/>
    {helpOpen&&<HelpDialog onClose={()=>setHelpOpen(false)} onRestart={restartWalkthrough}/>}
    {walkthroughOpen&&!helpOpen&&<Walkthrough key={walkthroughVersion} onExit={dismissWalkthrough}/>}
  </div>;
}
