import type { ShapePath } from '../model';
import { analyzeImage, ALGORITHM_VERSION, fitMaskGeometry } from './analysis';
import { proposePartAttachments } from './articulation';
import { featherMaskOutward } from './feather';
import { rankReferenceCorrespondences } from './correspondence';
import { decodeDecompositionDocument, encodeDecompositionDocument, sha256, validateDecompositionDocument } from './codec';
import { exportNativeDecomposition, planNativeAssemblyReplacement } from './export';
import type { HydeAssemblyReplacementImpact, HydeDecompositionExport, HydeDecompositionExportOptions } from './export';
import { proposeHiddenContinuations } from './hidden';
import { proposeCrossViewOcclusion } from './multiviewOcclusion';
import { proposeJunctionLayers } from './junction';
import { renderDiagnosticTile } from './diagnosticTile';
import type { DiagnosticTile, DiagnosticTileRequest } from './diagnosticTile';
import { decodeSource, encodePng, sourceColorMetadataWarning } from './image';
import type { DecodedImage } from './image';
import { defaultSettings } from './types';
import type { CorrespondenceRecord, DecompositionDocumentV1, DecompositionMode, LayerRecord, PartRecord, ReconstructionSettings, RegionMask, RegionRecord, SourceInput, SourceReference } from './types';

export type DecompositionEdit =
  | { op: 'region.setPath'; regionId: string; path: ShapePath }
  | { op: 'region.offsetPath'; regionId: string; dx: number; dy: number }
  | { op: 'region.clearManualPath'; regionId: string }
  | { op: 'region.setSuppressed'; regionId: string; suppressed: boolean }
  | { op: 'region.setColor'; regionId: string; color: string | null }
  | { op: 'region.setAlignedTexture'; regionId: string; sourceId: string | null }
  | { op: 'region.refineMask'; regionId: string; handle: string; bounds?: RegionRecord['bounds'] }
  | { op: 'region.featherOutside'; regionId: string; radius: number; strength: number }
  | { op: 'region.seedMask'; regionId: string; x: number; y: number; action: 'add' | 'subtract'; colorTolerance: number; radius: number; maxPixels?: number }
  | { op: 'region.split'; regionId: string; axis: 'x' | 'y'; coordinate: number }
  | { op: 'region.merge'; firstId: string; secondId: string }
  | { op: 'part.create'; id: string; name: string; regionIds?: string[] }
  | { op: 'part.assignRegion'; partId: string; regionId: string }
  | { op: 'part.rename'; partId: string; name: string }
  | { op: 'part.setPivot'; partId: string; x: number; y: number }
  | { op: 'part.reparent'; partId: string; parentId?: string }
  | { op: 'part.setAttachment'; partId: string; type?: 'fixed' | 'hinge' | 'slider'; min?: number; max?: number; approved?: boolean }
  | { op: 'part.acceptAttachmentProposal'; partId: string }
  | { op: 'part.rejectAttachmentProposal'; partId: string }
  | { op: 'layer.setRelation'; frontRegionId: string; backRegionId: string; approved: boolean }
  | { op: 'layer.rejectProposal'; frontRegionId: string; backRegionId: string }
  | { op: 'reference.correspond'; correspondence: CorrespondenceRecord }
  | { op: 'reference.setTransform'; sourceId: string; transformToPrimary?: [number, number, number, number, number, number] }
  | { op: 'reference.setBackground'; sourceId: string; color?: string | null }
  | { op: 'reference.alignFromLandmarks'; sourceId: string; landmarkIds: string[] }
  | { op: 'annotation.lock'; regionId?: string; partId?: string; target: 'mask' | 'geometry' | 'part' | 'pivot' | 'transform' | 'attachment'; locked: boolean }
  | { op: 'regenerate.selected'; regionIds: string[]; settings?: Partial<ReconstructionSettings> };

export interface DecompositionEditResult {
  ok: boolean;
  revision: number;
  changedIds?: string[];
  error?: { code: string; message: string; editIndex?: number; targetId?: string; suggestion?: string };
}
interface Snapshot { document: DecompositionDocumentV1; masks: Map<string, RegionMask> }
const cloneRegionMask = (mask: RegionMask): RegionMask => ({ width: mask.width, height: mask.height, bytes: Uint8Array.from(mask.bytes), ...(mask.alpha ? { alpha: Uint8Array.from(mask.alpha) } : {}) });
const cloneMaskMap = (masks: Map<string, RegionMask>): Map<string, RegionMask> => new Map([...masks].map(([id, mask]) => [id, cloneRegionMask(mask)]));
const active = (region: RegionRecord) => region.generationStatus !== 'historical' && !region.suppressed;
const fail = (message: string): never => { throw new Error(message); };
const finite = (value: number) => Number.isFinite(value) || fail('Coordinate must be finite.');

