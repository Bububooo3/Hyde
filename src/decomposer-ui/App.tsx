import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { DecompositionDocumentV1, DecompositionEdit, DecompositionMode, PartRecord, ReconstructionSettings, RegionMask, RegionRecord } from '../decomposer';
import { poseNativeDecomposition } from '../decomposer/pose';
import type { ReconstructionQualityReport } from '../decomposer/quality';
import type { Project, ShapePath } from '../model';
import { removePathPoint, setPathHandle, splitPathSegment } from '../shapePath';
import { DecomposerWorkerClient } from './client';

type View = 'original' | 'reconstruction' | 'overlay' | 'side-by-side';
type Tool = 'select' | 'path' | 'paint-add' | 'paint-erase' | 'seed-add' | 'seed-erase' | 'landmark' | 'pivot';
type WorkerState = { revision: number; document: DecompositionDocumentV1 };
type RegenerationRequest = { kind: 'analysis'; mode?: DecompositionMode; settings?: Partial<ReconstructionSettings> } |
  { kind: 'selected'; regionIds: string[]; settings?: Partial<ReconstructionSettings> };
type RegenerationImpact = { baseRevision: number; kind: RegenerationRequest['kind']; mode: DecompositionMode; settings: ReconstructionSettings;
  beforeActiveCount: number; afterActiveCount: number; addedIds: string[]; changedUnlockedIds: string[];
  removedUnlockedIds: string[]; retainedUnlockedIds: string[]; retainedProtectedIds: string[];
  changedProtectedIds: string[]; removedProtectedIds: string[]; diagnosticCount: number; remapped: Record<string, string> };
type NativeQualityReport = Omit<ReconstructionQualityReport, 'residualOverlayPng'>;
const color = (hex: string): [number, number, number] => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
const current = (region: RegionRecord) => region.generationStatus !== 'historical';
const active = (region: RegionRecord) => current(region) && !region.suppressed;
const percentage = (value: number | null) => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
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

