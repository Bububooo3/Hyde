/// <reference lib="webworker" />
import { DecompositionSession } from '../decomposer';
import type { DecompositionEdit, HydeDecompositionExportOptions, RegionMask, SourceInput } from '../decomposer';
import { compareNativeRender } from '../decomposer/quality';

type Request = { id: number; type: string; payload?: any };
let session: DecompositionSession | undefined;
const requireSession = () => session ?? (() => { throw new Error('Import or open a decomposition document first.'); })();

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
    } else if (type === 'analyze') {
      const running = requireSession();
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
      result = doc.regions.filter(region => region.sourceId === payload.sourceId && region.generationStatus !== 'historical')
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
