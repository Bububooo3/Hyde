import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { DecompositionDocumentV1, DecompositionEdit, PartRecord, RegionMask, RegionRecord } from '../decomposer';
import type { ReconstructionQualityReport } from '../decomposer/quality';
import type { Project, ShapePath } from '../model';
import { DecomposerWorkerClient } from './client';

type View = 'original' | 'reconstruction' | 'overlay' | 'side-by-side';
type Tool = 'select' | 'path' | 'paint-add' | 'paint-erase' | 'pivot';
type WorkerState = { revision: number; document: DecompositionDocumentV1 };
type NativeQualityReport = Omit<ReconstructionQualityReport, 'residualOverlayPng'>;
const color = (hex: string): [number, number, number] => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
const active = (region: RegionRecord) => region.generationStatus !== 'historical';
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
  ctx.restore();
}

function sourcePixels(image: HTMLImageElement, width: number, height: number): Uint8ClampedArray {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('2D canvas is unavailable.');
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
}

function paintDisc(mask: RegionMask, bounds: RegionRecord['bounds'], x: number, y: number, radius: number, value: number): void {
  const left = Math.max(0, Math.floor(x - radius - bounds.x)), right = Math.min(mask.width - 1, Math.ceil(x + radius - bounds.x));
  const top = Math.max(0, Math.floor(y - radius - bounds.y)), bottom = Math.min(mask.height - 1, Math.ceil(y + radius - bounds.y));
  for (let row = top; row <= bottom; row++) for (let column = left; column <= right; column++) {
    const px = bounds.x + column + .5, py = bounds.y + row + .5;
    if (Math.hypot(px - x, py - y) <= radius) mask.bytes[row * mask.width + column] = value;
  }
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
  const [brushRadius, setBrushRadius] = useState(3), [overlayAlpha, setOverlayAlpha] = useState(.5);
  const [selectedPoint, setSelectedPoint] = useState<number>(), [draftPoint, setDraftPoint] = useState<{ x: number; y: number }>();
  const [renderVersion, setRenderVersion] = useState(0), [isolate, setIsolate] = useState(false);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState('Import one or more illustrations to begin.');
  const [exportFormat, setExportFormat] = useState<'hyde' | 'hyproj'>('hyproj'), [allowHoleApproximation, setAllowHoleApproximation] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const previewUrlRef = useRef<string | undefined>(undefined);
  const [residualUrl, setResidualUrl] = useState<string>();
  const residualUrlRef = useRef<string | undefined>(undefined);
  const [nativeQuality, setNativeQuality] = useState<NativeQualityReport>();
  const [showResidual, setShowResidual] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<string>(), [partTarget, setPartTarget] = useState<string>();
  const [relationTarget, setRelationTarget] = useState<string>(), [matchTarget, setMatchTarget] = useState<string>();
  const [quality, setQuality] = useState<{ meanSampledMaskIoU: number; pointCount: number }>();
  const pointer = useRef<{ tool: Tool; points: { x: number; y: number }[]; anchor?: number } | undefined>(undefined);
  const checkpoint = useRef<Uint8Array | undefined>(undefined);
  const canceling = useRef(false);

  const clearNativePreview = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    if (residualUrlRef.current) URL.revokeObjectURL(residualUrlRef.current);
    previewUrlRef.current = undefined; residualUrlRef.current = undefined;
    setPreviewUrl(undefined); setResidualUrl(undefined); setNativeQuality(undefined); setShowResidual(false);
  }, []);
  useEffect(() => () => {
    client.current.close();
    if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    if (residualUrlRef.current) URL.revokeObjectURL(residualUrlRef.current);
  }, []);
  const source = documentModel?.sources.find(item => item.id === selectedSourceId) ?? documentModel?.sources[0];
  const visibleRegions = useMemo(() => documentModel?.regions.filter(region => active(region) && region.sourceId === source?.id) ?? [], [documentModel, source?.id]);
  const selectedRegion = documentModel?.regions.find(item => item.id === selectedRegionId && active(item));
  const selectedPart = documentModel?.parts.find(item => item.id === selectedPartId) ?? documentModel?.parts.find(item => item.id === selectedRegion?.partId);

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
      await refresh(imported, true); setSelectedRegionId(undefined); setSelectedPartId(undefined);
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
      await refresh(opened, true); setSelectedRegionId(undefined); setSelectedPartId(undefined); setStatus(`Opened ${file.name}; original references and edits are available.`);
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
  async function nativeExport(preview = false) {
    if (!documentModel || busy) return;
    setBusy(true); setStatus(preview ? 'Rendering the native Hyde project…' : `Exporting editable .${exportFormat}…`);
    try {
      const result = await client.current.call<{ bytes: Uint8Array; project: Project; warnings: { message: string }[] }>('export', { options: { format: preview ? 'hyde' : exportFormat, allowHoleApproximation } });
      if (preview) {
        clearNativePreview();
        const { HydeRenderHost } = await import('../browserHost');
        const host = await HydeRenderHost.connect(() => result.project);
        try {
          const frame = await host.renderFrame({ timeSeconds: 0, width: result.project.width, height: result.project.height });
          const url = URL.createObjectURL(new Blob([frame.bytes as BlobPart], { type: frame.mime }));
          previewUrlRef.current = url;
          setPreviewUrl(url);
          try {
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
  async function analyzeAgain() {
    if (!documentModel || busy) return;
    setBusy(true); setStatus('Regenerating unlocked candidates; source and manual edits remain available…');
    try {
      checkpoint.current = (await client.current.call<{ bytes: Uint8Array }>('save')).bytes;
      await new Promise(resolve => window.setTimeout(resolve, 0));
      const response = await client.current.call<WorkerState>('analyze', { mode: documentModel.mode, settings: documentModel.settings });
      await refresh(response); setStatus(`Regenerated ${response.document.regions.filter(active).length} regions. Manual locks were preserved.`);
    } catch (error) { if (!canceling.current) setStatus(error instanceof Error ? error.message : 'Regeneration failed.'); }
    finally { setBusy(false); }
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
    };
    drawOriginal(originalCanvas.current);
    const canvas = reconstructionCanvas.current; if (!canvas) return;
    canvas.width = source.width; canvas.height = source.height;
    const context = canvas.getContext('2d'); if (!context) return;
    const imageData = context.createImageData(source.width, source.height);
    const ordered = [...visibleRegions].sort((a, b) => (documentModel?.parts.find(part => part.id === a.partId)?.zOrder ?? 0) - (documentModel?.parts.find(part => part.id === b.partId)?.zOrder ?? 0));
    for (const region of ordered) {
      if (isolate && selectedRegionId && region.id !== selectedRegionId) continue;
      const mask = masks.get(region.id); if (!mask) continue;
      const rgb = color(region.color);
      for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
        if (!mask.bytes[y * mask.width + x]) continue;
        const index = ((region.bounds.y + y) * source.width + region.bounds.x + x) * 4;
        if (region.geometry.texture === 'source-crop' || region.holeCount) imageData.data.set(rgba.subarray(index, index + 4), index);
        else imageData.data.set([...rgb, rgba[index + 3]], index);
      }
    }
    context.putImageData(imageData, 0, 0);
    if (view === 'overlay') { context.globalAlpha = overlayAlpha; context.drawImage(image, 0, 0, source.width, source.height); context.globalAlpha = 1; }
    if (selectedRegion?.sourceId === source.id) {
      const path = structuredClone(selectedRegion.geometry.manualPath ?? selectedRegion.geometry.generatedPath);
      if (draftPoint && selectedPoint !== undefined && path.points[selectedPoint]) path.points[selectedPoint] = { ...path.points[selectedPoint], x: draftPoint.x, y: draftPoint.y };
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
  }, [source?.id, source?.width, source?.height, visibleRegions, documentModel?.parts, masks, selectedRegion, selectedRegionId, selectedPart, view, overlayAlpha, isolate, selectedPoint, draftPoint, tool, brushRadius, renderVersion]);

  const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!source) return { x: 0, y: 0 };
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(source.width, (event.clientX - rect.left) / rect.width * source.width)), y: Math.max(0, Math.min(source.height, (event.clientY - rect.top) / rect.height * source.height)) };
  };
  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!documentModel || busy || !source) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    if (tool === 'select') {
      const hit = [...visibleRegions].reverse().find(region => {
        const mask = masks.get(region.id), x = Math.floor(point.x - region.bounds.x), y = Math.floor(point.y - region.bounds.y);
        return mask && x >= 0 && y >= 0 && x < mask.width && y < mask.height && mask.bytes[y * mask.width + x];
      });
      setSelectedRegionId(hit?.id); setSelectedPartId(hit?.partId); setSelectedPoint(undefined);
    } else if (tool === 'pivot' && selectedPart) {
      void perform([{ op: 'part.setPivot', partId: selectedPart.id, x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 }]);
    } else if (tool === 'path' && selectedRegion) {
      const path = selectedRegion.geometry.manualPath ?? selectedRegion.geometry.generatedPath;
      const nearest = path.points.map((anchor, index) => ({ index, distance: Math.hypot(selectedRegion.bounds.x + anchor.x * selectedRegion.bounds.width - point.x, selectedRegion.bounds.y + anchor.y * selectedRegion.bounds.height - point.y) }))
        .sort((a, b) => a.distance - b.distance)[0];
      if (nearest && nearest.distance < Math.max(5, source.width / 100)) { setSelectedPoint(nearest.index); pointer.current = { tool, points: [point], anchor: nearest.index }; }
    } else if ((tool === 'paint-add' || tool === 'paint-erase') && selectedRegion) {
      pointer.current = { tool, points: [point] }; setRenderVersion(value => value + 1);
    }
  }
  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!pointer.current || !source) return;
    const point = pointFromEvent(event);
    pointer.current.points.push(point);
    if (pointer.current.tool === 'path' && selectedRegion) {
      setDraftPoint({ x: (point.x - selectedRegion.bounds.x) / selectedRegion.bounds.width, y: (point.y - selectedRegion.bounds.y) / selectedRegion.bounds.height });
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
        const x = (point.x - selectedRegion.bounds.x) / selectedRegion.bounds.width, y = (point.y - selectedRegion.bounds.y) / selectedRegion.bounds.height;
        const dx = x - anchor.x, dy = y - anchor.y;
        anchor.x = x; anchor.y = y;
        if (anchor.in) { anchor.in.x += dx; anchor.in.y += dy; }
        if (anchor.out) { anchor.out.x += dx; anchor.out.y += dy; }
        void perform([{ op: 'region.setPath', regionId: selectedRegion.id, path }]);
      }
      setDraftPoint(undefined);
    } else if (stroke.tool === 'paint-add' || stroke.tool === 'paint-erase') {
      const old = masks.get(selectedRegion.id); if (!old) return;
      const mask: RegionMask = { width: old.width, height: old.height, bytes: Uint8Array.from(old.bytes) };
      const points = [...stroke.points, point];
      for (let index = 0; index < points.length; index++) {
        const from = points[Math.max(0, index - 1)], to = points[index];
        const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(1, brushRadius / 2)));
        for (let step = 0; step <= steps; step++) paintDisc(mask, selectedRegion.bounds, from.x + (to.x - from.x) * step / steps, from.y + (to.y - from.y) * step / steps, brushRadius, stroke.tool === 'paint-add' ? 1 : 0);
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
        <div className="divider"/><h2>Regions</h2>
        <div className="scroll-list">{visibleRegions.map(region => <button key={region.id} className={selectedRegionId === region.id ? 'row selected' : 'row'} onClick={() => { setSelectedRegionId(region.id); setSelectedPartId(region.partId); setSelectedPoint(undefined); }}><span><i className="swatch" style={{ background: region.color }}/> {region.id.split('_').slice(-2).join(' ')}</span><small>{region.pixelCount} px · {region.geometry.texture === 'source-crop' ? 'texture' : 'vector'} {region.holeCount ? `· ${region.holeCount} hole` : ''}</small></button>)}</div>
        <div className="divider"/><h2>Parts</h2>
        <div className="scroll-list">{documentModel?.parts.filter(part => part.regionIds.some(id => documentModel.regions.some(region => region.id === id && active(region) && region.sourceId === source?.id))).map(part => <button key={part.id} className={selectedPart?.id === part.id ? 'row selected' : 'row'} onClick={() => { setSelectedPartId(part.id); setSelectedRegionId(part.regionIds.find(id => visibleRegions.some(region => region.id === id))); }}><span>{part.name}</span><small>{part.regionIds.length} region{part.regionIds.length === 1 ? '' : 's'} · pivot {part.pivot.x.toFixed(1)}, {part.pivot.y.toFixed(1)}</small></button>)}</div>
      </aside>
      <main className="center-pane">
        <div className="canvas-toolbar"><div className="segmented">{(['original', 'reconstruction', 'overlay', 'side-by-side'] as View[]).map(item => <button key={item} aria-pressed={view === item} onClick={() => setView(item)}>{item === 'side-by-side' ? 'Side by side' : item[0].toUpperCase() + item.slice(1)}</button>)}</div><label>Tool <select aria-label="Canvas tool" value={tool} onChange={event => setTool(event.target.value as Tool)}><option value="select">Select</option><option value="path">Move path anchor</option><option value="paint-add">Add mask</option><option value="paint-erase">Subtract mask</option><option value="pivot">Set pivot</option></select></label><label><input type="checkbox" checked={isolate} onChange={event => setIsolate(event.target.checked)}/> Isolate</label></div>
        {(tool === 'paint-add' || tool === 'paint-erase' || view === 'overlay') && <div className="canvas-subbar">{tool.startsWith('paint') && <label>Hard brush radius <input aria-label="Brush radius" type="range" min="1" max="40" value={brushRadius} onChange={event => setBrushRadius(Number(event.target.value))}/>{brushRadius}px</label>}{view === 'overlay' && <label>Overlay opacity <input aria-label="Overlay opacity" type="range" min="0" max="1" step="0.05" value={overlayAlpha} onChange={event => setOverlayAlpha(Number(event.target.value))}/></label>}</div>}
        <div className={`canvas-grid ${view === 'side-by-side' ? 'two' : ''}`}>{source ? <>
          {(view === 'original' || view === 'side-by-side') && <div className="canvas-card"><div className="canvas-label">Original · {source.name}</div><canvas ref={originalCanvas}/></div>}
          {(view !== 'original') && <div className="canvas-card"><div className="canvas-label">{view === 'overlay' ? 'Overlay' : 'Reconstruction'} · source masks and geometry</div><canvas ref={reconstructionCanvas} className="interactive-canvas" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}/></div>}
        </> : <div className="empty-state"><div className="empty-art">◇</div><h1>Turn illustrations into editable Hyde art</h1><p>Import a stylized image to get an automatic first pass. Refine regions, inspect uncertainty, and export a native project or assembly.</p><label className="button accent">Choose images<input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={importImages}/></label></div>}</div>
        {previewUrl && <div className="native-preview">
          <div className="section-heading"><h3>Native Hyde render · primary reference</h3><button onClick={clearNativePreview}>Close</button></div>
          <div className="native-preview-visual"><img alt="Native Hyde render of current export" src={previewUrl}/>{showResidual && residualUrl && <img className="residual-image" alt="Native residual overlay" src={residualUrl}/>}</div>
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
        {documentModel && <><label>Mode<select aria-label="Reconstruction mode" value={documentModel.mode} onChange={async event => { if (busy) return; setBusy(true); try { checkpoint.current = (await client.current.call<{ bytes: Uint8Array }>('save')).bytes; const state = await client.current.call<WorkerState>('analyze', { mode: event.target.value }); await refresh(state); setStatus(`Switched to ${event.target.value}. Locks and manual edits retained.`); } catch (error) { setStatus(error instanceof Error ? error.message : 'Mode change failed.'); } finally { setBusy(false); } }}><option value="appearance">Appearance first</option><option value="animation-ready">Animation ready</option></select></label>
          <label>Color granularity <input aria-label="Color granularity" type="range" min="8" max="96" value={documentModel.settings.colorStep} onChange={event => setDocumentModel({ ...documentModel, settings: { ...documentModel.settings, colorStep: Number(event.target.value) } })}/><span>{documentModel.settings.colorStep}</span></label>
          <label>Path tolerance <input aria-label="Path tolerance" type="range" min="0" max="8" step="0.25" value={documentModel.settings.pathTolerance} onChange={event => setDocumentModel({ ...documentModel, settings: { ...documentModel.settings, pathTolerance: Number(event.target.value) } })}/><span>{documentModel.settings.pathTolerance}</span></label>
          <button disabled={busy} onClick={async () => { if (!documentModel) return; setBusy(true); try { checkpoint.current = (await client.current.call<{ bytes: Uint8Array }>('save')).bytes; const state = await client.current.call<WorkerState>('analyze', { settings: documentModel.settings }); await refresh(state); setStatus('Reconstruction settings applied; locked edits retained.'); } catch (error) { setStatus(error instanceof Error ? error.message : 'Reanalysis failed.'); } finally { setBusy(false); } }}>Apply settings</button>
          <button disabled={busy} onClick={() => void analyzeAgain()}>Regenerate first pass</button>
        </>}
        <div className="divider"/>
        <h2>Selected region</h2>{selectedRegion ? <div className="inspector"><p className="identity">{selectedRegion.id}</p><p>{selectedRegion.bounds.width} × {selectedRegion.bounds.height} at {selectedRegion.bounds.x}, {selectedRegion.bounds.y} · {selectedRegion.geometry.quality.pathPointCount} anchors</p><p className="hint">Evidence: {selectedRegion.confidence.reasons.join('; ')}</p>
          <label>Assign to part<select aria-label="Assign to part" value={selectedRegion.partId ?? ''} onChange={event => { if (event.target.value) void perform([{ op: 'part.assignRegion', regionId: selectedRegion.id, partId: event.target.value }]); }}><option value="">Unassigned</option>{documentModel?.parts.map(part => <option key={part.id} value={part.id}>{part.name}</option>)}</select></label>
          <p className="hint">Hard mask brush edits within this region’s current bounds. Split or merge regions to change topology.</p>
          <label><input type="checkbox" checked={selectedRegion.locked.mask} onChange={event => void perform([{ op: 'annotation.lock', regionId: selectedRegion.id, target: 'mask', locked: event.target.checked }])}/> Lock mask</label>
          <label><input type="checkbox" checked={selectedRegion.locked.geometry} onChange={event => void perform([{ op: 'annotation.lock', regionId: selectedRegion.id, target: 'geometry', locked: event.target.checked }])}/> Lock path</label>
          <label><input type="checkbox" checked={selectedRegion.locked.part} onChange={event => void perform([{ op: 'annotation.lock', regionId: selectedRegion.id, target: 'part', locked: event.target.checked }])}/> Lock part assignment</label>
          <div className="inline-actions"><button disabled={busy} onClick={() => void perform([{ op: 'region.split', regionId: selectedRegion.id, axis: 'x', coordinate: selectedRegion.bounds.x + selectedRegion.bounds.width / 2 }])}>Split vertical</button><button disabled={busy} onClick={() => void perform([{ op: 'region.split', regionId: selectedRegion.id, axis: 'y', coordinate: selectedRegion.bounds.y + selectedRegion.bounds.height / 2 }])}>Split horizontal</button></div>
          <label>Merge with<select aria-label="Merge target" value={mergeTarget ?? ''} onChange={event => setMergeTarget(event.target.value)}><option value="">Choose region</option>{visibleRegions.filter(item => item.id !== selectedRegion.id).map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><button disabled={!mergeTarget || busy} onClick={() => { if (mergeTarget) void perform([{ op: 'region.merge', firstId: selectedRegion.id, secondId: mergeTarget }]); }}>Merge selected</button>
          <button disabled={busy} onClick={() => void perform([{ op: 'regenerate.selected', regionIds: [selectedRegion.id] }])}>Regenerate selected path</button>
          <label>Front of<select aria-label="Layer target" value={relationTarget ?? ''} onChange={event => setRelationTarget(event.target.value)}><option value="">Choose region</option>{visibleRegions.filter(item => item.id !== selectedRegion.id).map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><button disabled={!relationTarget || busy} onClick={() => { if (relationTarget) void perform([{ op: 'layer.setRelation', frontRegionId: selectedRegion.id, backRegionId: relationTarget, approved: true }]); }}>Approve front relation</button>
          {alternateRegions.length > 0 && primaryRegions.some(item => item.id === selectedRegion.id) && <><label>Match alternate region<select aria-label="Alternate match" value={matchTarget ?? ''} onChange={event => setMatchTarget(event.target.value)}><option value="">Choose region</option>{alternateRegions.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><button disabled={!matchTarget || busy} onClick={() => { const other = alternateRegions.find(item => item.id === matchTarget); if (other) void perform([{ op: 'reference.correspond', correspondence: { id: `${selectedRegion.id}_manual_${other.id}`, sourceIds: [selectedRegion.sourceId, other.sourceId], regionIds: [selectedRegion.id, other.id], kind: 'same-part', origin: 'manual', evidence: ['user confirmed'], accepted: true } }]); }}>Confirm match</button></>}
        </div> : <p className="hint">Select a region on the canvas or in the outliner.</p>}
        <div className="divider"/><h2>Selected part</h2>{selectedPart ? <div className="inspector"><label>Name<input aria-label="Part name" key={`${selectedPart.id}-${selectedPart.name}`} defaultValue={selectedPart.name} onBlur={event => { if (event.target.value !== selectedPart.name) void perform([{ op: 'part.rename', partId: selectedPart.id, name: event.target.value }]); }}/></label>
          <div className="columns"><label>Pivot X<input aria-label="Pivot X" type="number" key={`${selectedPart.id}-x-${selectedPart.pivot.x}`} defaultValue={selectedPart.pivot.x} onBlur={event => void perform([{ op: 'part.setPivot', partId: selectedPart.id, x: Number(event.target.value), y: selectedPart.pivot.y }])}/></label><label>Pivot Y<input aria-label="Pivot Y" type="number" key={`${selectedPart.id}-y-${selectedPart.pivot.y}`} defaultValue={selectedPart.pivot.y} onBlur={event => void perform([{ op: 'part.setPivot', partId: selectedPart.id, x: selectedPart.pivot.x, y: Number(event.target.value) }])}/></label></div>
          <label><input type="checkbox" checked={selectedPart.pivotLocked} onChange={event => void perform([{ op: 'annotation.lock', partId: selectedPart.id, target: 'pivot', locked: event.target.checked }])}/> Lock pivot</label>
          <label>Parent part<select aria-label="Parent part" value={selectedPart.parentId ?? ''} onChange={event => void perform([{ op: 'part.reparent', partId: selectedPart.id, parentId: event.target.value || undefined }])}><option value="">Assembly root</option>{documentModel?.parts.filter(item => item.id !== selectedPart.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Attachment<select aria-label="Attachment type" value={selectedPart.attachment?.type ?? 'none'} onChange={event => void perform([{ op: 'part.setAttachment', partId: selectedPart.id, type: event.target.value === 'none' ? undefined : event.target.value as 'fixed' | 'hinge' | 'slider', approved: event.target.value !== 'none' }])}><option value="none">Unattached</option><option value="fixed">Fixed</option><option value="hinge">Hinge</option><option value="slider">Slider</option></select></label>
          {selectedPart.attachment && selectedPart.attachment.type !== 'fixed' && <div className="columns"><label>Min<input aria-label="Joint minimum" type="number" defaultValue={selectedPart.attachment.min ?? ''} onBlur={event => void perform([{ op: 'part.setAttachment', partId: selectedPart.id, type: selectedPart.attachment!.type, min: event.target.value === '' ? undefined : Number(event.target.value), max: selectedPart.attachment!.max, approved: true }])}/></label><label>Max<input aria-label="Joint maximum" type="number" defaultValue={selectedPart.attachment.max ?? ''} onBlur={event => void perform([{ op: 'part.setAttachment', partId: selectedPart.id, type: selectedPart.attachment!.type, min: selectedPart.attachment!.min, max: event.target.value === '' ? undefined : Number(event.target.value), approved: true }])}/></label></div>}
          <label>Move region to<select aria-label="Move region to part" value={partTarget ?? ''} onChange={event => setPartTarget(event.target.value)}><option value="">Choose part</option>{documentModel?.parts.filter(item => item.id !== selectedPart.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <button disabled={!partTarget || !selectedRegion || busy} onClick={() => { if (partTarget && selectedRegion) void perform([{ op: 'part.assignRegion', regionId: selectedRegion.id, partId: partTarget }]); }}>Reassign region</button>
        </div> : <p className="hint">Parts keep stable IDs as regions are refined.</p>}
        {documentModel && <div className="inspector"><button disabled={busy} onClick={() => { const id = `manual_part_${Date.now()}`; void perform([{ op: 'part.create', id, name: `Part ${documentModel.parts.length + 1}`, regionIds: selectedRegion ? [selectedRegion.id] : [] }]); }}>New part {selectedRegion ? 'from region' : ''}</button></div>}
        <div className="divider"/><h2>Native delivery</h2><div className="inspector"><label>Format<select aria-label="Export format" value={exportFormat} onChange={event => setExportFormat(event.target.value as 'hyde' | 'hyproj')}><option value="hyproj">Editable assembly · .hyproj</option><option value="hyde">Editable story · .hyde</option></select></label><label><input type="checkbox" checked={allowHoleApproximation} onChange={event => setAllowHoleApproximation(event.target.checked)}/> Allow raster-backed hole approximation</label><div className="inline-actions"><button disabled={!documentModel || busy} onClick={() => void nativeExport(true)}>Preview in Hyde</button><button className="accent" disabled={!documentModel || busy} onClick={() => void nativeExport(false)}>Export</button></div></div>
      </aside>
    </div>
    <footer className="diagnostics"><strong>Diagnostics</strong><div className="diagnostic-list">{documentModel?.diagnostics.length ? documentModel.diagnostics.map((item, index) => <div key={`${item.code}-${index}`} className={`diagnostic ${item.severity}`}><b>{item.code}</b><span>{item.message}</span>{item.suggestion && <small>{item.suggestion}</small>}</div>) : <span className="hint">No diagnostics yet. Automatic suggestions are heuristic evidence, not certainty.</span>}</div></footer>
  </div>;
}
