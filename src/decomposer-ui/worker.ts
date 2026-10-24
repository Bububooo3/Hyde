/// <reference lib="webworker" />
import { DecompositionSession } from '../decomposer';
import type { DecompositionEdit, DecompositionDocumentV1, HydeDecompositionExportOptions, RegionMask, RegionRecord, SourceInput } from '../decomposer';
import { compareNativeRender } from '../decomposer/quality';

type Request = { id: number; type: string; payload?: any };
let session: DecompositionSession | undefined;
const requireSession = () => session ?? (() => { throw new Error('Import or open a decomposition document first.'); })();
const active = (region: RegionRecord) => region.generationStatus !== 'historical' && !region.suppressed;
const protectedByUser = (region: RegionRecord) => region.generationStatus === 'manual' || Boolean(region.geometry.manualPath) ||
  region.locked.mask || region.locked.geometry || region.locked.part;

function sameMask(first: RegionMask, second: RegionMask): boolean {
  if (first.width !== second.width || first.height !== second.height || first.bytes.length !== second.bytes.length ||
      Boolean(first.alpha) !== Boolean(second.alpha)) return false;
  for (let index = 0; index < first.bytes.length; index++)
    if (first.bytes[index] !== second.bytes[index] || (first.alpha && second.alpha && first.alpha[index] !== second.alpha[index])) return false;
  return true;
}

function sameEffectiveRegion(before: RegionRecord, after: RegionRecord, original: DecompositionSession, preview: DecompositionSession): boolean {
  const visible = (region: RegionRecord) => ({ bounds: region.bounds, color: region.color, classification: region.classification,
    pixelCount: region.pixelCount, holeCount: region.holeCount, partId: region.partId,
    status: region.geometry.status, texture: region.geometry.texture,
    path: region.geometry.manualPath ?? region.geometry.generatedPath });
  return JSON.stringify(visible(before)) === JSON.stringify(visible(after)) &&
    sameMask(original.maskFor(before.maskId), preview.maskFor(after.maskId));
}

