import { ALGORITHM_VERSION, fitMaskGeometry } from './analysis';
import { shapePathCommands } from '../shapePath';
import type { Box, DecompositionDiagnostic, DecompositionDocumentV1, LayerRecord, Point, RegionMask, RegionRecord } from './types';

/** Additions only. The caller owns document integration and preservation of manual edits. */
export interface HiddenContinuationProposals {
  regions: RegionRecord[];
  masks: Map<string, RegionMask>;
  layers: LayerRecord[];
  diagnostics: DecompositionDiagnostic[];
}

const MAX_PROPOSALS = 16;
const MAX_VISIBLE_REGIONS = 512;
const MAX_CANDIDATE_PAIRS = 64;
const MAX_FRONT_PIXELS = 100_000;
const MAX_FRONT_PATH_POINTS = 128;
const MAX_HIDDEN_PIXELS = 500_000;
const DIRECTIONS = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
const EIGHT_NEIGHBORS = [-1, 0, 1] as const;

function stableId(back: string, front: string): string {
  let value = 0xcbf29ce484222325n;
  for (const code of `${back}/${front}`) value = (value ^ BigInt(code.charCodeAt(0))) * 0x100000001b3n & 0xffffffffffffffffn;
  return `hidden_${value.toString(16).padStart(16, '0')}`;
}

function contains(region: RegionRecord, mask: RegionMask, x: number, y: number): boolean {
  const localX = x - region.bounds.x, localY = y - region.bounds.y;
  return localX >= 0 && localY >= 0 && localX < mask.width && localY < mask.height && mask.bytes[localY * mask.width + localX] !== 0;
}

function strictlyInside(outer: Box, inner: Box): boolean {
  return inner.x > outer.x && inner.y > outer.y && inner.x + inner.width < outer.x + outer.width && inner.y + inner.height < outer.y + outer.height;
}

function pathPoints(region: RegionRecord): Point[] | null {
  // A pinned manual outline is user intent, not evidence for another
  // automatically inferred hidden surface.
  if (region.geometry.manualPath) return null;
  const path = region.geometry.generatedPath;
  const commands = shapePathCommands(path, region.bounds.width, region.bounds.height);
  const points: Point[] = [];
  let previous: Point | undefined;
  const distance = (point: Point, start: Point, end: Point) => {
    const dx = end.x - start.x, dy = end.y - start.y;
    const t = dx || dy ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy))) : 0;
    return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
  };
  const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const flatten = (a: Point, b: Point, c: Point, d: Point, depth: number): boolean => {
    if (Math.max(distance(b, a, d), distance(c, a, d)) <= .08) { points.push(d); return points.length <= 4096; }
    if (depth >= 12 || points.length >= 4096) return false;
    const ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d);
    const abc = midpoint(ab, bc), bcd = midpoint(bc, cd), center = midpoint(abc, bcd);
    return flatten(a, ab, abc, center, depth + 1) && flatten(center, bcd, cd, d, depth + 1);
  };
  for (const command of commands) {
    if (command.type === 'close') continue;
    const point = { x: command.x, y: command.y };
    if (command.type === 'move') points.push(point);
    else if (command.type === 'line') points.push(point);
    else if (command.type === 'cubic' && (!previous || !flatten(previous, { x: command.x1, y: command.y1 }, { x: command.x2, y: command.y2 }, point, 0))) return null;
    previous = point;
  }
  if (points.length > 3 && Math.hypot(points[0].x - points.at(-1)!.x, points[0].y - points.at(-1)!.y) < 1e-9) points.pop();
  return points.length >= 3 && points.length <= 4096 ? points.map(point => ({ x: point.x + region.bounds.x, y: point.y + region.bounds.y })) : null;
}

