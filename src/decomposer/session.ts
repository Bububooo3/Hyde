import type { ShapePath } from '../model';
import { analyzeImage, ALGORITHM_VERSION, fitMaskGeometry, proposeCorrespondences } from './analysis';
import { decodeDecompositionDocument, encodeDecompositionDocument, sha256, validateDecompositionDocument } from './codec';
import { exportNativeDecomposition } from './export';
import type { HydeDecompositionExport, HydeDecompositionExportOptions } from './export';
import { decodeSource } from './image';
import type { DecodedImage } from './image';
import { defaultSettings } from './types';
import type { CorrespondenceRecord, DecompositionDocumentV1, DecompositionMode, LayerRecord, PartRecord, ReconstructionSettings, RegionMask, RegionRecord, SourceInput, SourceReference } from './types';

export type DecompositionEdit =
  | { op: 'region.setPath'; regionId: string; path: ShapePath }
  | { op: 'region.refineMask'; regionId: string; handle: string }
  | { op: 'region.split'; regionId: string; axis: 'x' | 'y'; coordinate: number }
  | { op: 'region.merge'; firstId: string; secondId: string }
  | { op: 'part.create'; id: string; name: string; regionIds?: string[] }
  | { op: 'part.assignRegion'; partId: string; regionId: string }
  | { op: 'part.rename'; partId: string; name: string }
  | { op: 'part.setPivot'; partId: string; x: number; y: number }
  | { op: 'part.reparent'; partId: string; parentId?: string }
  | { op: 'part.setAttachment'; partId: string; type?: 'fixed' | 'hinge' | 'slider'; min?: number; max?: number; approved?: boolean }
  | { op: 'layer.setRelation'; frontRegionId: string; backRegionId: string; approved: boolean }
  | { op: 'reference.correspond'; correspondence: CorrespondenceRecord }
  | { op: 'annotation.lock'; regionId?: string; partId?: string; target: 'mask' | 'geometry' | 'part' | 'pivot' | 'transform'; locked: boolean }
  | { op: 'regenerate.selected'; regionIds: string[]; settings?: Partial<ReconstructionSettings> };

export interface DecompositionEditResult {
  ok: boolean;
  revision: number;
  changedIds?: string[];
  error?: { code: string; message: string };
}
interface Snapshot { document: DecompositionDocumentV1; masks: Map<string, RegionMask> }
const cloneMaskMap = (masks: Map<string, RegionMask>): Map<string, RegionMask> => new Map([...masks].map(([id, mask]) => [id, { width: mask.width, height: mask.height, bytes: Uint8Array.from(mask.bytes) }]));
const active = (region: RegionRecord) => region.generationStatus !== 'historical';
const fail = (message: string): never => { throw new Error(message); };
const finite = (value: number) => Number.isFinite(value) || fail('Coordinate must be finite.');

function refreshPartBounds(document: DecompositionDocumentV1): void {
  for (const part of document.parts) {
    const owned = document.regions.filter(region => active(region) && region.partId === part.id);
    part.regionIds = owned.map(region => region.id);
    if (!owned.length) continue;
    const x = Math.min(...owned.map(region => region.bounds.x)), y = Math.min(...owned.map(region => region.bounds.y));
    const right = Math.max(...owned.map(region => region.bounds.x + region.bounds.width));
    const bottom = Math.max(...owned.map(region => region.bounds.y + region.bounds.height));
    part.bounds = { x, y, width: right - x, height: bottom - y };
  }
}

function maskOverlap(a: RegionRecord, am: RegionMask, b: RegionRecord, bm: RegionMask): number {
  const x0 = Math.max(a.bounds.x, b.bounds.x), y0 = Math.max(a.bounds.y, b.bounds.y);
  const x1 = Math.min(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width), y1 = Math.min(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height);
  let intersection = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const ai = (y - a.bounds.y) * am.width + x - a.bounds.x;
    const bi = (y - b.bounds.y) * bm.width + x - b.bounds.x;
    if (am.bytes[ai] && bm.bytes[bi]) intersection++;
  }
  return intersection / Math.max(1, a.pixelCount + b.pixelCount - intersection);
}