function refreshPartBounds(document: DecompositionDocumentV1): void {
  for (const part of document.parts) {
    const owned = document.regions.filter(region => active(region) && region.partId === part.id);
    part.regionIds = owned.map(region => region.id);
    const inferred = owned.filter(region => region.geometry.status === 'inferred');
    if (inferred.some(region => region.generationStatus === 'manual' || region.locked.geometry || region.locked.mask || region.locked.part)) part.hiddenGeometry = 'user-authored';
    else if (part.hiddenGeometry !== 'user-authored') part.hiddenGeometry = inferred.length ? 'inferred' : 'none';
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

function remapPath(path: ShapePath, before: RegionRecord['bounds'], after: RegionRecord['bounds']): ShapePath {
  const point = (value: { x: number; y: number }) => ({
    x: (before.x + value.x * before.width - after.x) / after.width,
    y: (before.y + value.y * before.height - after.y) / after.height,
  });
  const contour = (values: ShapePath['points']) => values.map(value => ({
    ...point(value), ...(value.in ? { in: point(value.in) } : {}), ...(value.out ? { out: point(value.out) } : {}),
  }));
  return { points: contour(path.points), ...(path.holes ? { holes: path.holes.map(hole => ({ points: contour(hole.points) })) } : {}) };
}

function landmarkAlignment(document: DecompositionDocumentV1, sourceId: string, landmarkIds: string[]): [number, number, number, number, number, number] {
  const primaryId = (document.sources.find(source => source.role === 'primary') ?? fail('INVALID_ARGUMENT: A primary source is required.')).id;
  if (sourceId === primaryId || !document.sources.some(source => source.id === sourceId)) fail('INVALID_ARGUMENT: Alignment needs a non-primary source.');
  if (!Array.isArray(landmarkIds) || !landmarkIds.length || landmarkIds.length > 64 || new Set(landmarkIds).size !== landmarkIds.length)
    fail('INVALID_ARGUMENT: Choose 1 to 64 distinct landmark pairs.');
  const pairs = landmarkIds.map(id => {
    const landmark = document.correspondences.find(item => item.id === id) ?? fail('INVALID_ARGUMENT: An alignment landmark is missing.');
    if (landmark.kind !== 'landmark' || landmark.accepted === false) fail('INVALID_ARGUMENT: An alignment landmark is rejected or not a point pair.');
    const points = landmark.landmarkPoints ?? fail('INVALID_ARGUMENT: An alignment landmark has no point pair.');
    const sourceIndex = landmark.sourceIds.indexOf(sourceId), primaryIndex = landmark.sourceIds.indexOf(primaryId);
    if (sourceIndex < 0 || primaryIndex < 0) fail('INVALID_ARGUMENT: Landmarks must pair this source with the primary source.');
    return { from: points[sourceIndex], to: points[primaryIndex] };
  });
  const mean = (side: 'from' | 'to', axis: 'x' | 'y') => pairs.reduce((sum, pair) => sum + pair[side][axis], 0) / pairs.length;
  const fx = mean('from', 'x'), fy = mean('from', 'y'), tx = mean('to', 'x'), ty = mean('to', 'y');
  let dot = 0, cross = 0, spread = 0;
  for (const pair of pairs) {
    const x = pair.from.x - fx, y = pair.from.y - fy, u = pair.to.x - tx, v = pair.to.y - ty;
    dot += x * u + y * v; cross += x * v - y * u; spread += x * x + y * y;
  }
  if (pairs.length > 1 && spread < 1e-8) fail('INVALID_ARGUMENT: Landmark source points need distinct positions.');
  const a = pairs.length === 1 ? 1 : dot / spread, b = pairs.length === 1 ? 0 : cross / spread;
  if (a * a + b * b < 1e-8) fail('INVALID_ARGUMENT: Landmark pairs imply a collapsed alignment.');
  return [a, b, -b, a, tx - a * fx + b * fy, ty - b * fx - a * fy];
}

/** A bounded, deterministic flood constrained by both color and local edges. */
function seededMask(
  image: DecodedImage, target: RegionRecord, original: RegionMask, occupied: Uint8Array,
  edit: Extract<DecompositionEdit, { op: 'region.seedMask' }>, alphaThreshold: number,
): { bounds: RegionRecord['bounds']; mask: RegionMask; count: number } {
  if (!Number.isInteger(edit.x) || !Number.isInteger(edit.y) || edit.x < 0 || edit.y < 0 || edit.x >= image.width || edit.y >= image.height)
    fail('INVALID_ARGUMENT: Seed must be an integer pixel inside the source.');
  if (!Number.isFinite(edit.colorTolerance) || edit.colorTolerance < 0 || edit.colorTolerance > 255 || !Number.isInteger(edit.radius) || edit.radius < 1 || edit.radius > 256)
    fail('INVALID_ARGUMENT: Color tolerance or seed radius is outside safe bounds.');
  const maxPixels = edit.maxPixels ?? 65_536;
  if (!Number.isInteger(maxPixels) || maxPixels < 1 || maxPixels > 262_144) fail('RESOURCE_LIMIT: Seed pixel budget is outside safe bounds.');
  if (edit.action !== 'add' && edit.action !== 'subtract') fail('INVALID_ARGUMENT: Seed action must be add or subtract.');
  const { width, height, rgba } = image, { x, y, radius } = edit;
  const left = Math.max(0, x - radius), top = Math.max(0, y - radius);
  const right = Math.min(width - 1, x + radius), bottom = Math.min(height - 1, y + radius);
  const windowWidth = right - left + 1, windowHeight = bottom - top + 1;
  const visited = new Uint8Array(windowWidth * windowHeight), queue = new Int32Array(windowWidth * windowHeight);
  const current = (px: number, py: number) => px >= target.bounds.x && py >= target.bounds.y && px < target.bounds.x + target.bounds.width && py < target.bounds.y + target.bounds.height
    && original.bytes[(py - target.bounds.y) * original.width + px - target.bounds.x] !== 0;
  const sourceIndex = (px: number, py: number) => (py * width + px) * 4;
  const seedIndex = sourceIndex(x, y), toleranceSquared = 3 * edit.colorTolerance ** 2;
  const edgeSquared = 3 * Math.max(12, edit.colorTolerance * .55) ** 2;
  const difference = (a: number, b: number) => {
    const dr = rgba[a] - rgba[b], dg = rgba[a + 1] - rgba[b + 1], db = rgba[a + 2] - rgba[b + 2];
    return dr * dr + dg * dg + db * db;
  };
  if (edit.action === 'subtract' && !current(x, y)) fail('INVALID_ARGUMENT: A background seed must start inside the selected region.');
  if (edit.action === 'add' && (rgba[seedIndex + 3] < alphaThreshold || occupied[y * width + x]))
    fail('INVALID_ARGUMENT: A foreground seed must start on unassigned visible source pixels.');
  const within = (px: number, py: number) => px >= left && px <= right && py >= top && py <= bottom && (px - x) ** 2 + (py - y) ** 2 <= radius ** 2;
  const accept = (px: number, py: number, from: number) => {
    if (!within(px, py)) return false;
    if (edit.action === 'subtract' ? !current(px, py) : rgba[sourceIndex(px, py) + 3] < alphaThreshold || occupied[py * width + px]) return false;
    const pixel = sourceIndex(px, py);
    return difference(pixel, seedIndex) <= toleranceSquared && difference(pixel, from) <= edgeSquared;
  };
  let head = 0, tail = 0;
  const start = (y - top) * windowWidth + x - left;
  visited[start] = 1; queue[tail++] = start;
  let minX = target.bounds.x, minY = target.bounds.y;
  let maxX = target.bounds.x + target.bounds.width - 1, maxY = target.bounds.y + target.bounds.height - 1;
  let changed = 0, touchesCurrent = false;
  while (head < tail) {
    const index = queue[head++], px = left + index % windowWidth, py = top + Math.floor(index / windowWidth);
    if (current(px, py)) touchesCurrent = true;
    if (current(px, py) !== (edit.action === 'add')) changed++;
    minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
    const from = sourceIndex(px, py);
    for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
      if (!within(nx, ny)) continue;
      const next = (ny - top) * windowWidth + nx - left;
      if (visited[next] || !accept(nx, ny, from)) continue;
      visited[next] = 1;
      if (tail >= maxPixels) fail('RESOURCE_LIMIT: Seed reaches the pixel budget; reduce radius or tolerance.');
      queue[tail++] = next;
    }
  }
  if (!changed) fail('INVALID_ARGUMENT: Seed did not change this region mask.');
  if (edit.action === 'add' && !touchesCurrent) {
    for (let index = 0; index < tail && !touchesCurrent; index++) {
      const px = left + queue[index] % windowWidth, py = top + Math.floor(queue[index] / windowWidth);
      touchesCurrent = current(px - 1, py) || current(px + 1, py) || current(px, py - 1) || current(px, py + 1);
    }
    if (!touchesCurrent) fail('AMBIGUOUS_REGION: Seed does not connect to the selected region; create a separate region.');
  }
  const bounds = edit.action === 'add' ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : target.bounds;
  const bytes = new Uint8Array(bounds.width * bounds.height);
  for (let row = 0; row < original.height; row++) bytes.set(original.bytes.subarray(row * original.width, (row + 1) * original.width), (row + target.bounds.y - bounds.y) * bounds.width + target.bounds.x - bounds.x);
  const alpha = original.alpha ? new Uint8Array(bytes.length) : undefined;
  if (alpha) for (let row = 0; row < original.height; row++) alpha.set(original.alpha!.subarray(row * original.width, (row + 1) * original.width), (row + target.bounds.y - bounds.y) * bounds.width + target.bounds.x - bounds.x);
  for (let index = 0; index < tail; index++) {
    const px = left + queue[index] % windowWidth, py = top + Math.floor(queue[index] / windowWidth);
    const local = (py - bounds.y) * bounds.width + px - bounds.x;
    bytes[local] = edit.action === 'add' ? 1 : 0;
    if (alpha) alpha[local] = edit.action === 'add' ? 255 : 0;
  }
  return { bounds, mask: { width: bounds.width, height: bounds.height, bytes, ...(alpha ? { alpha } : {}) }, count: bytes.reduce((sum, value) => sum + value, 0) };
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
      algorithmVersion: ALGORITHM_VERSION, mode, settings, sources, regions: [], parts: [], correspondences: [], layers: [],
      diagnostics: sources.flatMap(source => {
        const warning = sourceColorMetadataWarning(source.mime, bytes.get(source.id)!);
        return warning ? [{ code: 'COLOR_SPACE_WARNING' as const, severity: 'warning' as const, sourceId: source.id, message: warning,
          suggestion: 'Convert the reference to sRGB before import when precise color matching matters.' }] : [];
      }), history: [],
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
  /** Encode a view directly from retained canonical pixels without another full RGBA copy. */
  sourcePngFor(id: string): Uint8Array {
    this.ensureOpen(); const image = this.images.get(id);
    if (!image) throw new Error('Source does not exist.');
    return encodePng(image);
  }
  maskFor(id: string): RegionMask { this.ensureOpen(); const mask = this.masks.get(id); if (!mask) throw new Error('Mask does not exist.'); return cloneRegionMask(mask); }
  stageMask(mask: RegionMask): string {
    this.ensureOpen();
    if (!Number.isInteger(mask.width) || !Number.isInteger(mask.height) || mask.width < 1 || mask.height < 1 || mask.width * mask.height > 4_000_000 || mask.bytes.length !== mask.width * mask.height || mask.bytes.some(byte => byte !== 0 && byte !== 1)) throw new Error('Invalid binary mask.');
    if (mask.alpha && (mask.alpha.length !== mask.bytes.length || mask.alpha.some((value, index) => !mask.bytes[index] && value !== 0))) throw new Error('Invalid soft mask.');
    const handle = `mask_handle_${this.currentRevision}_${this.stagedMasks.size + 1}`;
    this.stagedMasks.set(handle, cloneRegionMask(mask));
    return handle;
  }
  discardMask(handle: string) { this.stagedMasks.delete(handle); }

  async analyze(options: { mode?: DecompositionMode; settings?: Partial<ReconstructionSettings>; signal?: AbortSignal } = {}): Promise<{ revision: number; regionCount: number; diagnostics: DecompositionDocumentV1['diagnostics']; remapped: Record<string, string> }> {
    this.ensureOpen();
    const mode = options.mode ?? this.document.mode;
    const previous = this.document, priorMasks = this.masks;
    let settings = { ...(options.mode && options.mode !== previous.mode ? defaultSettings(mode) : previous.settings), ...options.settings };
    if (settings.edgeSensitivity !== undefined && (!Number.isFinite(settings.edgeSensitivity) || settings.edgeSensitivity < .25 || settings.edgeSensitivity > 2))
      throw new Error('INVALID_ARGUMENT: Edge sensitivity must be between 0.25 and 2.');
    let complexityNote: { sourceId: string; before: number; after: number } | undefined;
    let firstPass: { sourceId: string; fingerprint: string; result: ReturnType<typeof analyzeImage> } | undefined;
    // One first-pass retry is allowed only when the ordinary appearance pass
    // fragments a primary reference into mostly tiny pieces. Keep the ordinary
    // profile for clean flat art and gradients; explicit user settings win.
    if (mode === 'appearance' && !previous.regions.length && !options.settings && settings.colorStep === 24) {
      const source = previous.sources.find(item => item.role === 'primary');
      if (source) {
        const image = this.images.get(source.id)!;
        const baselineFingerprint = await sha256(new TextEncoder().encode(JSON.stringify(settings)));
        const baseline = analyzeImage(image, source, mode, settings, baselineFingerprint, options.signal);
        firstPass = { sourceId: source.id, fingerprint: baselineFingerprint, result: baseline };
        const tiny = baseline.regions.filter(region => region.pixelCount < settings.minRegionPixels).length;
        if (baseline.regions.length >= 100 && tiny > baseline.regions.length / 2) {
          const alternative = { ...settings, colorStep: 40, minRegionPixels: 8 };
          const simplified = analyzeImage(image, source, mode, alternative, 'complexity-probe', options.signal);
          const quality = (regions: typeof baseline.regions) => regions.reduce((sum, region) =>
            sum + region.pixelCount * region.geometry.quality.maskIoU, 0) / Math.max(1, regions.reduce((sum, region) => sum + region.pixelCount, 0));
          if (simplified.regions.length >= 2 && simplified.parts.length >= 2 &&
            simplified.regions.length <= baseline.regions.length * .6 && quality(simplified.regions) >= quality(baseline.regions) - .01) {
            settings = alternative;
            complexityNote = { sourceId: source.id, before: baseline.regions.length, after: simplified.regions.length };
          }
        }
      }
    }
    const fingerprint = await sha256(new TextEncoder().encode(JSON.stringify(settings)));
    const candidate = structuredClone(previous), masks = cloneMaskMap(priorMasks);
    delete candidate.exportMapping;
    candidate.algorithmVersion = ALGORITHM_VERSION;
    candidate.mode = mode; candidate.settings = settings; candidate.regions = []; candidate.parts = []; candidate.layers = []; candidate.diagnostics = [];
    if (complexityNote) candidate.diagnostics.push({ code: 'AUTO_COMPLEXITY_REDUCTION', severity: 'info', sourceId: complexityNote.sourceId,
      message: `The first appearance pass yielded ${complexityNote.before} mostly tiny regions; coarser color grouping reduced it to ${complexityNote.after} while preserving mask agreement.`,
      suggestion: 'Adjust Color step and minimum region size if small paint features need separate parts.' });
    const remapped: Record<string, string> = {}, matched = new Set<string>();
    for (const source of candidate.sources) {
      if (options.signal?.aborted) throw new Error('CANCELED');
      const result = firstPass?.sourceId === source.id && firstPass.fingerprint === fingerprint
        ? firstPass.result : analyzeImage(this.images.get(source.id)!, source, mode, settings, fingerprint, options.signal);
      const old = previous.regions.filter(region => region.sourceId === source.id && active(region) && region.geometry.status === 'visible');
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
          if (oldRegion.authoredColor) {
            region.generatedColor = region.color;
            region.authoredColor = oldRegion.authoredColor;
            region.color = oldRegion.authoredColor;
          }
          if (oldRegion.alignedTexture) region.alignedTexture = structuredClone(oldRegion.alignedTexture);
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
      const colorWarning = sourceColorMetadataWarning(source.mime, this.sourceBytes.get(source.id)!);
      if (colorWarning) candidate.diagnostics.push({ code: 'COLOR_SPACE_WARNING', severity: 'warning', sourceId: source.id,
        message: colorWarning, suggestion: 'Convert the reference to sRGB before import when precise color matching matters.' });
    }
    for (const region of previous.regions) if (region.geometry.status === 'inferred' && region.suppressed && !candidate.regions.some(item => item.id === region.id)) {
      candidate.regions.push(structuredClone(region));
      matched.add(region.id);
    }
    const primary = candidate.sources.find(source => source.role === 'primary')!;
    for (const source of candidate.sources) {
      const junctions = proposeJunctionLayers(candidate, masks, source.id);
      candidate.layers.push(...junctions.layers);
      candidate.diagnostics.push(...junctions.diagnostics);
    }
    const crossView = proposeCrossViewOcclusion(candidate, masks, previous.correspondences.filter(item => item.origin === 'manual'),
      this.images.get(primary.id)!.rgba, previous.layers);
    const crossHiddenIds = new Set(crossView.regions.map(region => region.id));
    candidate.layers.push(...crossView.layers.filter(layer => !crossHiddenIds.has(layer.backRegionId)));
    candidate.diagnostics.push(...crossView.diagnostics.filter(item => !item.regionId || !crossHiddenIds.has(item.regionId)));
    if (mode === 'animation-ready' && settings.inferHiddenGeometry) {
      const proposed = proposeHiddenContinuations(candidate, masks, this.images.get(primary.id)!.rgba);
      proposed.regions.push(...crossView.regions);
      for (const [id, mask] of crossView.masks) proposed.masks.set(id, mask);
      proposed.layers.push(...crossView.layers.filter(layer => crossHiddenIds.has(layer.backRegionId)));
      proposed.diagnostics.push(...crossView.diagnostics.filter(item => item.regionId && crossHiddenIds.has(item.regionId)));
      const previousById = new Map(previous.regions.map(region => [region.id, region]));
      const hasEditedDescendant = (root: RegionRecord): boolean => {
        const pending = [...root.lineage.children], visited = new Set<string>();
        while (pending.length) {
          const id = pending.pop()!;
          if (visited.has(id)) continue;
          visited.add(id);
          const child = previousById.get(id);
          if (!child) continue;
          if (child.generationStatus !== 'historical') return true;
          pending.push(...child.lineage.children);
        }
        return false;
      };
      const added = new Set<string>();
      for (const region of proposed.regions) {
        const historical = previousById.get(region.id);
        if (historical?.geometry.status === 'inferred' && historical.generationStatus === 'historical' && hasEditedDescendant(historical)) continue;
        const earlier = previous.regions.find(item => item.id === region.id && active(item) && item.geometry.status === 'inferred');
        if (earlier) {
          matched.add(earlier.id); remapped[earlier.id] = earlier.id;
          region.partId = earlier.partId;
          region.locked = structuredClone(earlier.locked);
          region.lineage = structuredClone(earlier.lineage);
          region.geometry.manualPath = structuredClone(earlier.geometry.manualPath);
          if (earlier.authoredColor) {
            region.generatedColor = region.color;
            region.authoredColor = earlier.authoredColor;
            region.color = earlier.authoredColor;
          }
          if (earlier.alignedTexture) region.alignedTexture = structuredClone(earlier.alignedTexture);
          region.geometry.locked = earlier.geometry.locked;
          if (earlier.locked.mask || earlier.generationStatus === 'manual' || earlier.originalMaskId) {
            Object.assign(region, { maskId: earlier.maskId, originalMaskId: earlier.originalMaskId, bounds: earlier.bounds, pixelCount: earlier.pixelCount, holeCount: earlier.holeCount, geometry: structuredClone(earlier.geometry), generationStatus: earlier.generationStatus });
            masks.set(earlier.maskId, priorMasks.get(earlier.maskId)!);
          } else {
            masks.set(region.maskId, proposed.masks.get(region.maskId)!);
            if (earlier.locked.geometry) region.geometry = structuredClone(earlier.geometry);
          }
        } else masks.set(region.maskId, proposed.masks.get(region.maskId)!);
        candidate.regions.push(region);
        added.add(region.id);
      }
      candidate.layers.push(...proposed.layers.filter(layer => added.has(layer.backRegionId)));
      candidate.diagnostics.push(...proposed.diagnostics.filter(item => !item.regionId || added.has(item.regionId)));
    }
    const retainedHidden = new Set<string>();
    if (mode === 'animation-ready') for (const region of previous.regions) {
      if (!active(region) || region.geometry.status !== 'inferred' || matched.has(region.id) || candidate.regions.some(item => item.id === region.id)) continue;
      if (region.generationStatus !== 'manual' && !region.locked.mask && !region.locked.geometry && !region.locked.part && !region.alignedTexture) continue;
      candidate.regions.push(structuredClone(region));
      retainedHidden.add(region.id);
      matched.add(region.id);
      candidate.diagnostics.push({ code: 'OCCLUSION_UNDERCONSTRAINED', severity: 'warning', sourceId: region.sourceId, regionId: region.id,
        message: 'A user-edited hidden region was retained after its automatic overlap evidence changed.', suggestion: 'Review its mask, path and front/back relation before export.' });
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
    const attachments = proposePartAttachments(candidate, masks);
    for (const part of candidate.parts) if (!part.attachmentLocked) part.attachmentProposal = attachments.proposals.get(part.id);
    candidate.diagnostics.push(...attachments.diagnostics);
    const liveIds = new Set(candidate.regions.filter(active).map(region => region.id));
    const storedIds = new Set(candidate.regions.map(region => region.id));
    const suppressedIds = new Set(candidate.regions.filter(region => region.suppressed).map(region => region.id));
    const pairKey = (first: string, second: string) => [first, second].sort().join(':');
    const manualPairs = new Set(previous.layers.filter(layer => layer.origin === 'manual')
      .map(layer => pairKey(layer.frontRegionId, layer.backRegionId)));
    const notManuallyOverridden = (layer: LayerRecord) => !manualPairs.has(pairKey(layer.frontRegionId, layer.backRegionId));
    candidate.layers = [
      ...candidate.layers.filter(notManuallyOverridden),
      ...previous.layers.filter(layer => layer.origin === 'manual' && liveIds.has(layer.frontRegionId) && liveIds.has(layer.backRegionId)),
      ...previous.layers.filter(layer => (retainedHidden.has(layer.frontRegionId) || retainedHidden.has(layer.backRegionId)) && layer.origin === 'automatic' && liveIds.has(layer.frontRegionId) && liveIds.has(layer.backRegionId) && notManuallyOverridden(layer) && !candidate.layers.some(current => current.id === layer.id)),
      ...previous.layers.filter(layer => (suppressedIds.has(layer.frontRegionId) || suppressedIds.has(layer.backRegionId)) && storedIds.has(layer.frontRegionId) && storedIds.has(layer.backRegionId) && notManuallyOverridden(layer) && !candidate.layers.some(current => current.id === layer.id)),
    ];
    candidate.correspondences = previous.correspondences.filter(item => item.origin === 'manual');
    const manualCorrespondenceIds = new Set(candidate.correspondences.map(item => item.id));
    for (const source of candidate.sources.filter(item => item.id !== primary.id)) {
      const ranked = rankReferenceCorrespondences(
        candidate.regions.filter(region => region.sourceId === primary.id && active(region) && region.geometry.status === 'visible'),
        candidate.regions.filter(region => region.sourceId === source.id && active(region) && region.geometry.status === 'visible'),
        { primarySource: primary, alternateSource: source, manual: candidate.correspondences },
      );
      candidate.correspondences.push(...ranked.candidates.filter(item => !manualCorrespondenceIds.has(item.id)));
      candidate.diagnostics.push(...ranked.diagnostics);
    }
    candidate.updatedAt = new Date().toISOString();
    validateDecompositionDocument(candidate, this.sourceBytes, masks, new Map([...this.images].map(([id, image]) => [id, image.rgba])));
    if (options.signal?.aborted) throw new Error('CANCELED');
    this.saveUndo(); this.document = candidate; this.masks = masks; this.currentRevision++;
    this.document.history.push({ revision: this.currentRevision, operation: 'analyze', at: candidate.updatedAt, affectedIds: candidate.regions.filter(active).map(item => item.id) });
    return { revision: this.currentRevision, regionCount: candidate.regions.filter(active).length, diagnostics: structuredClone(candidate.diagnostics), remapped };
  }

  inspect(query: { target: 'summary' | 'sources' | 'regions' | 'parts' | 'region' | 'part' | 'diagnostics' | 'correspondences'; id?: string; limit?: number; cursor?: number }) {
    this.ensureOpen();
    if (!['summary', 'sources', 'regions', 'parts', 'region', 'part', 'diagnostics', 'correspondences'].includes(query.target))
      return { revision: this.revision, error: { code: 'OPERATION_UNSUPPORTED', message: 'Inspection target is unsupported.' } };
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) ||
      query.cursor !== undefined && (!Number.isSafeInteger(query.cursor) || query.cursor < 0))
      return { revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: 'Inspection limit must be 1–100 and cursor must be a nonnegative integer.' } };
    const limit = query.limit ?? 25, cursor = query.cursor ?? 0;
    if (query.target === 'summary') return { revision: this.revision, id: this.document.id, mode: this.document.mode, sourceCount: this.document.sources.length, regionCount: this.document.regions.filter(active).length, partCount: this.document.parts.length, diagnosticCount: this.document.diagnostics.length };
    if (query.target === 'region' || query.target === 'part') {
      const item = query.target === 'region' ? this.document.regions.find(region => region.id === query.id) : this.document.parts.find(part => part.id === query.id);
      if (!item) return { revision: this.revision, error: { code: 'TARGET_NOT_FOUND', message: `${query.target} does not exist.`, targetId: query.id } };
      return query.target === 'region' ? { revision: this.revision, region: structuredClone(item) } : { revision: this.revision, part: structuredClone(item) };
    }
    const list = query.target === 'sources' ? this.document.sources : query.target === 'parts' ? this.document.parts : query.target === 'diagnostics' ? this.document.diagnostics : query.target === 'correspondences' ? this.document.correspondences : this.document.regions.filter(active);
    return { revision: this.revision, items: structuredClone(list.slice(cursor, cursor + limit)), nextCursor: cursor + limit < list.length ? cursor + limit : undefined };
  }
  renderDiagnosticTile(request: DiagnosticTileRequest): DiagnosticTile {
    this.ensureOpen();
    return renderDiagnosticTile(this.document, this.images, this.masks, request);
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
  async planAssemblyReplacement(targetBytes: Uint8Array): Promise<HydeAssemblyReplacementImpact> {
    this.ensureOpen();
    return planNativeAssemblyReplacement(this.document, this.masks, targetBytes);
  }
  async exportHyde(options: HydeDecompositionExportOptions): Promise<HydeDecompositionExport> {
    this.ensureOpen();
    const result = await exportNativeDecomposition(this.document, this.masks, this.images, options);
    // A successful export records provenance for the next .hydecomp save. This
    // derived metadata does not change the authoring revision or undo stack.
    this.document.exportMapping = structuredClone(result.mapping);
    return result;
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
    if (!request || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      !Array.isArray(request.edits) || request.dryRun !== undefined && typeof request.dryRun !== 'boolean')
      return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: 'Edit request needs a nonnegative integer revision, an edits array, and an optional boolean dryRun.' } };
    if (request.expectedRevision !== this.currentRevision) return { ok: false, revision: this.revision, error: { code: 'DOCUMENT_CONFLICT', message: 'Expected revision differs from the current document.' } };
    if (!request.edits.length || request.edits.length > 1000) return { ok: false, revision: this.revision, error: { code: 'RESOURCE_LIMIT', message: 'A batch needs 1 to 1000 edits.' } };
    const candidate = structuredClone(this.document), masks = cloneMaskMap(this.masks), changed = new Set<string>();
    delete candidate.exportMapping;
    const region = (id: string) => candidate.regions.find(item => item.id === id && active(item)) ?? fail(`Region ${id} does not exist.`);
    const part = (id: string) => candidate.parts.find(item => item.id === id) ?? fail(`Part ${id} does not exist.`);
    let activeEditIndex: number | undefined;
    try {
      for (const [editIndex, edit] of request.edits.entries()) {
        activeEditIndex = editIndex;
        if (!edit || typeof edit !== 'object' || Array.isArray(edit) || typeof edit.op !== 'string')
          fail('INVALID_ARGUMENT: Each edit must be an object with an operation name.');
        if (edit.op === 'region.setPath') { const target = region(edit.regionId); target.geometry.manualPath = structuredClone(edit.path); target.geometry.locked = true; target.locked.geometry = true; changed.add(target.id); }
        else if (edit.op === 'region.offsetPath') {
          const target = region(edit.regionId);
          finite(edit.dx); finite(edit.dy);
          const source = candidate.sources.find(item => item.id === target.sourceId)!;
          if (Math.abs(edit.dx) > source.width || Math.abs(edit.dy) > source.height)
            fail('INVALID_ARGUMENT: Path offset must stay within one source width and height.');
          const path = structuredClone(target.geometry.manualPath ?? target.geometry.generatedPath);
          const dx = edit.dx / target.bounds.width, dy = edit.dy / target.bounds.height;
          for (const contour of [path, ...(path.holes ?? [])]) for (const point of contour.points) {
            point.x += dx; point.y += dy;
            if (point.in) { point.in.x += dx; point.in.y += dy; }
            if (point.out) { point.out.x += dx; point.out.y += dy; }
          }
          target.geometry.manualPath = path; target.geometry.locked = true; target.locked.geometry = true; changed.add(target.id);
        }
        else if (edit.op === 'region.clearManualPath') { const target = region(edit.regionId); if (target.locked.geometry) fail('DOCUMENT_CONFLICT: Unlock the contour before using its generated path.'); delete target.geometry.manualPath; target.geometry.locked = false; changed.add(target.id); }
        else if (edit.op === 'region.setSuppressed') {
          const target = candidate.regions.find(item => item.id === edit.regionId && item.generationStatus !== 'historical' && item.geometry.status === 'inferred') ?? fail('Only a current inferred region can be suppressed or restored.');
          target.suppressed = edit.suppressed; changed.add(target.id);
        }
        else if (edit.op === 'region.setColor') {
          const target = region(edit.regionId);
          if (edit.color === null) {
            if (target.generatedColor) target.color = target.generatedColor;
            delete target.authoredColor; delete target.generatedColor;
          } else {
            if (target.geometry.texture !== 'flat') fail('INVALID_ARGUMENT: A source-crop texture controls this region color.');
            if (typeof edit.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(edit.color)) fail('INVALID_ARGUMENT: Region color must be a six-digit hex value.');
            if (!target.authoredColor) target.generatedColor = target.color;
            target.color = edit.color.toLowerCase(); target.authoredColor = target.color;
          }
          changed.add(target.id);
        }
        else if (edit.op === 'region.setAlignedTexture') {
          const target = region(edit.regionId);
          if (target.geometry.status !== 'inferred') fail('INVALID_ARGUMENT: Aligned reference texture requires an inferred region.');
          if (edit.sourceId === null) delete target.alignedTexture;
          else {
            const source = candidate.sources.find(item => item.id === edit.sourceId && item.role !== 'primary') ?? fail('TARGET_NOT_FOUND: Alternate texture source does not exist.');
            const transform = source.transformToPrimary ?? fail('INVALID_ARGUMENT: Align the alternate reference before using its texture.');
            const matched = candidate.correspondences.some(item => item.origin === 'manual' && item.kind === 'same-part' && item.accepted &&
              item.regionIds?.some(id => candidate.regions.some(other => other.id === id && other.sourceId === source.id && active(other))) &&
              item.regionIds?.some(id => candidate.regions.some(other => other.id === id && other.sourceId === target.sourceId && other.partId === target.partId && active(other))));
            if (!matched) fail('INVALID_ARGUMENT: Confirm a same-part match with this alternate reference first.');
            target.alignedTexture = { sourceId: source.id, transformToPrimary: [...transform] as typeof transform };
          }
          changed.add(target.id);
        }
        else if (edit.op === 'region.refineMask') {
          const target = region(edit.regionId), incoming = this.stagedMasks.get(edit.handle) ?? fail('Mask handle is unavailable.');
          if (target.locked.mask) fail('Mask is locked.');
          const bounds = edit.bounds ?? target.bounds, image = this.images.get(target.sourceId)!;
          if (!Number.isInteger(bounds.x) || !Number.isInteger(bounds.y) || !Number.isInteger(bounds.width) || !Number.isInteger(bounds.height) || bounds.x < 0 || bounds.y < 0 || bounds.width < 1 || bounds.height < 1 || bounds.x + bounds.width > image.width || bounds.y + bounds.height > image.height) fail('Mask bounds must stay inside the source image.');
          if (incoming.width !== bounds.width || incoming.height !== bounds.height) fail('Mask dimensions must match the region bounds.');
          const changedBounds = bounds.x !== target.bounds.x || bounds.y !== target.bounds.y || bounds.width !== target.bounds.width || bounds.height !== target.bounds.height;
          if (changedBounds && target.geometry.manualPath) fail('DOCUMENT_CONFLICT: Unlock the manual contour before expanding its mask.');
          if (!target.originalMaskId) target.originalMaskId = target.maskId;
          const id = `${target.id}_manual_mask_${this.revision + 1}_${editIndex}`;
          target.maskId = id; masks.set(id, cloneRegionMask(incoming));
          if (changedBounds) { target.bounds = { ...bounds }; target.geometry.bounds = { ...bounds }; }
          target.pixelCount = incoming.bytes.reduce((sum, value) => sum + value, 0);
          const fitted = fitMaskGeometry(target.id, incoming, bounds, candidate.settings, target.geometry.texture);
          target.geometry.generatedPath = fitted.geometry.generatedPath; target.geometry.quality = fitted.geometry.quality; target.holeCount = fitted.holeCount;
          target.generationStatus = 'manual'; changed.add(target.id);
        } else if (edit.op === 'region.featherOutside') {
          const target = region(edit.regionId), original = masks.get(target.maskId)!;
          if (target.locked.mask || target.locked.geometry || target.geometry.manualPath) fail('DOCUMENT_CONFLICT: Feathering needs an unlocked generated mask and contour.');
          const image = this.images.get(target.sourceId)!;
          const occupied = new Uint8Array(image.width * image.height);
          for (const other of candidate.regions) {
            if (!active(other) || other.id === target.id || other.sourceId !== target.sourceId) continue;
            const otherMask = masks.get(other.maskId)!;
            for (let row = 0; row < otherMask.height; row++) for (let column = 0; column < otherMask.width; column++)
              if (otherMask.bytes[row * otherMask.width + column]) occupied[(other.bounds.y + row) * image.width + other.bounds.x + column] = 1;
          }
          const result = featherMaskOutward(target.bounds, original, image.width, image.height, edit.radius, edit.strength, occupied);
          if (!target.originalMaskId) target.originalMaskId = target.maskId;
          const id = `${target.id}_manual_mask_${this.revision + 1}_${editIndex}`;
          target.maskId = id; masks.set(id, result.mask);
          target.bounds = result.bounds; target.geometry.bounds = result.bounds; target.pixelCount = result.pixelCount;
          const fitted = fitMaskGeometry(target.id, result.mask, result.bounds, candidate.settings, target.geometry.texture);
          target.geometry.generatedPath = fitted.geometry.generatedPath; target.geometry.quality = fitted.geometry.quality; target.holeCount = fitted.holeCount;
          target.generationStatus = 'manual';
          if (!target.confidence.reasons.includes('user-authored outward soft feather')) target.confidence.reasons.push('user-authored outward soft feather');
          changed.add(target.id);
        } else if (edit.op === 'region.seedMask') {
          const target = region(edit.regionId), original = masks.get(target.maskId)!;
          if (target.locked.mask) fail('DOCUMENT_CONFLICT: Mask is locked.');
          const image = this.images.get(target.sourceId)!;
          const occupied = new Uint8Array(image.width * image.height);
          for (const other of candidate.regions) {
            if (!active(other) || other.id === target.id || other.sourceId !== target.sourceId) continue;
            const otherMask = masks.get(other.maskId)!;
            for (let row = 0; row < otherMask.height; row++) for (let column = 0; column < otherMask.width; column++)
              if (otherMask.bytes[row * otherMask.width + column]) occupied[(other.bounds.y + row) * image.width + other.bounds.x + column] = 1;
          }
          const result = seededMask(image, target, original, occupied, edit, candidate.settings.alphaThreshold);
          if (!target.originalMaskId) target.originalMaskId = target.maskId;
          const id = `${target.id}_manual_mask_${this.revision + 1}_${editIndex}`;
          target.maskId = id; masks.set(id, result.mask);
          const before = target.bounds;
          if (target.geometry.manualPath && (before.x !== result.bounds.x || before.y !== result.bounds.y || before.width !== result.bounds.width || before.height !== result.bounds.height))
            target.geometry.manualPath = remapPath(target.geometry.manualPath, before, result.bounds);
          target.bounds = result.bounds; target.geometry.bounds = result.bounds; target.pixelCount = result.count;
          const fitted = fitMaskGeometry(target.id, result.mask, result.bounds, candidate.settings, target.geometry.texture);
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
            const maskId = `${id}_mask`, mask: RegionMask = { width: original.width, height: original.height, bytes,
              ...(original.alpha ? { alpha: Uint8Array.from(original.alpha, (value, pixel) => bytes[pixel] ? value : 0) } : {}) };
            masks.set(maskId, mask);
            const fitted = fitMaskGeometry(id, mask, target.bounds, candidate.settings, target.geometry.texture);
            const child: RegionRecord = { ...structuredClone(target), id, maskId, pixelCount: bytes.reduce((sum, value) => sum + value, 0), geometry: { ...fitted.geometry, status: target.geometry.status }, holeCount: fitted.holeCount, generationStatus: 'manual', lineage: { parents: [target.id], children: [] }, originalMaskId: undefined };
            return child;
          });
          target.generationStatus = 'historical'; target.lineage.children.push(...children.map(item => item.id));
          candidate.regions.push(...children);
          for (const relation of candidate.layers.filter(item => item.frontRegionId === target.id || item.backRegionId === target.id)) for (const child of children) {
            const frontRegionId = relation.frontRegionId === target.id ? child.id : relation.frontRegionId;
            const backRegionId = relation.backRegionId === target.id ? child.id : relation.backRegionId;
            candidate.layers.push({ ...structuredClone(relation), id: `${frontRegionId}_front_${backRegionId}`, frontRegionId, backRegionId,
              evidence: [...relation.evidence, `region ${target.id} was split into editable children`] });
          }
          if (target.partId) { const owned = part(target.partId).regionIds; owned.splice(owned.indexOf(target.id), 1, ...children.map(item => item.id)); }
          changed.add(target.id); children.forEach(item => changed.add(item.id));
        } else if (edit.op === 'region.merge') {
          const first = region(edit.firstId), second = region(edit.secondId);
          if (first.sourceId !== second.sourceId || first.partId !== second.partId || first.locked.mask || second.locked.mask || first.locked.part || second.locked.part) fail('Merge needs two unlocked regions from one source and part.');
          if (first.alignedTexture || second.alignedTexture) fail('DOCUMENT_CONFLICT: Clear the chosen aligned texture before merging regions with different pixel provenance.');
          const x = Math.min(first.bounds.x, second.bounds.x), y = Math.min(first.bounds.y, second.bounds.y);
          const width = Math.max(first.bounds.x + first.bounds.width, second.bounds.x + second.bounds.width) - x, height = Math.max(first.bounds.y + first.bounds.height, second.bounds.y + second.bounds.height) - y;
          const bytes = new Uint8Array(width * height);
          const alpha = masks.get(first.maskId)!.alpha || masks.get(second.maskId)!.alpha ? new Uint8Array(width * height) : undefined;
          for (const source of [first, second]) { const mask = masks.get(source.maskId)!; for (let row = 0; row < mask.height; row++) for (let column = 0; column < mask.width; column++) {
            const local = row * mask.width + column; if (!mask.bytes[local]) continue;
            const target = (source.bounds.y - y + row) * width + source.bounds.x - x + column;
            bytes[target] = 1; if (alpha) alpha[target] = Math.max(alpha[target], mask.alpha?.[local] ?? 255);
          } }
          const id = `${first.id}_m${this.revision + 1}`; if (candidate.regions.some(item => item.id === id)) fail('Merge ID already exists.');
          const maskId = `${id}_mask`, mask: RegionMask = { width, height, bytes, ...(alpha ? { alpha } : {}) }, bounds = { x, y, width, height };
          masks.set(maskId, mask); const fitted = fitMaskGeometry(id, mask, bounds, candidate.settings, first.geometry.texture === 'source-crop' || second.geometry.texture === 'source-crop' || first.color !== second.color ? 'source-crop' : 'flat');
          const merged: RegionRecord = { ...structuredClone(first), id, maskId, bounds, pixelCount: bytes.reduce((sum, value) => sum + value, 0), geometry: { ...fitted.geometry, status: first.geometry.status === 'inferred' || second.geometry.status === 'inferred' ? 'inferred' : 'visible' }, holeCount: fitted.holeCount, generationStatus: 'manual', lineage: { parents: [first.id, second.id], children: [] }, originalMaskId: undefined };
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
          for (const item of owned) { if (item.partId) part(item.partId).regionIds = part(item.partId).regionIds.filter(id => id !== item.id); item.partId = edit.id; if (item.geometry.status === 'inferred') item.generationStatus = 'manual'; changed.add(item.id); }
          changed.add(edit.id);
        } else if (edit.op === 'part.assignRegion') {
          const target = region(edit.regionId), owner = part(edit.partId); if (target.locked.part) fail('Part assignment is locked.');
          if (target.partId) part(target.partId).regionIds = part(target.partId).regionIds.filter(id => id !== target.id);
          target.partId = owner.id; if (target.geometry.status === 'inferred') target.generationStatus = 'manual'; if (!owner.regionIds.includes(target.id)) owner.regionIds.push(target.id); changed.add(target.id); changed.add(owner.id);
        } else if (edit.op === 'part.rename') { part(edit.partId).name = edit.name; changed.add(edit.partId); }
        else if (edit.op === 'part.setPivot') { const target = part(edit.partId); if (target.pivotLocked) fail('Pivot is locked.'); finite(edit.x); finite(edit.y); target.pivot = { x: edit.x, y: edit.y }; changed.add(target.id); }
        else if (edit.op === 'part.reparent') { const target = part(edit.partId); if (target.attachmentLocked) fail('Attachment is locked.'); target.parentId = edit.parentId ? part(edit.parentId).id : undefined; target.attachmentProposal = undefined; if (!target.parentId) { target.attachment = undefined; target.attachmentApproved = false; } changed.add(target.id); }
        else if (edit.op === 'part.setAttachment') { const target = part(edit.partId); if (target.attachmentLocked) fail('Attachment is locked.'); if (edit.type && !target.parentId) fail('Attachment needs a parent part.'); target.attachment = edit.type ? { type: edit.type, min: edit.min, max: edit.max } : undefined; target.attachmentApproved = Boolean(edit.approved); target.attachmentProposal = undefined; changed.add(target.id); }
        else if (edit.op === 'part.acceptAttachmentProposal') {
          const target = part(edit.partId), proposal = target.attachmentProposal ?? fail('No current attachment proposal exists for this part.');
          if (target.attachmentLocked) fail('Attachment is locked.');
          target.parentId = part(proposal.parentId).id; target.attachment = { type: proposal.type }; target.attachmentApproved = true;
          if (!target.pivotLocked) target.pivot = structuredClone(proposal.pivot);
          target.attachmentProposal = undefined; target.attachmentProposalRejected = false; changed.add(target.id);
        } else if (edit.op === 'part.rejectAttachmentProposal') {
          const target = part(edit.partId);
          if (target.attachmentLocked) fail('Attachment is locked.');
          if (!target.attachmentProposal) fail('No current attachment proposal exists for this part.');
          target.attachmentProposal = undefined; target.attachmentProposalRejected = true; changed.add(target.id);
        }
        else if (edit.op === 'layer.setRelation') {
          region(edit.frontRegionId); region(edit.backRegionId); if (edit.frontRegionId === edit.backRegionId) fail('A region cannot layer in front of itself.');
          const id = `${edit.frontRegionId}_front_${edit.backRegionId}`;
          const relation: LayerRecord = { id, frontRegionId: edit.frontRegionId, backRegionId: edit.backRegionId, origin: 'manual', evidence: ['user-authored layer relation'], status: edit.approved ? 'approved' : 'proposed' };
          candidate.layers = candidate.layers.filter(item => !(
            item.frontRegionId === edit.frontRegionId && item.backRegionId === edit.backRegionId ||
            item.frontRegionId === edit.backRegionId && item.backRegionId === edit.frontRegionId
          ));
          candidate.layers.push(relation); changed.add(id);
        } else if (edit.op === 'layer.rejectProposal') {
          region(edit.frontRegionId); region(edit.backRegionId);
          const proposal = candidate.layers.find(item => item.frontRegionId === edit.frontRegionId && item.backRegionId === edit.backRegionId && item.origin === 'automatic' && item.status === 'proposed');
          if (!proposal) fail('TARGET_NOT_FOUND: Automatic layer proposal does not exist.');
          candidate.layers = candidate.layers.filter(item => item.id !== proposal!.id);
          const rejected: LayerRecord = { id: `${edit.frontRegionId}_rejected_front_${edit.backRegionId}`, frontRegionId: edit.frontRegionId,
            backRegionId: edit.backRegionId, origin: 'manual', status: 'rejected', evidence: [...proposal!.evidence, 'user rejected this automatic layer proposal'] };
          candidate.layers.push(rejected); changed.add(rejected.id);
        } else if (edit.op === 'reference.correspond') {
          const pair = edit.correspondence.regionIds;
          candidate.correspondences = candidate.correspondences.filter(item => item.id !== edit.correspondence.id && !(
            pair?.length === 2 && ['same-part', 'possible-match'].includes(edit.correspondence.kind) &&
            item.regionIds?.length === 2 && ['same-part', 'possible-match'].includes(item.kind) &&
            item.regionIds.includes(pair[0]) && item.regionIds.includes(pair[1])
          ));
          candidate.correspondences.push({ ...structuredClone(edit.correspondence), origin: 'manual' }); changed.add(edit.correspondence.id);
        } else if (edit.op === 'reference.setTransform') {
          const source = candidate.sources.find(item => item.id === edit.sourceId) ?? fail('INVALID_ARGUMENT: Source does not exist.');
          if (source.role === 'primary') fail('INVALID_ARGUMENT: The primary source defines canonical coordinates.');
          source.transformToPrimary = edit.transformToPrimary ? [...edit.transformToPrimary] as typeof edit.transformToPrimary : undefined;
          changed.add(source.id);
        } else if (edit.op === 'reference.setBackground') {
          const source = candidate.sources.find(item => item.id === edit.sourceId) ?? fail('INVALID_ARGUMENT: Source does not exist.');
          if (edit.color !== undefined && edit.color !== null && (typeof edit.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(edit.color)))
            fail('INVALID_ARGUMENT: Background color must be a six-digit hex value, null, or omitted for automatic selection.');
          if (edit.color === undefined) delete source.backgroundColor;
          else source.backgroundColor = edit.color === null ? null : edit.color.toLowerCase();
          changed.add(source.id);
        } else if (edit.op === 'reference.alignFromLandmarks') {
          const source = candidate.sources.find(item => item.id === edit.sourceId) ?? fail('INVALID_ARGUMENT: Source does not exist.');
          source.transformToPrimary = landmarkAlignment(candidate, edit.sourceId, edit.landmarkIds);
          changed.add(source.id);
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
            else if (edit.target === 'attachment') target.attachmentLocked = edit.locked;
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
      if (request.edits.some(edit => ['region.refineMask', 'region.featherOutside', 'region.seedMask', 'region.split', 'region.merge', 'part.create', 'part.assignRegion'].includes(edit.op)))
        for (const item of candidate.parts) if (!item.attachmentApproved && !item.attachmentLocked) item.attachmentProposal = undefined;
      activeEditIndex = undefined;
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
      const explicit = /^([A-Z][A-Z_]+):\s*/.exec(message)?.[1];
      const code = explicit ?? (/\bdoes not exist\b|\bnot found\b/i.test(message) ? 'TARGET_NOT_FOUND' : 'INVALID_ARGUMENT');
      const edit = activeEditIndex === undefined ? undefined : request.edits[activeEditIndex];
      const targetId = edit && typeof edit === 'object' && !Array.isArray(edit)
        ? 'regionId' in edit ? edit.regionId : 'partId' in edit ? edit.partId : 'sourceId' in edit ? edit.sourceId : 'firstId' in edit ? edit.firstId : undefined : undefined;
      return { ok: false, revision: this.revision, error: { code, message,
        ...(activeEditIndex === undefined ? {} : { editIndex: activeEditIndex }), ...(typeof targetId === 'string' && targetId ? { targetId } : {}),
        ...(code === 'TARGET_NOT_FOUND' ? { suggestion: 'Reinspect the current document and use a current region, part, or source ID.' } : {}) } };
    }
  }
  async close(): Promise<void> { this.closed = true; this.images.clear(); this.sourceBytes.clear(); this.masks.clear(); this.stagedMasks.clear(); this.undoStack = []; this.redoStack = []; }
}