function regenerationImpact(before: DecompositionDocumentV1, after: DecompositionDocumentV1,
  original: DecompositionSession, preview: DecompositionSession) {
  const oldRegions = new Map(before.regions.filter(active).map(region => [region.id, region]));
  const newRegions = new Map(after.regions.filter(active).map(region => [region.id, region]));
  const addedIds = [...newRegions.keys()].filter(id => !oldRegions.has(id));
  const changedUnlockedIds: string[] = [], removedUnlockedIds: string[] = [], retainedUnlockedIds: string[] = [];
  const retainedProtectedIds: string[] = [], changedProtectedIds: string[] = [], removedProtectedIds: string[] = [];
  for (const [id, oldRegion] of oldRegions) {
    const next = newRegions.get(id), protectedRegion = protectedByUser(oldRegion);
    if (!next) (protectedRegion ? removedProtectedIds : removedUnlockedIds).push(id);
    else if (sameEffectiveRegion(oldRegion, next, original, preview))
      (protectedRegion ? retainedProtectedIds : retainedUnlockedIds).push(id);
    else (protectedRegion ? changedProtectedIds : changedUnlockedIds).push(id);
  }
  return { mode: after.mode, settings: after.settings, beforeActiveCount: oldRegions.size, afterActiveCount: newRegions.size,
    addedIds, changedUnlockedIds, removedUnlockedIds, retainedUnlockedIds,
    retainedProtectedIds, changedProtectedIds, removedProtectedIds, diagnosticCount: after.diagnostics.length };
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, type, payload } = event.data;
  try {
    let result: unknown;
    const transfers: Transferable[] = [];
    if (type === 'import') {
      await session?.close();
      session = await DecompositionSession.importSources(payload.inputs as SourceInput[], payload.options);
      result = { revision: session.revision, document: session.snapshot() };
    } else if (type === 'open') {
      await session?.close();
      session = await DecompositionSession.openDocument(payload.bytes);
      result = { revision: session.revision, document: session.snapshot() };
    } else if (type === 'regeneration.preview') {
      const running = requireSession();
      if (payload.expectedRevision !== running.revision) throw new Error('The document changed before the regeneration preview. Preview it again.');
      const before = running.snapshot();
      const preview = await DecompositionSession.openDocument(await running.saveDocument());
      try {
        let remapped: Record<string, string> = {};
        if (payload.kind === 'selected') {
          const edit: DecompositionEdit = { op: 'regenerate.selected', regionIds: payload.regionIds, settings: payload.settings };
          const outcome = await preview.execute({ expectedRevision: preview.revision, edits: [edit] });
          if (!outcome.ok) throw new Error(outcome.error?.message ?? 'Selected regeneration preview failed.');
        } else if (payload.kind === 'analysis') {
          const outcome = await preview.analyze({ mode: payload.mode, settings: payload.settings });
          remapped = outcome.remapped;
        } else throw new Error('Unknown regeneration preview type.');
        const after = preview.snapshot();
        result = { baseRevision: running.revision, kind: payload.kind, remapped,
          ...regenerationImpact(before, after, running, preview) };
      } finally { await preview.close(); }
    } else if (type === 'analyze') {
      const running = requireSession();
      if (payload.expectedRevision !== undefined && payload.expectedRevision !== running.revision)
        throw new Error('The document changed after the regeneration preview. Preview it again.');
      const analysis = await running.analyze(payload);
      result = { analysis, revision: running.revision, document: running.snapshot() };
    } else if (type === 'snapshot') result = { revision: requireSession().revision, document: requireSession().snapshot() };
    else if (type === 'execute') {
      const running = requireSession();
      const edits: DecompositionEdit[] = payload.edits;
      if (payload.mask) {
        const mask = payload.mask as RegionMask;
        const handle = running.stageMask(mask);
        for (const edit of edits) if (edit.op === 'region.refineMask') edit.handle = handle;
      }
      const editResult = await running.execute({ expectedRevision: payload.expectedRevision, edits, dryRun: payload.dryRun });
      result = { result: editResult, revision: running.revision, document: running.snapshot() };
    } else if (type === 'undo' || type === 'redo') {
      const running = requireSession();
      const changed = type === 'undo' ? running.undo(payload.expectedRevision) : running.redo(payload.expectedRevision);
      result = { changed, revision: running.revision, document: running.snapshot() };
    } else if (type === 'save') result = { bytes: await requireSession().saveDocument() };
    else if (type === 'export') {
      const exported = await requireSession().exportHyde(payload.options as HydeDecompositionExportOptions);
      result = exported;
    } else if (type === 'source') result = { bytes: requireSession().sourceBytesFor(payload.id) };
    else if (type === 'masks') {
      const running = requireSession(), doc = running.snapshot();
      result = doc.regions.filter(region => region.sourceId === payload.sourceId && region.generationStatus !== 'historical' && !region.suppressed)
        .map(region => ({ id: region.id, mask: running.maskFor(region.maskId) }));
    } else if (type === 'mask') result = { mask: requireSession().maskFor(payload.id) };
    else if (type === 'compare') result = requireSession().compare();
    else if (type === 'native.compare') {
      const running = requireSession(), document = running.snapshot();
      const primary = document.sources.find(source => source.role === 'primary');
      if (!primary) throw new Error('Primary reference is missing.');
      const { residualOverlayPng, ...report } = compareNativeRender(running.sourcePixelsFor(primary.id), payload.renderedPng as Uint8Array, document);
      result = { report, overlayPng: residualOverlayPng };
      if (residualOverlayPng.buffer instanceof ArrayBuffer) transfers.push(residualOverlayPng.buffer);
    }
    else throw new Error(`Unknown decomposer worker operation ${type}.`);
    self.postMessage({ id, ok: true, result }, transfers);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : 'Decomposition operation failed.' });
  }
};