function sourcePixels(image: HTMLImageElement, width: number, height: number): Uint8ClampedArray {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('2D canvas is unavailable.');
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
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
  const client = useRef<DecomposerWorkerClient>(null!);
  if (!client.current) client.current = new DecomposerWorkerClient();
  const sourceUrl = useRef<string | undefined>(undefined);
  const sourceImage = useRef<HTMLImageElement | undefined>(undefined);
  const sourcePixelsRef = useRef<Uint8ClampedArray | undefined>(undefined);
  const originalCanvas = useRef<HTMLCanvasElement>(null), reconstructionCanvas = useRef<HTMLCanvasElement>(null);
  const [documentModel, setDocumentModel] = useState<DecompositionDocumentV1>();
  const [revision, setRevision] = useState(0), [selectedSourceId, setSelectedSourceId] = useState<string>();
  const [masks, setMasks] = useState<Map<string, RegionMask>>(new Map());
  const [selectedRegionId, setSelectedRegionId] = useState<string>();
  const [selectedPartId, setSelectedPartId] = useState<string>();
  const [view, setView] = useState<View>('side-by-side'), [tool, setTool] = useState<Tool>('select');
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [brushRadius, setBrushRadius] = useState(3), [brushHardness, setBrushHardness] = useState(1), [overlayAlpha, setOverlayAlpha] = useState(.5);
  const [featherRadius, setFeatherRadius] = useState(2), [featherStrength, setFeatherStrength] = useState(.65);
  const [selectedPoint, setSelectedPoint] = useState<number>(), [draftPoint, setDraftPoint] = useState<{ x: number; y: number }>();
  const [draftHandle, setDraftHandle] = useState<{ side: 'in' | 'out'; x: number; y: number }>();
  const [edgeSnap, setEdgeSnap] = useState(false), [edgeSnapRadius, setEdgeSnapRadius] = useState(4);
  const [seedTolerance, setSeedTolerance] = useState(36), [seedRadius, setSeedRadius] = useState(24);
  const [pendingLandmark, setPendingLandmark] = useState<{ sourceId: string; x: number; y: number }>();
  const [renderVersion, setRenderVersion] = useState(0), [isolate, setIsolate] = useState(false);
  const [showInferred, setShowInferred] = useState(true);
  const [requestedInference, setRequestedInference] = useState<boolean>();
  const [requestedMode, setRequestedMode] = useState<DecompositionMode>();
  const [draftSettings, setDraftSettings] = useState<ReconstructionSettings>();
  const [pendingRegeneration, setPendingRegeneration] = useState<{ label: string; request: RegenerationRequest; impact: RegenerationImpact }>();
  const [busy, setBusy] = useState(false), [status, setStatus] = useState('Import one or more illustrations to begin.');
  const [exportFormat, setExportFormat] = useState<'hyde' | 'hyproj'>('hyproj'), [allowHoleApproximation, setAllowHoleApproximation] = useState(false);
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
  const canceling = useRef(false);

  const clearNativePreview = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    if (residualUrlRef.current) URL.revokeObjectURL(residualUrlRef.current);
    previewUrlRef.current = undefined; residualUrlRef.current = undefined;
    setPreviewUrl(undefined); setResidualUrl(undefined); setNativeQuality(undefined); setShowResidual(false); setPosePreview(false);
  }, []);
  useEffect(() => () => {
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
  const selectedPart = documentModel?.parts.find(item => item.id === selectedPartId) ?? documentModel?.parts.find(item => item.id === selectedRegion?.partId);
  useEffect(() => setPoseOffset(0), [selectedPart?.id]);
  const selectedPath = selectedRegion?.geometry.manualPath ?? selectedRegion?.geometry.generatedPath;
  const primarySourceId = documentModel?.sources.find(item => item.role === 'primary')?.id;
  const alignmentLandmarkIds = documentModel?.correspondences.filter(item => item.kind === 'landmark' && item.accepted && primarySourceId && source && item.sourceIds.includes(primarySourceId) && item.sourceIds.includes(source.id)).map(item => item.id) ?? [];
  const canvasZoomStyle = source && zoom !== 'fit' ? { width: source.width * zoom, height: source.height * zoom } : undefined;

  const readSource = useCallback(async (sourceId: string, doc: DecompositionDocumentV1) => {
    const metadata = doc.sources.find(item => item.id === sourceId); if (!metadata) return;
    const response = await client.current.call<{ bytes: Uint8Array }>('source', { id: sourceId });
    const url = URL.createObjectURL(new Blob([response.bytes as BlobPart], { type: metadata.mime }));
    const image = new Image(); image.src = url; await image.decode();
    if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
    sourceUrl.current = url; sourceImage.current = image; sourcePixelsRef.current = sourcePixels(image, metadata.width, metadata.height);
    setRenderVersion(value => value + 1);
  }, []);
  const refresh = useCallback(async (state: WorkerState, loadSource = false) => {
    clearNativePreview();
    setPendingRegeneration(undefined); setDraftSettings(state.document.settings);
    setRequestedMode(undefined); setRequestedInference(undefined);
    setDocumentModel(state.document); setRevision(state.revision);
    const primary = state.document.sources.find(item => item.role === 'primary') ?? state.document.sources[0];
    const sourceId = loadSource || !selectedSourceId || !state.document.sources.some(item => item.id === selectedSourceId) ? primary?.id : selectedSourceId;
    if (sourceId) {
      setSelectedSourceId(sourceId);
      const response = await client.current.call<{ id: string; mask: RegionMask }[]>('masks', { sourceId });
      setMasks(new Map(response.map(item => [item.id, item.mask])));
      if (loadSource || sourceImage.current === undefined || source?.id !== sourceId) await readSource(sourceId, state.document);
    }
    setQuality(await client.current.call('compare'));
    setRenderVersion(value => value + 1);
  }, [clearNativePreview, readSource, selectedSourceId, source?.id]);

  const perform = useCallback(async (edits: DecompositionEdit[], mask?: RegionMask) => {
    if (!documentModel || busy) return;
    setBusy(true);
    try {
      const response = await client.current.call<{ result: { ok: boolean; error?: { message: string } }; revision: number; document: DecompositionDocumentV1 }>('execute', { expectedRevision: revision, edits, mask });
      if (!response.result.ok) throw new Error(response.result.error?.message ?? 'Edit failed.');
      await refresh(response);
      setStatus(`${edits.map(item => item.op).join(', ')} saved in revision ${response.revision}.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Edit failed.'); }
    finally { setBusy(false); }
  }, [documentModel, busy, revision, refresh]);

  async function importImages(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])]; event.target.value = '';
    if (!files.length) return;
    setBusy(true); setStatus('Importing original references locally…');
    try {
      if (documentModel) checkpoint.current = (await client.current.call<{ bytes: Uint8Array }>('save')).bytes;
      const inputs = await Promise.all(files.map(async (file, index) => ({ name: file.name, mime: file.type, role: index === 0 ? 'primary' : 'alternate-view', bytes: new Uint8Array(await file.arrayBuffer()) })));
      const imported = await client.current.call<WorkerState>('import', { inputs, options: { name: files[0].name.replace(/\.[^.]+$/, '') } });
      await refresh(imported, true); setSelectedRegionId(undefined); setSelectedPartId(undefined); setPendingLandmark(undefined);
      checkpoint.current = (await client.current.call<{ bytes: Uint8Array }>('save')).bytes;
      setStatus(`Imported ${files.length} reference${files.length === 1 ? '' : 's'}. Analyzing…`);
      await new Promise(resolve => window.setTimeout(resolve, 0));
      const analyzed = await client.current.call<WorkerState>('analyze', {});
      await refresh(analyzed, true);
      setStatus(`Automatic first pass found ${analyzed.document.regions.filter(active).length} editable regions. Inspect boundaries and diagnostics before export.`);
    } catch (error) { if (!canceling.current) setStatus(error instanceof Error ? error.message : 'Import failed.'); }
    finally { setBusy(false); }
  }
  async function openDocument(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    setBusy(true);
    try {
      const opened = await client.current.call<WorkerState>('open', { bytes: new Uint8Array(await file.arrayBuffer()) });
      await refresh(opened, true); setSelectedRegionId(undefined); setSelectedPartId(undefined); setPendingLandmark(undefined); setStatus(`Opened ${file.name}; original references and edits are available.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Open failed.'); }
    finally { setBusy(false); }
  }
  async function saveDocument() {
    if (!documentModel || busy) return;
    setBusy(true);
    try { const response = await client.current.call<{ bytes: Uint8Array }>('save'); download(response.bytes, `${documentModel.name}.hydecomp`, 'application/zip'); setStatus('Editable .hydecomp document saved.'); }
    catch (error) { setStatus(error instanceof Error ? error.message : 'Save failed.'); }
    finally { setBusy(false); }
  }
  async function nativeExport(preview = false, pose?: { partId: string; value: number }) {
    if (!documentModel || busy) return;
    setBusy(true); setStatus(preview ? 'Rendering the native Hyde project…' : `Exporting editable .${exportFormat}…`);
    try {
      const result = await client.current.call<{ bytes: Uint8Array; project: Project; mapping: { partIds: Record<string, string>; regionIds: Record<string, string> }; warnings: { message: string }[] }>('export', { options: { format: preview ? 'hyde' : exportFormat, allowHoleApproximation } });
      if (preview) {
        clearNativePreview();
        const posed = pose ? poseNativeDecomposition(result, pose.partId, pose.value) : undefined;
        const renderProject = posed?.project ?? result.project;
        const { HydeRenderHost } = await import('../browserHost');
        const host = await HydeRenderHost.connect(() => renderProject);
        try {
          const frame = await host.renderFrame({ timeSeconds: 0, width: renderProject.width, height: renderProject.height });
          const url = URL.createObjectURL(new Blob([frame.bytes as BlobPart], { type: frame.mime }));
          previewUrlRef.current = url;
          setPreviewUrl(url);
          setPosePreview(Boolean(posed));
          if (posed) setStatus(`Temporary Hyde joint pose ready at ${posed.appliedValue.toFixed(1)} ${renderProject.elements.find(item => item.id === result.mapping.partIds[pose!.partId])?.attachment?.type === 'hinge' ? 'degrees' : 'pixels'}. No motion or pose was saved.`);
          else try {
            const comparison = await client.current.call<{ report: NativeQualityReport; overlayPng: Uint8Array }>('native.compare', { renderedPng: frame.bytes });
            const overlayUrl = URL.createObjectURL(new Blob([comparison.overlayPng as BlobPart], { type: 'image/png' }));
            residualUrlRef.current = overlayUrl;
            setResidualUrl(overlayUrl);
            setNativeQuality(comparison.report);
            setStatus(`Native Hyde preview and measured pixel comparison ready. ${result.warnings.length} export warning${result.warnings.length === 1 ? '' : 's'}.`);
          } catch (error) {
            setStatus(`Native Hyde preview rendered, but pixel comparison failed: ${error instanceof Error ? error.message : 'unknown error'}`);
          }
        } finally { host.close(); }
      } else {
        download(result.bytes, `${documentModel.name}.${exportFormat}`, 'application/zip');
        setStatus(`Editable .${exportFormat} exported through Hyde SDK. ${result.warnings.map(item => item.message).join(' ')}`);
      }
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Native export failed.'); }
    finally { setBusy(false); }
  }
  async function planRegeneration(label: string, request: RegenerationRequest) {
    if (!documentModel || busy || pendingRegeneration) return;
    setBusy(true); setStatus(`Preparing ${label.toLowerCase()} impact preview…`);
    try {
      checkpoint.current = (await client.current.call<{ bytes: Uint8Array }>('save')).bytes;
      const impact = await client.current.call<RegenerationImpact>('regeneration.preview', { ...request, expectedRevision: revision });
      setPendingRegeneration({ label, request, impact });
      setStatus(`Review ${label.toLowerCase()}: ${impact.changedUnlockedIds.length} unlocked changed, ${impact.removedUnlockedIds.length} removed, ${impact.addedIds.length} added. Current document is unchanged.`);
    } catch (error) { if (!canceling.current) setStatus(error instanceof Error ? error.message : 'Regeneration preview failed.'); }
    finally { setRequestedMode(undefined); setRequestedInference(undefined); setBusy(false); }
  }
  async function applyPlannedRegeneration() {
    if (!pendingRegeneration || busy) return;
    const { request, impact, label } = pendingRegeneration;
    if (impact.changedProtectedIds.length || impact.removedProtectedIds.length) return;
    setBusy(true); setStatus(`Applying ${label.toLowerCase()}…`);
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
      await refresh(state);
      setStatus(`${label} applied in revision ${state.revision}; ${state.document.regions.filter(active).length} regions active.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Regeneration failed.'); }
    finally { setBusy(false); }
  }
  async function setHiddenContinuations(enabled: boolean) {
    if (!documentModel || busy || pendingRegeneration || documentModel.mode !== 'animation-ready') return;
    setRequestedInference(enabled);
    await planRegeneration(enabled ? 'Enable hidden continuations' : 'Disable hidden continuations', {
      kind: 'analysis', settings: { ...(draftSettings ?? documentModel.settings), inferHiddenGeometry: enabled },
    });
  }
  async function cancelWork() {
    if (!busy) return;
    canceling.current = true;
    client.current.restart();
    setBusy(false); setStatus('Canceled. Restoring the last complete document checkpoint…');
    try { if (checkpoint.current) await refresh(await client.current.call<WorkerState>('open', { bytes: checkpoint.current }), true); }
    catch (error) { setStatus(error instanceof Error ? error.message : 'Could not restore checkpoint.'); }
    finally { canceling.current = false; }
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
    const drawOriginal = (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return; canvas.width = source.width; canvas.height = source.height;
      const ctx = canvas.getContext('2d'); if (!ctx) return;
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
    };
    drawOriginal(originalCanvas.current);
    const canvas = reconstructionCanvas.current; if (!canvas) return;
    canvas.width = source.width; canvas.height = source.height;
    const context = canvas.getContext('2d'); if (!context) return;
    const imageData = context.createImageData(source.width, source.height);
    const ordered = [...visibleRegions].sort((a, b) => (documentModel?.parts.find(part => part.id === a.partId)?.zOrder ?? 0) - (documentModel?.parts.find(part => part.id === b.partId)?.zOrder ?? 0));
    for (const region of ordered) {
      if (region.geometry.status === 'inferred') continue;
      if (isolate && selectedRegionId && region.id !== selectedRegionId) continue;
      const mask = masks.get(region.id); if (!mask) continue;
      const rgb = color(region.color);
      for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
        if (!mask.bytes[y * mask.width + x]) continue;
        const index = ((region.bounds.y + y) * source.width + region.bounds.x + x) * 4;
        if (region.geometry.texture === 'source-crop' || region.holeCount) imageData.data.set(rgba.subarray(index, index + 4), index);
        else imageData.data.set([...rgb, rgba[index + 3]], index);
        imageData.data[index + 3] = Math.round(imageData.data[index + 3] * (mask.alpha?.[y * mask.width + x] ?? 255) / 255);
      }
    }
    context.putImageData(imageData, 0, 0);
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
    if (pointer.current?.tool.startsWith('paint')) {
      context.save(); context.strokeStyle = pointer.current.tool === 'paint-add' ? '#06f0aa' : '#ff6378'; context.lineWidth = Math.max(1, brushRadius * 2); context.lineCap = 'round';
      context.beginPath(); pointer.current.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)); context.stroke(); context.restore();
    }
  }, [source?.id, source?.width, source?.height, visibleRegions, inferredRegions, documentModel?.parts, documentModel?.correspondences, masks, selectedRegion, selectedRegionId, selectedPart, view, overlayAlpha, isolate, showInferred, selectedPoint, draftPoint, draftHandle, pendingLandmark, tool, brushRadius, renderVersion]);

  const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!source) return { x: 0, y: 0 };
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(source.width, (event.clientX - rect.left) / rect.width * source.width)), y: Math.max(0, Math.min(source.height, (event.clientY - rect.top) / rect.height * source.height)) };
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
      const mask: RegionMask = { width: old.width, height: old.height, bytes: Uint8Array.from(old.bytes), ...(old.alpha ? { alpha: Uint8Array.from(old.alpha) } : {}) };
      const points = [...stroke.points, point];
      for (let index = 0; index < points.length; index++) {
        const from = points[Math.max(0, index - 1)], to = points[index];
        const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(1, brushRadius / 2)));
        for (let step = 0; step <= steps; step++) paintDisc(mask, selectedRegion.bounds, from.x + (to.x - from.x) * step / steps, from.y + (to.y - from.y) * step / steps, brushRadius, stroke.tool === 'paint-add' ? 1 : 0, brushHardness);
      }
      void perform([{ op: 'region.refineMask', regionId: selectedRegion.id, handle: 'worker' }], mask);
    }
    setRenderVersion(value => value + 1);
  }

  const primaryRegions = documentModel?.regions.filter(region => active(region) && region.sourceId === documentModel.sources.find(source => source.role === 'primary')?.id) ?? [];
  const alternateRegions = documentModel?.regions.filter(region => active(region) && region.sourceId !== documentModel.sources.find(source => source.role === 'primary')?.id) ?? [];
  return <div className="decomposer-app">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">H</span><div><strong>Hyde Image Decomposer</strong><small>Local, deterministic, editable art</small></div></div>
      <div className="toolbar">
        <label className="button accent">Import images<input aria-label="Import images" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={importImages}/></label>
        <label className="button">Open .hydecomp<input aria-label="Open .hydecomp" type="file" accept=".hydecomp,application/zip" hidden onChange={openDocument}/></label>
        <button disabled={!documentModel || busy} onClick={saveDocument}>Save source</button>
        <button disabled={!documentModel || busy} onClick={() => void undoRedo('undo')}>Undo</button>
        <button disabled={!documentModel || busy} onClick={() => void undoRedo('redo')}>Redo</button>
      </div>
    </header>
    <div className="workspace">
      <aside className="left-pane pane">
        <h2>References</h2>
        {documentModel ? <div className="stack">{documentModel.sources.map(item => <button key={item.id} className={source?.id === item.id ? 'row selected' : 'row'} onClick={async () => { setSelectedSourceId(item.id); setSelectedRegionId(undefined); setSelectedPartId(undefined); await readSource(item.id, documentModel); const response = await client.current.call<{ id: string; mask: RegionMask }[]>('masks', { sourceId: item.id }); setMasks(new Map(response.map(entry => [entry.id, entry.mask]))); }}><span>{item.name}</span><small>{item.role} · {item.width} × {item.height}</small></button>)}</div> : <p className="hint">PNG, JPEG and WebP. Select multiple files to compare views.</p>}
        {pendingLandmark && <div className="reference-guide"><span>Pending landmark on {documentModel?.sources.find(item => item.id === pendingLandmark.sourceId)?.name} at {pendingLandmark.x}, {pendingLandmark.y}</span><button onClick={() => setPendingLandmark(undefined)}>Cancel point</button></div>}
        {documentModel?.correspondences.some(item => item.kind === 'landmark') && <div className="reference-guide"><strong>Paired landmarks</strong>{documentModel.correspondences.filter(item => item.kind === 'landmark' && item.landmarkPoints).map(item => <small key={item.id}>{item.sourceIds.map((id, index) => `${documentModel.sources.find(source => source.id === id)?.name ?? id} (${item.landmarkPoints![index].x.toFixed(1)}, ${item.landmarkPoints![index].y.toFixed(1)})`).join(' ↔ ')}</small>)}</div>}
        {source && source.role !== 'primary' && <div className="reference-guide"><strong>Alignment to primary</strong><small>Optional affine mapping of this source into primary pixels. Use only where one transform describes both images.</small><button disabled={!alignmentLandmarkIds.length || busy} onClick={() => void perform([{ op: 'reference.alignFromLandmarks', sourceId: source.id, landmarkIds: alignmentLandmarkIds }])}>Align from paired landmarks</button><div className="affine-grid">{(['a', 'b', 'c', 'd', 'tx', 'ty'] as const).map((name, index) => <label key={`${source.id}-${name}`}>{name}<input aria-label={`Alignment ${name}`} type="number" step="0.01" key={`${source.id}-${name}-${source.transformToPrimary?.[index] ?? ''}`} defaultValue={(source.transformToPrimary ?? [1, 0, 0, 1, 0, 0])[index]} onBlur={event => { const value = Number(event.target.value); if (!Number.isFinite(value)) return; const next = [...(source.transformToPrimary ?? [1, 0, 0, 1, 0, 0])] as [number, number, number, number, number, number]; if (next[index] === value) return; next[index] = value; void perform([{ op: 'reference.setTransform', sourceId: source.id, transformToPrimary: next }]); }}/></label>)}</div><small>x′ = ax + cy + tx; y′ = bx + dy + ty</small><button disabled={!source.transformToPrimary || busy} onClick={() => void perform([{ op: 'reference.setTransform', sourceId: source.id }])}>Clear alignment</button></div>}
        <div className="divider"/><h2>Regions</h2>
        <div className="scroll-list">{visibleRegions.map(region => { const impact = pendingRegeneration?.impact; const risk = impact?.removedUnlockedIds.includes(region.id) ? 'Will be removed' : impact?.changedUnlockedIds.includes(region.id) ? 'Will change' : undefined; return <button key={region.id} className={`row${selectedRegionId === region.id ? ' selected' : ''}${region.geometry.status === 'inferred' ? ' inferred-row' : ''}${risk ? ' regeneration-affected' : ''}`} onClick={() => { setSelectedRegionId(region.id); setSelectedPartId(region.partId); setSelectedPoint(undefined); }}><span><i className="swatch" style={{ background: region.geometry.status === 'inferred' ? '#ffcb70' : region.color }}/> {region.id.split('_').slice(-2).join(' ')}</span><small>{risk ? `${risk} on confirmation · ` : ''}{region.geometry.status === 'inferred' ? 'Inferred · unseen and uncertain · ' : ''}{region.pixelCount} px · {region.geometry.texture === 'source-crop' ? 'texture' : 'vector'} {region.holeCount ? `· ${region.holeCount} hole` : ''}</small></button>; })}{suppressedRegions.map(region => <button key={region.id} className={`row suppressed-row${selectedRegionId === region.id ? ' selected' : ''}`} onClick={() => { setSelectedRegionId(region.id); setSelectedPartId(region.partId); setSelectedPoint(undefined); }}><span><i className="swatch" style={{ background: '#876c45' }}/> {region.id.split('_').slice(-2).join(' ')}</span><small>Suppressed inferred region · source evidence retained</small></button>)}</div>
        <div className="divider"/><h2>Parts</h2>
        <div className="scroll-list">{documentModel?.parts.filter(part => part.regionIds.some(id => documentModel.regions.some(region => region.id === id && active(region) && region.sourceId === source?.id))).map(part => <button key={part.id} className={selectedPart?.id === part.id ? 'row selected' : 'row'} onClick={() => { setSelectedPartId(part.id); setSelectedRegionId(part.regionIds.find(id => visibleRegions.some(region => region.id === id))); }}><span>{part.name}</span><small>{part.regionIds.length} region{part.regionIds.length === 1 ? '' : 's'} · pivot {part.pivot.x.toFixed(1)}, {part.pivot.y.toFixed(1)}{part.hiddenGeometry !== 'none' ? ` · ${part.hiddenGeometry} hidden area` : ''}{part.attachmentProposal ? ` · ${part.attachmentProposal.type} proposed` : ''}</small></button>)}</div>
      </aside>
      <main className="center-pane">
        <div className="canvas-toolbar"><div className="segmented">{(['original', 'reconstruction', 'overlay', 'side-by-side'] as View[]).map(item => <button key={item} aria-pressed={view === item} onClick={() => setView(item)}>{item === 'side-by-side' ? 'Side by side' : item[0].toUpperCase() + item.slice(1)}</button>)}</div><label>Zoom<select aria-label="Canvas zoom" value={String(zoom)} onChange={event => setZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))}><option value="fit">Fit</option><option value="1">1× pixels</option><option value="2">2× pixels</option><option value="4">4× pixels</option><option value="8">8× pixels</option></select></label><label>Tool <select aria-label="Canvas tool" value={tool} onChange={event => setTool(event.target.value as Tool)}><option value="select">Select</option><option value="path">Edit path and handles</option><option value="paint-add">Add mask brush</option><option value="paint-erase">Subtract mask brush</option><option value="seed-add">Foreground seed</option><option value="seed-erase">Background seed</option><option value="landmark">Pair reference landmark</option><option value="pivot">Set pivot</option></select></label><label><input type="checkbox" checked={isolate} onChange={event => setIsolate(event.target.checked)}/> Isolate</label></div>
        {(tool === 'path' || tool.startsWith('paint') || tool.startsWith('seed') || view === 'overlay' || inferredRegions.length > 0) && <div className="canvas-subbar">
          {tool.startsWith('paint') && <><label>Brush radius <input aria-label="Brush radius" type="range" min="1" max="40" value={brushRadius} onChange={event => setBrushRadius(Number(event.target.value))}/>{brushRadius}px</label><label>Brush hardness <input aria-label="Brush hardness" type="range" min="0.1" max="1" step="0.1" value={brushHardness} onChange={event => setBrushHardness(Number(event.target.value))}/>{Math.round(brushHardness * 100)}%</label></>}
          {tool.startsWith('seed') && <><label>Seed tolerance <input aria-label="Seed tolerance" type="range" min="0" max="255" value={seedTolerance} onChange={event => setSeedTolerance(Number(event.target.value))}/>{seedTolerance}</label><label>Seed reach <input aria-label="Seed reach" type="range" min="1" max="256" value={seedRadius} onChange={event => setSeedRadius(Number(event.target.value))}/>{seedRadius}px</label></>}
          {tool === 'path' && <><label><input aria-label="Snap path to source edges" type="checkbox" checked={edgeSnap} onChange={event => setEdgeSnap(event.target.checked)}/> Snap anchors to source edges</label>{edgeSnap && <label>Snap reach <input aria-label="Snap reach" type="range" min="1" max="12" value={edgeSnapRadius} onChange={event => setEdgeSnapRadius(Number(event.target.value))}/>{edgeSnapRadius}px</label>}</>}
          {view === 'overlay' && <label>Overlay opacity <input aria-label="Overlay opacity" type="range" min="0" max="1" step="0.05" value={overlayAlpha} onChange={event => setOverlayAlpha(Number(event.target.value))}/></label>}
          {inferredRegions.length > 0 && <label><input aria-label="Show inferred overlay" type="checkbox" checked={showInferred} onChange={event => setShowInferred(event.target.checked)}/> Show {inferredRegions.length} uncertain hidden contour{inferredRegions.length === 1 ? '' : 's'} in amber</label>}
        </div>}
        <div className={`canvas-grid ${view === 'side-by-side' ? 'two' : ''}`}>{source ? <>
          {(view === 'original' || view === 'side-by-side') && <div className="canvas-card"><div className="canvas-label">Original · {source.name}</div><canvas ref={originalCanvas} style={canvasZoomStyle} className={`${zoom !== 'fit' ? 'zoomed ' : ''}${tool === 'landmark' ? 'interactive-canvas' : ''}`} onPointerDown={tool === 'landmark' ? onPointerDown : undefined}/></div>}
          {(view !== 'original') && <div className="canvas-card"><div className="canvas-label">{view === 'overlay' ? 'Overlay' : 'Reconstruction'} · source masks and geometry</div><canvas ref={reconstructionCanvas} style={canvasZoomStyle} className={`interactive-canvas${zoom !== 'fit' ? ' zoomed' : ''}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}/></div>}
        </> : <div className="empty-state"><div className="empty-art">◇</div><h1>Turn illustrations into editable Hyde art</h1><p>Import a stylized image to get an automatic first pass. Refine regions, inspect uncertainty, and export a native project or assembly.</p><label className="button accent">Choose images<input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={importImages}/></label></div>}</div>
        {previewUrl && <div className="native-preview">
          <div className="section-heading"><h3>{posePreview ? 'Temporary Hyde joint pose' : 'Native Hyde render · primary reference'}</h3><button onClick={clearNativePreview}>Close</button></div>
          <div className="native-preview-visual"><img alt={posePreview ? 'Temporary Hyde joint pose' : 'Native Hyde render of current export'} src={previewUrl}/>{showResidual && residualUrl && <img className="residual-image" alt="Native residual overlay" src={residualUrl}/>}</div>
          {posePreview && <p className="hint">This render uses a disposable copy of the native Hyde project. The saved decomposition, exported assembly and construction pose have not changed.</p>}
          {nativeQuality && <>
            <div className="native-metrics" aria-label="Native quality metrics">
              <div><strong>Silhouette IoU</strong><span>{percentage(nativeQuality.silhouette.iou)}</span><small>Boundary mean {nativeQuality.boundary.meanDistancePixels === null ? 'n/a' : `${nativeQuality.boundary.meanDistancePixels.toFixed(2)} px`}</small></div>
              <div><strong>Color error</strong><span>{percentage(nativeQuality.color.meanAbsoluteSrgbChannelError)}</span><small>{nativeQuality.color.residualPixels} residual pixels</small></div>
              <div><strong>Coverage missing</strong><span>{percentage(nativeQuality.coverage.uncoveredFraction)}</span><small>{nativeQuality.coverage.uncoveredPixels} missing · {nativeQuality.coverage.excessPixels} excess px</small></div>
              <div><strong>Complexity</strong><span>{nativeQuality.complexity.activeRegionCount} regions · {nativeQuality.complexity.activePartCount} parts</span><small>{nativeQuality.complexity.pathPointCount} path anchors</small></div>
            </div>
            <label className="residual-toggle"><input aria-label="Show residual overlay" type="checkbox" checked={showResidual} onChange={event => setShowResidual(event.target.checked)}/> Show measured residual overlay</label>
            {showResidual && <div className="residual-legend">{Object.entries(nativeQuality.overlayLegend).map(([name, swatch]) => <span key={name}><i style={{ background: swatch }}/>{name.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>)}</div>}
            <p className="hint">Pixel measurements at source resolution; judge visual quality from the rendered image.</p>
          </>}
        </div>}
        <div className="status-panel"><div className="section-heading"><h3>{busy ? 'Processing' : 'Status'}</h3>{busy && <button onClick={() => void cancelWork()}>Cancel and restore</button>}</div><p role="status">{status}</p>{quality && <p className="metric">Sampled path to mask IoU: {(quality.meanSampledMaskIoU * 100).toFixed(1)}% · {quality.pointCount} path anchors. Color and texture fidelity require the native render preview.</p>}</div>
      </main>
      <aside className="right-pane pane"><h2>Reconstruction</h2>
        {documentModel && <><label>Mode<select aria-label="Reconstruction mode" value={pendingRegeneration?.impact.mode ?? requestedMode ?? documentModel.mode} disabled={busy || Boolean(pendingRegeneration)} onChange={event => { const mode = event.target.value as DecompositionMode; setRequestedMode(mode); void planRegeneration(`Switch to ${mode}`, { kind: 'analysis', mode }); }}><option value="appearance">Appearance first</option><option value="animation-ready">Animation ready</option></select></label>
          <label><input aria-label="Infer hidden continuations" type="checkbox" checked={pendingRegeneration?.impact.settings.inferHiddenGeometry ?? requestedInference ?? documentModel.settings.inferHiddenGeometry} disabled={busy || Boolean(pendingRegeneration) || documentModel.mode !== 'animation-ready'} onChange={event => void setHiddenContinuations(event.target.checked)}/> Propose hidden continuations</label>
          <p className="hint">Animation ready only. Enclosed opaque overlaps may support a conservative unseen piece beneath a front region. The inferred shape and color remain uncertain; pinned edits survive when automatic proposals are turned off.</p>
          <label>Color granularity <input aria-label="Color granularity" type="range" min="8" max="96" value={(draftSettings ?? documentModel.settings).colorStep} disabled={busy || Boolean(pendingRegeneration)} onChange={event => setDraftSettings({ ...(draftSettings ?? documentModel.settings), colorStep: Number(event.target.value) })}/><span>{(draftSettings ?? documentModel.settings).colorStep}</span></label>
          <label>Path tolerance <input aria-label="Path tolerance" type="range" min="0" max="8" step="0.25" value={(draftSettings ?? documentModel.settings).pathTolerance} disabled={busy || Boolean(pendingRegeneration)} onChange={event => setDraftSettings({ ...(draftSettings ?? documentModel.settings), pathTolerance: Number(event.target.value) })}/><span>{(draftSettings ?? documentModel.settings).pathTolerance}</span></label>
          {draftSettings && JSON.stringify(draftSettings) !== JSON.stringify(documentModel.settings) && <p className="hint">Settings are staged. Preview their impact before applying.</p>}
          <button disabled={busy || Boolean(pendingRegeneration)} onClick={() => void planRegeneration('Apply settings', { kind: 'analysis', settings: draftSettings ?? documentModel.settings })}>Preview settings impact</button>
          <button disabled={busy || Boolean(pendingRegeneration)} onClick={() => void planRegeneration('Regenerate first pass', { kind: 'analysis', mode: documentModel.mode, settings: draftSettings ?? documentModel.settings })}>Regenerate first pass</button>
          {pendingRegeneration && <section className="regeneration-preview" aria-label="Regeneration impact preview">
            <strong>{pendingRegeneration.label} · proposed</strong>
            <p>The current document and masks are unchanged. Confirm to apply this result at revision {pendingRegeneration.impact.baseRevision}.</p>
            <p>{pendingRegeneration.impact.beforeActiveCount} current → {pendingRegeneration.impact.afterActiveCount} proposed active regions · {pendingRegeneration.impact.diagnosticCount} proposed diagnostics.</p>
            <p>Target: {pendingRegeneration.impact.mode === 'animation-ready' ? 'Animation ready' : 'Appearance first'} · color step {pendingRegeneration.impact.settings.colorStep} · path tolerance {pendingRegeneration.impact.settings.pathTolerance} · hidden proposals {pendingRegeneration.impact.settings.inferHiddenGeometry ? 'on' : 'off'}.</p>
            <p>{Object.keys(pendingRegeneration.impact.remapped).length} region IDs matched to the current document. Unmatched old and new IDs are listed below; no uncertain ID mapping is assumed.</p>
            <div className="impact-list"><b>At-risk unlocked · {pendingRegeneration.impact.changedUnlockedIds.length + pendingRegeneration.impact.removedUnlockedIds.length}</b><small>{pendingRegeneration.impact.changedUnlockedIds.length} will change; {pendingRegeneration.impact.removedUnlockedIds.length} will be removed.</small>{[...pendingRegeneration.impact.changedUnlockedIds.map(id => `Change ${id}`), ...pendingRegeneration.impact.removedUnlockedIds.map(id => `Remove ${id}`)].slice(0, 8).map(item => <code key={item}>{item}</code>)}</div>
            <div className="impact-list"><b>Retained unlocked · {pendingRegeneration.impact.retainedUnlockedIds.length}</b>{pendingRegeneration.impact.retainedUnlockedIds.slice(0, 6).map(id => <code key={id}>{id}</code>)}</div>
            <div className="impact-list"><b>New candidates · {pendingRegeneration.impact.addedIds.length}</b>{pendingRegeneration.impact.addedIds.slice(0, 8).map(id => <code key={id}>{id}</code>)}</div>
            <div className="impact-list"><b>User-edited or locked regions retained · {pendingRegeneration.impact.retainedProtectedIds.length}</b>{pendingRegeneration.impact.retainedProtectedIds.slice(0, 6).map(id => <code key={id}>{id}</code>)}</div>
            {(pendingRegeneration.impact.changedProtectedIds.length > 0 || pendingRegeneration.impact.removedProtectedIds.length > 0) && <p className="impact-conflict">Cannot apply: {pendingRegeneration.impact.changedProtectedIds.length} protected regions would change and {pendingRegeneration.impact.removedProtectedIds.length} would be removed. Adjust the selection or settings and preview again.</p>}
            <div className="inline-actions"><button disabled={busy} onClick={() => { setPendingRegeneration(undefined); setStatus('Regeneration preview canceled. Current document is unchanged.'); }}>Cancel preview</button><button className="accent" disabled={busy || pendingRegeneration.impact.changedProtectedIds.length > 0 || pendingRegeneration.impact.removedProtectedIds.length > 0} onClick={() => void applyPlannedRegeneration()}>Confirm regeneration</button></div>
          </section>}
        </>}
        <div className="divider"/>
        <h2>Selected region</h2>{selectedRegion ? <div className="inspector"><p className="identity">{selectedRegion.id}</p><p>{selectedRegion.bounds.width} × {selectedRegion.bounds.height} at {selectedRegion.bounds.x}, {selectedRegion.bounds.y} · {selectedRegion.geometry.quality.pathPointCount} anchors</p>{selectedRegion.geometry.status === 'inferred' && <div className="inferred-callout"><strong>Unseen continuation · uncertain</strong><span>This amber contour is estimated beneath the foreground. Its hidden appearance is not visible in the source. Isolate and edit it before articulating the part.</span><button disabled={busy || Boolean(selectedRegion.geometry.manualPath)} onClick={() => void perform([{ op: 'region.setPath', regionId: selectedRegion.id, path: selectedRegion.geometry.generatedPath }])}>{selectedRegion.geometry.manualPath ? 'Contour pinned as manual edit' : 'Pin current hidden contour'}</button></div>}<p className="hint">Evidence: {selectedRegion.confidence.reasons.join('; ')}</p>
          {selectedRegion.geometry.status === 'inferred' && <button disabled={busy} onClick={() => void perform([{ op: 'region.setSuppressed', regionId: selectedRegion.id, suppressed: true }])}>Suppress inferred region</button>}
          <label>Assign to part<select aria-label="Assign to part" value={selectedRegion.partId ?? ''} onChange={event => { if (event.target.value) void perform([{ op: 'part.assignRegion', regionId: selectedRegion.id, partId: event.target.value }]); }}><option value="">Unassigned</option>{documentModel?.parts.map(part => <option key={part.id} value={part.id}>{part.name}</option>)}</select></label>
          <p className="hint">Brush and seed edits stay within this region’s current bounds. Brush hardness stores editable soft coverage inside binary contour topology; source alpha remains separate. Split or merge to change topology.</p>
          <div className="inferred-callout"><strong>Feather outside the contour</strong><span>This user-authored edit extends the mask into free neighboring pixels and regenerates its editable outer path. It keeps the original source mask for undo and recovery.</span><label>Radius <input aria-label="Outward feather radius" type="range" min="1" max="12" value={featherRadius} onChange={event => setFeatherRadius(Number(event.target.value))}/>{featherRadius} px</label><label>Strength <input aria-label="Outward feather strength" type="range" min="0.1" max="1" step="0.05" value={featherStrength} onChange={event => setFeatherStrength(Number(event.target.value))}/>{Math.round(featherStrength * 100)}%</label><button disabled={busy || selectedRegion.locked.mask || selectedRegion.locked.geometry || Boolean(selectedRegion.geometry.manualPath)} onClick={() => void perform([{ op: 'region.featherOutside', regionId: selectedRegion.id, radius: featherRadius, strength: featherStrength }])}>Apply outward feather</button>{selectedRegion.geometry.manualPath && <small>Unlock the path and switch to its generated contour before applying outward feather.</small>}</div>
          <label><input type="checkbox" checked={selectedRegion.locked.mask} onChange={event => void perform([{ op: 'annotation.lock', regionId: selectedRegion.id, target: 'mask', locked: event.target.checked }])}/> Lock mask</label>
          <label><input type="checkbox" checked={selectedRegion.locked.geometry} onChange={event => void perform([{ op: 'annotation.lock', regionId: selectedRegion.id, target: 'geometry', locked: event.target.checked }])}/> Lock path</label>
          {selectedRegion.geometry.manualPath && <button disabled={busy || selectedRegion.locked.geometry} onClick={() => void perform([{ op: 'region.clearManualPath', regionId: selectedRegion.id }])}>Use generated contour</button>}
          <label><input type="checkbox" checked={selectedRegion.locked.part} onChange={event => void perform([{ op: 'annotation.lock', regionId: selectedRegion.id, target: 'part', locked: event.target.checked }])}/> Lock part assignment</label>
          {selectedPath && <div className="path-controls"><strong>Editable contour</strong><p className="hint">Click an anchor to select it. Drag its colored handle to adjust the Bézier curve.</p><span>{selectedPoint === undefined ? 'Select an anchor on the canvas' : `Anchor ${selectedPoint + 1} of ${selectedPath.points.length}`}</span>
            <div className="inline-actions"><button aria-label="Add path anchor" disabled={busy || selectedPoint === undefined || selectedPath.points.length >= 4096} onClick={() => { if (selectedPoint === undefined) return; const path = splitPathSegment(selectedPath, selectedPoint); setSelectedPoint(selectedPoint + 1); void perform([{ op: 'region.setPath', regionId: selectedRegion.id, path }]); }}>Add after</button><button aria-label="Remove path anchor" disabled={busy || selectedPoint === undefined || selectedPath.points.length <= 3} onClick={() => { if (selectedPoint === undefined) return; const path = removePathPoint(selectedPath, selectedPoint); setSelectedPoint(Math.min(selectedPoint, path.points.length - 1)); void perform([{ op: 'region.setPath', regionId: selectedRegion.id, path }]); }}>Remove</button></div>
            {selectedPoint !== undefined && selectedPath.points[selectedPoint] && <div className="inline-actions">{(['in', 'out'] as const).map(side => <button key={side} aria-label={`${selectedPath.points[selectedPoint]?.[side] ? 'Remove' : 'Add'} ${side === 'in' ? 'incoming' : 'outgoing'} handle`} disabled={busy} onClick={() => { const point = selectedPath.points[selectedPoint]; const position = point[side] ? undefined : { x: point.x + (side === 'in' ? -.08 : .08), y: point.y }; void perform([{ op: 'region.setPath', regionId: selectedRegion.id, path: setPathHandle(selectedPath, selectedPoint, side, position) }]); }}>{selectedPath.points[selectedPoint][side] ? 'Remove' : 'Add'} {side} handle</button>)}</div>}
          </div>}
          <div className="inline-actions"><button disabled={busy} onClick={() => void perform([{ op: 'region.split', regionId: selectedRegion.id, axis: 'x', coordinate: selectedRegion.bounds.x + selectedRegion.bounds.width / 2 }])}>Split vertical</button><button disabled={busy} onClick={() => void perform([{ op: 'region.split', regionId: selectedRegion.id, axis: 'y', coordinate: selectedRegion.bounds.y + selectedRegion.bounds.height / 2 }])}>Split horizontal</button></div>
          <label>Merge with<select aria-label="Merge target" value={mergeTarget ?? ''} onChange={event => setMergeTarget(event.target.value)}><option value="">Choose region</option>{visibleRegions.filter(item => item.id !== selectedRegion.id).map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><button disabled={!mergeTarget || busy} onClick={() => { if (mergeTarget) void perform([{ op: 'region.merge', firstId: selectedRegion.id, secondId: mergeTarget }]); }}>Merge selected</button>
          <button disabled={busy || Boolean(pendingRegeneration)} onClick={() => void planRegeneration('Regenerate selected path', { kind: 'selected', regionIds: [selectedRegion.id] })}>Regenerate selected path</button>
          <label>Front of<select aria-label="Layer target" value={relationTarget ?? ''} onChange={event => setRelationTarget(event.target.value)}><option value="">Choose region</option>{visibleRegions.filter(item => item.id !== selectedRegion.id).map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><button disabled={!relationTarget || busy} onClick={() => { if (relationTarget) void perform([{ op: 'layer.setRelation', frontRegionId: selectedRegion.id, backRegionId: relationTarget, approved: true }]); }}>Approve front relation</button>
          {alternateRegions.length > 0 && primaryRegions.some(item => item.id === selectedRegion.id) && <><label>Match alternate region<select aria-label="Alternate match" value={matchTarget ?? ''} onChange={event => setMatchTarget(event.target.value)}><option value="">Choose region</option>{alternateRegions.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><button disabled={!matchTarget || busy} onClick={() => { const other = alternateRegions.find(item => item.id === matchTarget); if (other) void perform([{ op: 'reference.correspond', correspondence: { id: `${selectedRegion.id}_manual_${other.id}`, sourceIds: [selectedRegion.sourceId, other.sourceId], regionIds: [selectedRegion.id, other.id], kind: 'same-part', origin: 'manual', evidence: ['user confirmed'], accepted: true } }]); }}>Confirm match</button></>}
        </div> : selectedSuppressedRegion ? <div className="inspector"><p className="identity">{selectedSuppressedRegion.id}</p><p className="hint">This inferred region is suppressed. Its original mask and path remain in the editable source document.</p><button disabled={busy} onClick={() => void perform([{ op: 'region.setSuppressed', regionId: selectedSuppressedRegion.id, suppressed: false }])}>Restore inferred region</button></div> : <p className="hint">Select a region on the canvas or in the outliner.</p>}
        <div className="divider"/><h2>Selected part</h2>{selectedPart ? <div className="inspector"><label>Name<input aria-label="Part name" key={`${selectedPart.id}-${selectedPart.name}`} defaultValue={selectedPart.name} onBlur={event => { if (event.target.value !== selectedPart.name) void perform([{ op: 'part.rename', partId: selectedPart.id, name: event.target.value }]); }}/></label>
          {selectedPart.attachmentProposal && <div className="inferred-callout attachment-proposal"><strong>Suggested {selectedPart.attachmentProposal.type} attachment · unapproved</strong><span>Parent: {documentModel?.parts.find(part => part.id === selectedPart.attachmentProposal?.parentId)?.name ?? selectedPart.attachmentProposal.parentId}. Contact pivot: {selectedPart.attachmentProposal.pivot.x.toFixed(1)}, {selectedPart.attachmentProposal.pivot.y.toFixed(1)} px.</span><span>{selectedPart.attachmentProposal.evidence.join('; ')}{selectedPart.attachmentProposal.ambiguity ? ` ${selectedPart.attachmentProposal.ambiguity}` : ''}</span><div className="inline-actions"><button disabled={busy || selectedPart.attachmentLocked} onClick={() => void perform([{ op: 'part.acceptAttachmentProposal', partId: selectedPart.id }])}>Accept attachment proposal</button><button disabled={busy || selectedPart.attachmentLocked} onClick={() => void perform([{ op: 'part.rejectAttachmentProposal', partId: selectedPart.id }])}>Reject attachment proposal</button></div></div>}
          <div className="columns"><label>Pivot X<input aria-label="Pivot X" type="number" key={`${selectedPart.id}-x-${selectedPart.pivot.x}`} defaultValue={selectedPart.pivot.x} onBlur={event => void perform([{ op: 'part.setPivot', partId: selectedPart.id, x: Number(event.target.value), y: selectedPart.pivot.y }])}/></label><label>Pivot Y<input aria-label="Pivot Y" type="number" key={`${selectedPart.id}-y-${selectedPart.pivot.y}`} defaultValue={selectedPart.pivot.y} onBlur={event => void perform([{ op: 'part.setPivot', partId: selectedPart.id, x: selectedPart.pivot.x, y: Number(event.target.value) }])}/></label></div>
          <label><input type="checkbox" checked={selectedPart.pivotLocked} onChange={event => void perform([{ op: 'annotation.lock', partId: selectedPart.id, target: 'pivot', locked: event.target.checked }])}/> Lock pivot</label>
          <label><input aria-label="Lock attachment" type="checkbox" checked={Boolean(selectedPart.attachmentLocked)} onChange={event => void perform([{ op: 'annotation.lock', partId: selectedPart.id, target: 'attachment', locked: event.target.checked }])}/> Lock attachment</label>
          <label>Parent part<select aria-label="Parent part" disabled={selectedPart.attachmentLocked} value={selectedPart.parentId ?? ''} onChange={event => void perform([{ op: 'part.reparent', partId: selectedPart.id, parentId: event.target.value || undefined }])}><option value="">Assembly root</option>{documentModel?.parts.filter(item => item.id !== selectedPart.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Attachment<select aria-label="Attachment type" disabled={selectedPart.attachmentLocked} value={selectedPart.attachment?.type ?? 'none'} onChange={event => void perform([{ op: 'part.setAttachment', partId: selectedPart.id, type: event.target.value === 'none' ? undefined : event.target.value as 'fixed' | 'hinge' | 'slider', approved: event.target.value !== 'none' }])}><option value="none">Unattached</option><option value="fixed">Fixed</option><option value="hinge">Hinge</option><option value="slider">Slider</option></select></label>
          {selectedPart.attachment && selectedPart.attachment.type !== 'fixed' && <div className="columns"><label>Min<input aria-label="Joint minimum" type="number" disabled={selectedPart.attachmentLocked} defaultValue={selectedPart.attachment.min ?? ''} onBlur={event => void perform([{ op: 'part.setAttachment', partId: selectedPart.id, type: selectedPart.attachment!.type, min: event.target.value === '' ? undefined : Number(event.target.value), max: selectedPart.attachment!.max, approved: true }])}/></label><label>Max<input aria-label="Joint maximum" type="number" disabled={selectedPart.attachmentLocked} defaultValue={selectedPart.attachment.max ?? ''} onBlur={event => void perform([{ op: 'part.setAttachment', partId: selectedPart.id, type: selectedPart.attachment!.type, min: selectedPart.attachment!.min, max: event.target.value === '' ? undefined : Number(event.target.value), approved: true }])}/></label></div>}
          {selectedPart.attachmentApproved && selectedPart.attachment && selectedPart.attachment.type !== 'fixed' && <div className="inferred-callout"><strong>Inspect temporary joint pose</strong><span>Enter an offset from the construction pose. Hyde's joint limits are applied to this preview only.</span><label>{selectedPart.attachment.type === 'hinge' ? 'Angle offset (degrees)' : 'Slide offset (parent-local pixels)'}<input aria-label="Temporary joint offset" type="number" step="1" value={poseOffset} onChange={event => setPoseOffset(Number(event.target.value))}/></label><button disabled={busy || !Number.isFinite(poseOffset)} onClick={() => void nativeExport(true, { partId: selectedPart.id, value: poseOffset })}>Preview temporary pose in Hyde</button></div>}
          <label>Move region to<select aria-label="Move region to part" value={partTarget ?? ''} onChange={event => setPartTarget(event.target.value)}><option value="">Choose part</option>{documentModel?.parts.filter(item => item.id !== selectedPart.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <button disabled={!partTarget || !selectedRegion || busy} onClick={() => { if (partTarget && selectedRegion) void perform([{ op: 'part.assignRegion', regionId: selectedRegion.id, partId: partTarget }]); }}>Reassign region</button>
        </div> : <p className="hint">Parts keep stable IDs as regions are refined.</p>}
        {documentModel && <div className="inspector"><button disabled={busy} onClick={() => { const id = `manual_part_${Date.now()}`; void perform([{ op: 'part.create', id, name: `Part ${documentModel.parts.length + 1}`, regionIds: selectedRegion ? [selectedRegion.id] : [] }]); }}>New part {selectedRegion ? 'from region' : ''}</button></div>}
        <div className="divider"/><h2>Native delivery</h2><div className="inspector"><label>Format<select aria-label="Export format" value={exportFormat} onChange={event => setExportFormat(event.target.value as 'hyde' | 'hyproj')}><option value="hyproj">Editable assembly · .hyproj</option><option value="hyde">Editable story · .hyde</option></select></label><label><input type="checkbox" checked={allowHoleApproximation} onChange={event => setAllowHoleApproximation(event.target.checked)}/> Allow raster fallback for unrepresentable holes</label><div className="inline-actions"><button disabled={!documentModel || busy} onClick={() => void nativeExport(true)}>Preview in Hyde</button><button className="accent" disabled={!documentModel || busy} onClick={() => void nativeExport(false)}>Export</button></div></div>
      </aside>
    </div>
    <footer className="diagnostics"><strong>Diagnostics</strong><div className="diagnostic-list">{documentModel?.diagnostics.length ? documentModel.diagnostics.map((item, index) => <div key={`${item.code}-${index}`} className={`diagnostic ${item.severity}`}><b>{item.code}</b><span>{item.message}</span>{item.suggestion && <small>{item.suggestion}</small>}</div>) : <span className="hint">No diagnostics yet. Automatic suggestions are heuristic evidence, not certainty.</span>}</div></footer>
  </div>;
}