export class DecompositionSession {
  private document: DecompositionDocumentV1;
  private sourceBytes: Map<string, Uint8Array>;
  private images: Map<string, DecodedImage>;
  private masks: Map<string, RegionMask>;
  private stagedMasks = new Map<string, RegionMask>();
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private currentRevision = 0;
  private closed = false;

  private constructor(document: DecompositionDocumentV1, sourceBytes: Map<string, Uint8Array>, images: Map<string, DecodedImage>, masks: Map<string, RegionMask>) {
    this.document = document; this.sourceBytes = sourceBytes; this.images = images; this.masks = masks;
    this.currentRevision = document.history.reduce((latest, event) => Math.max(latest, event.revision), 0);
  }

  static async importSources(inputs: SourceInput[], options: { mode?: DecompositionMode; name?: string; settings?: Partial<ReconstructionSettings> } = {}): Promise<DecompositionSession> {
    if (!inputs.length || inputs.length > 32) throw new Error('At least one and at most 32 source images are required.');
    const mode = options.mode ?? 'appearance';
    const now = new Date().toISOString(), settings = { ...defaultSettings(mode), ...options.settings };
    const sources: SourceReference[] = [], bytes = new Map<string, Uint8Array>(), images = new Map<string, DecodedImage>();
    let totalPixels = 0;
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index];
      const image = await decodeSource(input);
      totalPixels += image.width * image.height;
      if (totalPixels > 12_000_000) throw new Error('IMAGE_TOO_LARGE: Source set exceeds the 12 million pixel session budget.');
      const hash = await sha256(input.bytes), pixelHash = await sha256(image.rgba);
      const id = `source_${String(index + 1).padStart(2, '0')}_${hash.slice(0, 12)}`;
      let transparent = 0; for (let pixel = 0; pixel < image.width * image.height; pixel++) if (image.rgba[pixel * 4 + 3] < 255) transparent++;
      sources.push({ id, role: input.role ?? (index === 0 ? 'primary' : 'alternate-view'), name: input.name, mime: input.mime as SourceReference['mime'], byteHash: hash, pixelHash, byteLength: input.bytes.length, width: image.width, height: image.height, orientation: 'oriented', colorSpace: 'srgb-assumed', alphaFraction: transparent / (image.width * image.height) });
      bytes.set(id, Uint8Array.from(input.bytes)); images.set(id, image);
    }
    if (sources.filter(source => source.role === 'primary').length !== 1) throw new Error('Exactly one primary source is required.');
    const docId = `doc_${sources[0].byteHash.slice(0, 16)}`;
    const document: DecompositionDocumentV1 = {
      format: 'hyde-decomposition', schemaVersion: 1, id: docId, name: options.name ?? inputs[0].name.replace(/\.[^.]+$/, ''), createdAt: now, updatedAt: now,
      algorithmVersion: ALGORITHM_VERSION, mode, settings, sources, regions: [], parts: [], correspondences: [], layers: [], diagnostics: [], history: [],
    };
    validateDecompositionDocument(document, bytes, new Map(), new Map([...images].map(([id, image]) => [id, image.rgba])));
    return new DecompositionSession(document, bytes, images, new Map());
  }

  static async openDocument(archive: Uint8Array): Promise<DecompositionSession> {
    const { document, sourceBytes, masks, pixels } = await decodeDecompositionDocument(archive);
    const images = new Map<string, DecodedImage>();
    for (const source of document.sources) images.set(source.id, { width: source.width, height: source.height, rgba: pixels.get(source.id)! });
    return new DecompositionSession(document, sourceBytes, images, masks);
  }
  get revision(): number { return this.currentRevision; }
  private ensureOpen() { if (this.closed) throw new Error('Decomposition session is closed.'); }
  snapshot(): DecompositionDocumentV1 { this.ensureOpen(); return structuredClone(this.document); }
  capabilities() { return { format: 'hydecomp' as const, schemaVersion: 1 as const, algorithmVersion: ALGORITHM_VERSION, modes: ['appearance', 'animation-ready'] as const, sourceFormats: ['image/png', 'image/jpeg', 'image/webp'] as const, maxPixelsPerSource: 4_000_000, nativeExports: ['hyde', 'hyproj'] as const, motionGeneration: false as const }; }
  sourceBytesFor(id: string): Uint8Array { this.ensureOpen(); const bytes = this.sourceBytes.get(id); if (!bytes) throw new Error('Source does not exist.'); return Uint8Array.from(bytes); }
  sourcePixelsFor(id: string): DecodedImage {
    this.ensureOpen(); const image = this.images.get(id);
    if (!image) throw new Error('Source does not exist.');
    return { width: image.width, height: image.height, rgba: Uint8Array.from(image.rgba) };
  }
  maskFor(id: string): RegionMask { this.ensureOpen(); const mask = this.masks.get(id); if (!mask) throw new Error('Mask does not exist.'); return { width: mask.width, height: mask.height, bytes: Uint8Array.from(mask.bytes) }; }
  stageMask(mask: RegionMask): string {
    this.ensureOpen();
    if (!Number.isInteger(mask.width) || !Number.isInteger(mask.height) || mask.width < 1 || mask.height < 1 || mask.width * mask.height > 4_000_000 || mask.bytes.length !== mask.width * mask.height || mask.bytes.some(byte => byte !== 0 && byte !== 1)) throw new Error('Invalid binary mask.');
    const handle = `mask_handle_${this.currentRevision}_${this.stagedMasks.size + 1}`;
    this.stagedMasks.set(handle, { width: mask.width, height: mask.height, bytes: Uint8Array.from(mask.bytes) });
    return handle;
  }
  discardMask(handle: string) { this.stagedMasks.delete(handle); }

  async analyze(options: { mode?: DecompositionMode; settings?: Partial<ReconstructionSettings>; signal?: AbortSignal } = {}): Promise<{ revision: number; regionCount: number; diagnostics: DecompositionDocumentV1['diagnostics']; remapped: Record<string, string> }> {
    this.ensureOpen();
    const mode = options.mode ?? this.document.mode;
    const settings = { ...(options.mode && options.mode !== this.document.mode ? defaultSettings(mode) : this.document.settings), ...options.settings };
    const fingerprint = await sha256(new TextEncoder().encode(JSON.stringify(settings)));
    const previous = this.document, priorMasks = this.masks;
    const candidate = structuredClone(previous), masks = cloneMaskMap(priorMasks);
    candidate.mode = mode; candidate.settings = settings; candidate.regions = []; candidate.parts = []; candidate.layers = []; candidate.diagnostics = [];
    const remapped: Record<string, string> = {}, matched = new Set<string>();
    for (const source of candidate.sources) {
      if (options.signal?.aborted) throw new Error('CANCELED');
      const result = analyzeImage(this.images.get(source.id)!, source, mode, settings, fingerprint, options.signal);
      const old = previous.regions.filter(region => region.sourceId === source.id && active(region));
      const localIds = new Map<string, string>();
      for (const region of result.regions) {
        const generatedId = region.id;
        const mask = result.masks.get(region.maskId)!;
        const best = old.filter(item => !matched.has(item.id)).map(item => ({ item, overlap: maskOverlap(item, priorMasks.get(item.maskId)!, region, mask) }))
          .sort((a, b) => b.overlap - a.overlap || a.item.id.localeCompare(b.item.id))[0];
        if (best && best.overlap >= .3) {
          const oldRegion = best.item, oldId = oldRegion.id, oldMaskId = oldRegion.maskId;
          matched.add(oldId); remapped[oldId] = oldId;
          result.masks.delete(region.maskId);
          region.id = oldId; region.maskId = oldMaskId;
          region.geometry.id = oldRegion.geometry.id;
          region.geometry.manualPath = oldRegion.geometry.manualPath;
          region.geometry.locked = oldRegion.geometry.locked;
          region.locked = structuredClone(oldRegion.locked);
          region.partId = oldRegion.partId;
          region.lineage = structuredClone(oldRegion.lineage);
          region.originalMaskId = oldRegion.originalMaskId;
          const preserveMask = oldRegion.locked.mask || oldRegion.generationStatus === 'manual' || Boolean(oldRegion.originalMaskId);
          if (preserveMask) {
            Object.assign(region, { bounds: oldRegion.bounds, pixelCount: oldRegion.pixelCount, holeCount: oldRegion.holeCount });
            masks.set(oldMaskId, priorMasks.get(oldMaskId)!);
            region.geometry = structuredClone(oldRegion.geometry);
            region.generationStatus = oldRegion.generationStatus;
          } else masks.set(oldMaskId, mask);
          if (oldRegion.locked.geometry) region.geometry = structuredClone(oldRegion.geometry);
        } else {
          let freshId = region.id, suffix = 1;
          while (previous.regions.some(item => item.id === freshId) || candidate.regions.some(item => item.id === freshId)) freshId = `${region.id}_v${suffix++}`;
          if (freshId !== region.id) { result.masks.delete(region.maskId); region.id = freshId; region.maskId = `${freshId}_mask`; region.geometry.id = `${freshId}_geometry`; }
          masks.set(region.maskId, mask);
        }
        localIds.set(generatedId, region.id);
        candidate.regions.push(region);
      }
      for (const region of result.regions) region.adjacency = region.adjacency.map(edge => ({ ...edge, regionId: localIds.get(edge.regionId) ?? edge.regionId }));
      candidate.layers.push(...result.layers.map(layer => ({
        ...layer, id: `${localIds.get(layer.frontRegionId) ?? layer.frontRegionId}_front_${localIds.get(layer.backRegionId) ?? layer.backRegionId}`,
        frontRegionId: localIds.get(layer.frontRegionId) ?? layer.frontRegionId,
        backRegionId: localIds.get(layer.backRegionId) ?? layer.backRegionId,
      })));
      candidate.diagnostics.push(...result.diagnostics);
    }
    // Keep unmatched old regions as historical evidence and keep their exact masks.
    for (const region of previous.regions) if (!matched.has(region.id) && !candidate.regions.some(item => item.id === region.id)) candidate.regions.push({ ...structuredClone(region), generationStatus: 'historical' });
    const priorParts = new Map(previous.parts.map(part => [part.id, part]));
    const nextParts = new Map<string, PartRecord>();
    for (const region of candidate.regions.filter(active)) {
      if (!region.partId) continue;
      const previousPart = priorParts.get(region.partId);
      if (previousPart) nextParts.set(previousPart.id, structuredClone(previousPart));
      else if (!nextParts.has(region.partId)) nextParts.set(region.partId, {
        id: region.partId, name: `Part ${nextParts.size + 1}`, regionIds: [], bounds: region.bounds, pivot: { x: region.bounds.x + region.bounds.width / 2, y: region.bounds.y + region.bounds.height / 2 }, pivotLocked: false,
        attachmentApproved: false, hiddenGeometry: 'none', zOrder: nextParts.size, transformLocked: false,
      });
    }
    for (const part of priorParts.values()) if (!nextParts.has(part.id)) nextParts.set(part.id, structuredClone(part));
    candidate.parts = [...nextParts.values()];
    refreshPartBounds(candidate);
    const liveIds = new Set(candidate.regions.filter(active).map(region => region.id));
    candidate.layers = [
      ...candidate.layers.filter(layer => !previous.layers.some(old => old.origin === 'manual' && old.id === layer.id)),
      ...previous.layers.filter(layer => layer.origin === 'manual' && liveIds.has(layer.frontRegionId) && liveIds.has(layer.backRegionId)),
    ];
    const primary = candidate.sources.find(source => source.role === 'primary')!;
    candidate.correspondences = previous.correspondences.filter(item => item.origin === 'manual');
    const manualCorrespondenceIds = new Set(candidate.correspondences.map(item => item.id));
    for (const source of candidate.sources.filter(item => item.id !== primary.id)) candidate.correspondences.push(...proposeCorrespondences(candidate.regions.filter(region => region.sourceId === primary.id && active(region)), candidate.regions.filter(region => region.sourceId === source.id && active(region))).filter(item => !manualCorrespondenceIds.has(item.id)));
    candidate.updatedAt = new Date().toISOString();
    validateDecompositionDocument(candidate, this.sourceBytes, masks, new Map([...this.images].map(([id, image]) => [id, image.rgba])));
    if (options.signal?.aborted) throw new Error('CANCELED');
    this.saveUndo(); this.document = candidate; this.masks = masks; this.currentRevision++;
    this.document.history.push({ revision: this.currentRevision, operation: 'analyze', at: candidate.updatedAt, affectedIds: candidate.regions.filter(active).map(item => item.id) });
    return { revision: this.currentRevision, regionCount: candidate.regions.filter(active).length, diagnostics: structuredClone(candidate.diagnostics), remapped };
  }

  inspect(query: { target: 'summary' | 'sources' | 'regions' | 'parts' | 'region' | 'part' | 'diagnostics' | 'correspondences'; id?: string; limit?: number; cursor?: number }) {
    this.ensureOpen();
    const limit = Math.max(1, Math.min(100, query.limit ?? 25)), cursor = Math.max(0, Math.floor(query.cursor ?? 0));
    if (query.target === 'summary') return { revision: this.revision, id: this.document.id, mode: this.document.mode, sourceCount: this.document.sources.length, regionCount: this.document.regions.filter(active).length, partCount: this.document.parts.length, diagnosticCount: this.document.diagnostics.length };
    if (query.target === 'region') return { revision: this.revision, region: structuredClone(this.document.regions.find(item => item.id === query.id)) };
    if (query.target === 'part') return { revision: this.revision, part: structuredClone(this.document.parts.find(item => item.id === query.id)) };
    const list = query.target === 'sources' ? this.document.sources : query.target === 'parts' ? this.document.parts : query.target === 'diagnostics' ? this.document.diagnostics : query.target === 'correspondences' ? this.document.correspondences : this.document.regions.filter(active);
    return { revision: this.revision, items: structuredClone(list.slice(cursor, cursor + limit)), nextCursor: cursor + limit < list.length ? cursor + limit : undefined };
  }
  compare() {
    this.ensureOpen();
    const regions = this.document.regions.filter(active);
    return { kind: 'geometry-to-mask' as const, regionCount: regions.length, meanSampledMaskIoU: regions.length ? regions.reduce((sum, region) => sum + region.geometry.quality.maskIoU, 0) / regions.length : 0,
      pointCount: regions.reduce((sum, region) => sum + (region.geometry.manualPath ?? region.geometry.generatedPath).points.length, 0),
      limitations: ['Native Hyde renderer color, texture and compositing comparison requires a browser preview host.'] };
  }
  async saveDocument(): Promise<Uint8Array> {
    this.ensureOpen();
    return encodeDecompositionDocument(this.document, this.sourceBytes, this.masks, new Map([...this.images].map(([id, image]) => [id, image.rgba])));
  }
  async exportHyde(options: HydeDecompositionExportOptions): Promise<HydeDecompositionExport> {
    this.ensureOpen(); return exportNativeDecomposition(this.document, this.masks, this.images, options);
  }
  private saveUndo() { this.undoStack.push({ document: structuredClone(this.document), masks: cloneMaskMap(this.masks) }); if (this.undoStack.length > 64) this.undoStack.shift(); this.redoStack = []; }
  undo(expectedRevision: number): boolean {
    this.ensureOpen(); if (expectedRevision !== this.currentRevision || !this.undoStack.length) return false;
    const history = this.document.history;
    this.redoStack.push({ document: structuredClone(this.document), masks: cloneMaskMap(this.masks) });
    const previous = this.undoStack.pop()!; this.document = previous.document; this.masks = previous.masks; this.currentRevision++;
    this.document.history = structuredClone(history);
    this.document.history.push({ revision: this.currentRevision, operation: 'undo', at: new Date().toISOString(), affectedIds: [] });
    return true;
  }
  redo(expectedRevision: number): boolean {
    this.ensureOpen(); if (expectedRevision !== this.currentRevision || !this.redoStack.length) return false;
    const history = this.document.history;
    this.undoStack.push({ document: structuredClone(this.document), masks: cloneMaskMap(this.masks) });
    const next = this.redoStack.pop()!; this.document = next.document; this.masks = next.masks; this.currentRevision++;
    this.document.history = structuredClone(history);
    this.document.history.push({ revision: this.currentRevision, operation: 'redo', at: new Date().toISOString(), affectedIds: [] });
    return true;
  }
  async execute(request: { expectedRevision: number; edits: DecompositionEdit[]; dryRun?: boolean }): Promise<DecompositionEditResult> {
    this.ensureOpen();
    if (request.expectedRevision !== this.currentRevision) return { ok: false, revision: this.revision, error: { code: 'DOCUMENT_CONFLICT', message: 'Expected revision differs from the current document.' } };
    if (!request.edits.length || request.edits.length > 1000) return { ok: false, revision: this.revision, error: { code: 'RESOURCE_LIMIT', message: 'A batch needs 1 to 1000 edits.' } };
    const candidate = structuredClone(this.document), masks = cloneMaskMap(this.masks), changed = new Set<string>();
    const region = (id: string) => candidate.regions.find(item => item.id === id && active(item)) ?? fail(`Region ${id} does not exist.`);
    const part = (id: string) => candidate.parts.find(item => item.id === id) ?? fail(`Part ${id} does not exist.`);
    try {
      for (const edit of request.edits) {
        if (edit.op === 'region.setPath') { const target = region(edit.regionId); target.geometry.manualPath = structuredClone(edit.path); target.geometry.locked = true; target.locked.geometry = true; changed.add(target.id); }
        else if (edit.op === 'region.refineMask') {
          const target = region(edit.regionId), incoming = this.stagedMasks.get(edit.handle) ?? fail('Mask handle is unavailable.');
          if (target.locked.mask) fail('Mask is locked.');
          if (incoming.width !== target.bounds.width || incoming.height !== target.bounds.height) fail('Mask dimensions must match the region bounds.');
          if (!target.originalMaskId) target.originalMaskId = target.maskId;
          const id = `${target.id}_manual_mask_${this.revision + 1}`;
          target.maskId = id; masks.set(id, { ...incoming, bytes: Uint8Array.from(incoming.bytes) });
          target.pixelCount = incoming.bytes.reduce((sum, value) => sum + value, 0);
          const fitted = fitMaskGeometry(target.id, incoming, target.bounds, candidate.settings, target.geometry.texture);
          target.geometry.generatedPath = fitted.geometry.generatedPath; target.geometry.quality = fitted.geometry.quality; target.holeCount = fitted.holeCount;
          target.generationStatus = 'manual'; changed.add(target.id);
        } else if (edit.op === 'region.split') {
          const target = region(edit.regionId), original = masks.get(target.maskId)!;
          if (target.locked.mask || target.locked.part) fail('Region mask or part assignment is locked.');
          finite(edit.coordinate);
          const a = new Uint8Array(original.bytes.length), b = new Uint8Array(original.bytes.length);
          for (let y = 0; y < original.height; y++) for (let x = 0; x < original.width; x++) {
            const index = y * original.width + x; if (!original.bytes[index]) continue;
            const first = edit.axis === 'x' ? target.bounds.x + x + .5 < edit.coordinate : target.bounds.y + y + .5 < edit.coordinate;
            a[index] = first ? 1 : 0; b[index] = first ? 0 : 1;
          }
          if (!a.some(Boolean) || !b.some(Boolean)) fail('Split must leave foreground on both sides.');
          const children = [a, b].map((bytes, index) => {
            const id = `${target.id}_s${this.revision + 1}${index ? 'b' : 'a'}`;
            if (candidate.regions.some(item => item.id === id)) fail('Split IDs already exist.');
            const maskId = `${id}_mask`, mask = { width: original.width, height: original.height, bytes };
            masks.set(maskId, mask);
            const fitted = fitMaskGeometry(id, mask, target.bounds, candidate.settings, target.geometry.texture);
            const child: RegionRecord = { ...structuredClone(target), id, maskId, pixelCount: bytes.reduce((sum, value) => sum + value, 0), geometry: fitted.geometry, holeCount: fitted.holeCount, generationStatus: 'manual', lineage: { parents: [target.id], children: [] }, originalMaskId: undefined };
            return child;
          });
          target.generationStatus = 'historical'; target.lineage.children.push(...children.map(item => item.id));
          candidate.regions.push(...children);
          if (target.partId) { const owned = part(target.partId).regionIds; owned.splice(owned.indexOf(target.id), 1, ...children.map(item => item.id)); }
          changed.add(target.id); children.forEach(item => changed.add(item.id));
        } else if (edit.op === 'region.merge') {
          const first = region(edit.firstId), second = region(edit.secondId);
          if (first.sourceId !== second.sourceId || first.partId !== second.partId || first.locked.mask || second.locked.mask || first.locked.part || second.locked.part) fail('Merge needs two unlocked regions from one source and part.');
          const x = Math.min(first.bounds.x, second.bounds.x), y = Math.min(first.bounds.y, second.bounds.y);
          const width = Math.max(first.bounds.x + first.bounds.width, second.bounds.x + second.bounds.width) - x, height = Math.max(first.bounds.y + first.bounds.height, second.bounds.y + second.bounds.height) - y;
          const bytes = new Uint8Array(width * height);
          for (const source of [first, second]) { const mask = masks.get(source.maskId)!; for (let row = 0; row < mask.height; row++) for (let column = 0; column < mask.width; column++) if (mask.bytes[row * mask.width + column]) bytes[(source.bounds.y - y + row) * width + source.bounds.x - x + column] = 1; }
          const id = `${first.id}_m${this.revision + 1}`; if (candidate.regions.some(item => item.id === id)) fail('Merge ID already exists.');
          const maskId = `${id}_mask`, mask = { width, height, bytes }, bounds = { x, y, width, height };
          masks.set(maskId, mask); const fitted = fitMaskGeometry(id, mask, bounds, candidate.settings, first.geometry.texture === 'source-crop' || second.geometry.texture === 'source-crop' || first.color !== second.color ? 'source-crop' : 'flat');
          const merged: RegionRecord = { ...structuredClone(first), id, maskId, bounds, pixelCount: bytes.reduce((sum, value) => sum + value, 0), geometry: fitted.geometry, holeCount: fitted.holeCount, generationStatus: 'manual', lineage: { parents: [first.id, second.id], children: [] }, originalMaskId: undefined };
          first.generationStatus = second.generationStatus = 'historical'; first.lineage.children.push(id); second.lineage.children.push(id);
          candidate.regions.push(merged);
          if (merged.partId) { const owned = part(merged.partId).regionIds; const at = owned.indexOf(first.id); owned.splice(at, 1, id); owned.splice(owned.indexOf(second.id), 1); }
          [first.id, second.id, id].forEach(value => changed.add(value));
        } else if (edit.op === 'part.create') {
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(edit.id) || candidate.parts.some(item => item.id === edit.id)) fail('Part ID is invalid or already exists.');
          const owned = (edit.regionIds ?? []).map(region);
          if (owned.some(item => item.locked.part)) fail('A selected region has a locked part assignment.');
          const bounds = owned[0]?.bounds ?? { x: 0, y: 0, width: 1, height: 1 };
          candidate.parts.push({ id: edit.id, name: edit.name, regionIds: owned.map(item => item.id), bounds, pivot: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, pivotLocked: false, attachmentApproved: false, hiddenGeometry: 'none', zOrder: candidate.parts.length, transformLocked: false });
          for (const item of owned) { if (item.partId) part(item.partId).regionIds = part(item.partId).regionIds.filter(id => id !== item.id); item.partId = edit.id; changed.add(item.id); }
          changed.add(edit.id);
        } else if (edit.op === 'part.assignRegion') {
          const target = region(edit.regionId), owner = part(edit.partId); if (target.locked.part) fail('Part assignment is locked.');
          if (target.partId) part(target.partId).regionIds = part(target.partId).regionIds.filter(id => id !== target.id);
          target.partId = owner.id; if (!owner.regionIds.includes(target.id)) owner.regionIds.push(target.id); changed.add(target.id); changed.add(owner.id);
        } else if (edit.op === 'part.rename') { part(edit.partId).name = edit.name; changed.add(edit.partId); }
        else if (edit.op === 'part.setPivot') { const target = part(edit.partId); if (target.pivotLocked) fail('Pivot is locked.'); finite(edit.x); finite(edit.y); target.pivot = { x: edit.x, y: edit.y }; changed.add(target.id); }
        else if (edit.op === 'part.reparent') { const target = part(edit.partId); target.parentId = edit.parentId ? part(edit.parentId).id : undefined; if (!target.parentId) { target.attachment = undefined; target.attachmentApproved = false; } changed.add(target.id); }
        else if (edit.op === 'part.setAttachment') { const target = part(edit.partId); if (edit.type && !target.parentId) fail('Attachment needs a parent part.'); target.attachment = edit.type ? { type: edit.type, min: edit.min, max: edit.max } : undefined; target.attachmentApproved = Boolean(edit.approved); changed.add(target.id); }
        else if (edit.op === 'layer.setRelation') {
          region(edit.frontRegionId); region(edit.backRegionId); if (edit.frontRegionId === edit.backRegionId) fail('A region cannot layer in front of itself.');
          const id = `${edit.frontRegionId}_front_${edit.backRegionId}`;
          const relation: LayerRecord = { id, frontRegionId: edit.frontRegionId, backRegionId: edit.backRegionId, origin: 'manual', evidence: ['user-authored layer relation'], status: edit.approved ? 'approved' : 'proposed' };
          candidate.layers = candidate.layers.filter(item => item.id !== id); candidate.layers.push(relation); changed.add(id);
        } else if (edit.op === 'reference.correspond') {
          candidate.correspondences = candidate.correspondences.filter(item => item.id !== edit.correspondence.id);
          candidate.correspondences.push({ ...structuredClone(edit.correspondence), origin: 'manual' }); changed.add(edit.correspondence.id);
        } else if (edit.op === 'annotation.lock') {
          if (edit.regionId) {
            const target = region(edit.regionId);
            if (!['mask', 'geometry', 'part'].includes(edit.target)) fail('Invalid region lock target.');
            target.locked[edit.target as 'mask' | 'geometry' | 'part'] = edit.locked;
            if (edit.target === 'geometry') target.geometry.locked = edit.locked;
            changed.add(target.id);
          } else if (edit.partId) {
            const target = part(edit.partId);
            if (edit.target === 'pivot') target.pivotLocked = edit.locked;
            else if (edit.target === 'transform') target.transformLocked = edit.locked;
            else fail('Invalid part lock target.'); changed.add(target.id);
          } else fail('Lock needs a region or part.');
        } else if (edit.op === 'regenerate.selected') {
          const settings = { ...candidate.settings, ...edit.settings };
          const fingerprint = await sha256(new TextEncoder().encode(JSON.stringify(settings)));
          for (const id of edit.regionIds) {
            const target = region(id);
            if (target.locked.geometry) continue;
            const fitted = fitMaskGeometry(target.id, masks.get(target.maskId)!, target.bounds, settings, target.geometry.texture);
            target.geometry.generatedPath = fitted.geometry.generatedPath; target.geometry.quality = fitted.geometry.quality; target.holeCount = fitted.holeCount;
            target.provenance.settingsFingerprint = fingerprint;
            changed.add(target.id);
          }
          candidate.settings = settings;
        } else fail(`OPERATION_UNSUPPORTED: Unknown decomposition edit ${(edit as { op?: string }).op ?? '<missing>'}.`);
      }
      refreshPartBounds(candidate);
      candidate.updatedAt = new Date().toISOString();
      validateDecompositionDocument(candidate, this.sourceBytes, masks, new Map([...this.images].map(([id, image]) => [id, image.rgba])));
      if (!request.dryRun) {
        this.saveUndo(); this.document = candidate; this.masks = masks; this.currentRevision++;
        this.document.history.push({ revision: this.currentRevision, operation: request.edits.map(item => item.op).join(','), at: candidate.updatedAt, affectedIds: [...changed] });
      }
      return { ok: true, revision: this.revision, changedIds: [...changed] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Edit failed.';
      return { ok: false, revision: this.revision, error: { code: message.split(':')[0].replace(/[^A-Z_]/g, '') || 'DOCUMENT_CONFLICT', message } };
    }
  }
  async close(): Promise<void> { this.closed = true; this.images.clear(); this.sourceBytes.clear(); this.masks.clear(); this.stagedMasks.clear(); this.undoStack = []; this.redoStack = []; }
}