function polygonContains(points: Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function opaqueAndEnclosed(front: RegionRecord, frontMask: RegionMask, back: RegionRecord, backMask: RegionMask, rgba: Uint8Array, width: number): { contact: number } | null {
  let contact = 0, perimeter = 0, pixels = 0;
  for (let y = front.bounds.y; y < front.bounds.y + front.bounds.height; y++) for (let x = front.bounds.x; x < front.bounds.x + front.bounds.width; x++) {
    if (!contains(front, frontMask, x, y)) continue;
    if (frontMask.alpha && frontMask.alpha[(y - front.bounds.y) * frontMask.width + x - front.bounds.x] !== 255) return null;
    pixels++;
    if (rgba[(y * width + x) * 4 + 3] !== 255 || contains(back, backMask, x, y)) return null;
    for (const [dx, dy] of DIRECTIONS) {
      const nx = x + dx, ny = y + dy;
      if (contains(front, frontMask, nx, ny)) continue;
      perimeter++;
      if (contains(back, backMask, nx, ny)) contact++;
    }
  }
  if (!pixels || pixels !== front.pixelCount || !perimeter || contact / perimeter < .9) return null;
  return { contact: contact / perimeter };
}

function erodedInterior(front: RegionRecord, mask: RegionMask, rgba: Uint8Array, imageWidth: number): { bounds: Box; mask: RegionMask; count: number } | null {
  const { width, height } = mask;
  let current = Uint8Array.from(mask.bytes);
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(current.length);
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      if (!current[index]) continue;
      let interior = true;
      for (const dy of EIGHT_NEIGHBORS) for (const dx of EIGHT_NEIGHBORS) if (!current[(y + dy) * width + x + dx]) interior = false;
      if (interior && rgba[((front.bounds.y + y) * imageWidth + front.bounds.x + x) * 4 + 3] === 255) next[index] = 1;
    }
    current = next;
  }
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (current[y * width + x]) {
    count++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (count < 9) return null;
  const bounds = { x: front.bounds.x + minX, y: front.bounds.y + minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const bytes = new Uint8Array(bounds.width * bounds.height);
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) bytes[(y - minY) * bounds.width + x - minX] = current[y * width + x];
  return { bounds, mask: { width: bounds.width, height: bounds.height, bytes }, count };
}

function connected(mask: RegionMask, count: number): boolean {
  const start = mask.bytes.indexOf(1);
  if (start < 0) return false;
  const seen = new Uint8Array(mask.bytes.length), queue = new Int32Array(count);
  let head = 0, tail = 0; queue[tail++] = start; seen[start] = 1;
  while (head < tail) {
    const index = queue[head++], x = index % mask.width, y = (index / mask.width) | 0;
    for (const next of [x > 0 ? index - 1 : -1, x + 1 < mask.width ? index + 1 : -1, y > 0 ? index - mask.width : -1, y + 1 < mask.height ? index + mask.width : -1]) {
      if (next < 0 || !mask.bytes[next] || seen[next]) continue;
      seen[next] = 1; queue[tail++] = next;
    }
  }
  return tail === count;
}

/** Raster-center containment plus two-pixel inset limits any exported hidden path to pixels covered by the front path. */
function coveredInSourcePose(hidden: RegionRecord, front: RegionRecord, frontMask: RegionMask, rgba: Uint8Array, imageWidth: number): boolean {
  const frontPath = pathPoints(front), hiddenPath = pathPoints(hidden);
  if (!frontPath || !hiddenPath) return false;
  const { bounds } = hidden;
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
    if (!polygonContains(hiddenPath, x + .5, y + .5)) continue;
    if (!contains(front, frontMask, x, y) || rgba[(y * imageWidth + x) * 4 + 3] !== 255) return false;
    // Check a small margin as well as the center so native antialias fringes
    // remain under the foreground path after the source-pose composition.
    for (const sy of [.1, .5, .9]) for (const sx of [.1, .5, .9]) if (!polygonContains(frontPath, x + sx, y + sy)) return false;
  }
  return true;
}

/** Conservative, local geometric evidence only; no motion or unseen texture is fabricated. */
export function proposeHiddenContinuations(document: DecompositionDocumentV1, masks: ReadonlyMap<string, RegionMask>, sourceRgba: Uint8Array): HiddenContinuationProposals {
  const result: HiddenContinuationProposals = { regions: [], masks: new Map(), layers: [], diagnostics: [] };
  const primary = document.sources.find(source => source.role === 'primary');
  if (!primary || sourceRgba.length !== primary.width * primary.height * 4) throw new Error('Primary source pixels are missing or malformed.');
  if (document.mode !== 'animation-ready') return result;
  const visible = document.regions.filter(region => region.sourceId === primary.id && region.generationStatus !== 'historical' && region.geometry.status === 'visible').sort((a, b) => a.id.localeCompare(b.id));
  if (visible.length > MAX_VISIBLE_REGIONS) {
    result.diagnostics.push({ code: 'AMBIGUOUS_REGION', severity: 'info', sourceId: primary.id,
      message: 'Automatic hidden continuation is skipped for this highly fragmented source.', suggestion: 'Merge meaningful visible regions or annotate the overlap manually.' });
    return result;
  }
  const existing = new Set(document.regions.map(region => region.id));
  let totalHiddenPixels = 0, candidatePairs = 0;
  for (const back of visible.filter(region => region.holeCount > 0)) {
    const backMask = masks.get(back.maskId);
    if (!backMask) throw new Error(`Missing source mask for ${back.id}.`);
    for (const front of visible) {
      if (result.regions.length >= MAX_PROPOSALS) {
        result.diagnostics.push({ code: 'RESOURCE_LIMIT', severity: 'info', sourceId: primary.id,
          message: 'Automatic hidden continuation reached the proposal-count limit.', suggestion: 'Review existing proposals and annotate further overlaps manually.' });
        return result;
      }
      if (front.id === back.id || front.holeCount || front.pixelCount >= back.pixelCount || !strictlyInside(back.bounds, front.bounds)) continue;
      if (++candidatePairs > MAX_CANDIDATE_PAIRS) {
        result.diagnostics.push({ code: 'RESOURCE_LIMIT', severity: 'info', sourceId: primary.id,
          message: 'Hidden continuation candidate comparisons reached the bounded analysis budget.', suggestion: 'Annotate the intended front/back pair manually.' });
        return result;
      }
      const frontMask = masks.get(front.maskId);
      if (!frontMask) throw new Error(`Missing source mask for ${front.id}.`);
      if (front.pixelCount > MAX_FRONT_PIXELS || front.bounds.width * front.bounds.height > MAX_FRONT_PIXELS) {
        result.diagnostics.push({ code: 'RESOURCE_LIMIT', severity: 'info', sourceId: primary.id, regionId: front.id,
          message: 'Hidden continuation proposal skipped because the enclosed foreground region exceeds the bounded analysis area.', suggestion: 'Crop or manually annotate this overlap.' });
        continue;
      }
      const evidence = opaqueAndEnclosed(front, frontMask, back, backMask, sourceRgba, primary.width);
      const frontPath = pathPoints(front);
      if (!evidence || !frontPath || frontPath.length > MAX_FRONT_PATH_POINTS) continue;
      const inferred = erodedInterior(front, frontMask, sourceRgba, primary.width);
      if (!inferred || !connected(inferred.mask, inferred.count)) continue;
      if (totalHiddenPixels + inferred.mask.bytes.length > MAX_HIDDEN_PIXELS) {
        result.diagnostics.push({ code: 'RESOURCE_LIMIT', severity: 'info', sourceId: primary.id, regionId: front.id,
          message: 'Hidden continuation proposals reached the bounded mask budget.', suggestion: 'Crop or manually annotate additional overlaps.' });
        return result;
      }
      const id = stableId(back.id, front.id);
      if (existing.has(id) || result.regions.some(region => region.id === id)) continue;
      let fitted: ReturnType<typeof fitMaskGeometry>;
      try {
        fitted = fitMaskGeometry(id, inferred.mask, inferred.bounds, { ...document.settings, pathTolerance: Math.min(document.settings.pathTolerance, .5) }, 'flat');
      } catch {
        continue;
      }
      if (fitted.holeCount || fitted.geometry.quality.maskIoU < .98) continue;
      const hidden: RegionRecord = {
        id, sourceId: primary.id, maskId: `${id}_mask`, bounds: inferred.bounds, pixelCount: inferred.count,
        classification: 'foreground', color: back.color, colorVariance: back.colorVariance,
        confidence: { kind: 'heuristic', reasons: [
          'fully opaque front region has a source-mask boundary enclosed by the larger visible back region',
          'inferred interior is inset two source pixels and covered by the front path in the source pose',
          'hidden continuation color is only an estimate from the visible back region; no source pixel reveals its actual appearance',
        ] },
        provenance: { algorithmVersion: ALGORITHM_VERSION, settingsFingerprint: back.provenance.settingsFingerprint },
        generationStatus: 'generated', locked: { mask: false, geometry: false, part: false },
        lineage: { parents: [], children: [] }, partId: back.partId,
        geometry: { ...fitted.geometry, status: 'inferred' }, holeCount: 0, adjacency: [],
      };
      if (!coveredInSourcePose(hidden, front, frontMask, sourceRgba, primary.width)) continue;
      totalHiddenPixels += inferred.mask.bytes.length;
      result.regions.push(hidden);
      result.masks.set(hidden.maskId, inferred.mask);
      result.layers.push({ id: `${id}_layer`, frontRegionId: front.id, backRegionId: id, origin: 'automatic', status: 'proposed',
        evidence: ['enclosed opaque front-mask boundary', `visible back region contacts ${(evidence.contact * 100).toFixed(1)}% of the front perimeter`, 'inset hidden geometry is covered in the source pose'] });
      result.diagnostics.push({ code: 'HIDDEN_GEOMETRY_INFERRED', severity: 'warning', sourceId: primary.id, regionId: id, bounds: inferred.bounds,
        message: 'A conservative hidden continuation is proposed beneath the opaque front region. Its unseen color and shape remain uncertain.',
        suggestion: 'Inspect the isolated part and approve or edit the hidden geometry before articulating it.',
        evidence: [`visible back region ${back.id}`, `fully opaque front region ${front.id}`, 'two-pixel inset and front-path containment'] });
    }
  }
  return result;
}
