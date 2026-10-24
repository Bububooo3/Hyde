import type { PathPoint, ShapeContour, ShapePath } from '../model';
import type { Box, CorrespondenceRecord, DecompositionDiagnostic, DecompositionMode, LayerRecord, PartRecord, Point, ReconstructionSettings, RegionGeometry, RegionMask, RegionRecord, SourceReference } from './types';
import type { DecodedImage } from './image';

export const ALGORITHM_VERSION = 'deterministic-regions-3';
interface Component { id: number; count: number; minX: number; minY: number; maxX: number; maxY: number; r: number; g: number; b: number; variance: number; partialAlpha: number }
interface BoundaryEvidence { shared: number; contrast: number; coarse2: number; coarse4: number }
export interface AnalysisResult { regions: RegionRecord[]; parts: PartRecord[]; masks: Map<string, RegionMask>; layers: LayerRecord[]; diagnostics: DecompositionDiagnostic[] }
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('CANCELED'); };
const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map(value => clamp(value).toString(16).padStart(2, '0')).join('')}`;
const rgbDistance = (a: Pick<Component, 'r' | 'g' | 'b'>, b: Pick<Component, 'r' | 'g' | 'b'>) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
const pixelDistance = (rgba: Uint8Array, a: number, b: number) => {
  const left = a * 4, right = b * 4;
  return Math.hypot(rgba[left] - rgba[right], rgba[left + 1] - rgba[right + 1], rgba[left + 2] - rgba[right + 2]);
};
const boxContains = (a: Box, b: Box) => b.x > a.x && b.y > a.y && b.x + b.width < a.x + a.width && b.y + b.height < a.y + a.height;
const area = (points: Point[]) => points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y;
}, 0) / 2;
const pointDistance = (point: Point, a: Point, b: Point) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx || dy ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
};
/** Simplify each of two closed-contour arcs against the *original* pixels.
 * Removing each vertex against its newly shortened neighbors can snowball until
 * a smooth silhouette has only three points even for a subpixel tolerance.
 */
function simplify(points: Point[], tolerance: number, maxPoints: number): Point[] {
  if (points.length <= 3) return points;
  const first = points.reduce((best, point, index) => point.y < points[best].y || point.y === points[best].y && point.x < points[best].x ? index : best, 0);
  const anchor = points[first];
  const opposite = points.reduce((best, point, index) => {
    const distance = (point.x - anchor.x) ** 2 + (point.y - anchor.y) ** 2;
    const previous = (points[best].x - anchor.x) ** 2 + (points[best].y - anchor.y) ** 2;
    return distance > previous ? index : best;
  }, first);
  if (opposite === first) throw new Error('PATH_TOO_COMPLEX');
  const n = points.length;
  const arc = (from: number, to: number, error: number) => {
    const count = (to - from + n) % n + 1;
    const selected = new Uint8Array(count); selected[0] = selected[count - 1] = 1;
    const stack: [number, number][] = [[0, count - 1]];
    while (stack.length) {
      const [start, end] = stack.pop()!;
      let farthest = -1, distance = error;
      const a = points[(from + start) % n], b = points[(from + end) % n];
      for (let offset = start + 1; offset < end; offset++) {
        const current = pointDistance(points[(from + offset) % n], a, b);
        if (current > distance) { distance = current; farthest = offset; }
      }
      if (farthest >= 0) { selected[farthest] = 1; stack.push([start, farthest], [farthest, end]); }
    }
    const result: Point[] = [];
    for (let offset = 0; offset < count; offset++) if (selected[offset]) result.push(points[(from + offset) % n]);
    return result;
  };
  let error = Math.max(0, tolerance);
  for (let attempt = 0; attempt < 64; attempt++) {
    const current = [...arc(first, opposite, error).slice(0, -1), ...arc(opposite, first, error).slice(0, -1)];
    if (current.length >= 3 && current.length <= maxPoints) return current;
    // A narrow contour can collapse to two vertices at the requested tolerance.
    // Increasing the error further can never recover a valid closed path.
    error = current.length < 3 ? error / 2 : error ? error * 1.5 : 0.25;
    if (error > 128 || error < 1e-6) break;
  }
  throw new Error('PATH_TOO_COMPLEX');
}
function contours(mask: RegionMask, offsetX: number, offsetY: number): Point[][] {
  const { width, height, bytes } = mask;
  const vertex = (x: number, y: number) => y * (width + 1) + x;
  const fromVertex = (key: number): Point => ({ x: offsetX + key % (width + 1), y: offsetY + Math.floor(key / (width + 1)) });
  const edges: { from: number; to: number; used: boolean }[] = [];
  const outgoing = new Map<number, number[]>();
  const add = (from: number, to: number) => {
    const index = edges.length; edges.push({ from, to, used: false });
    const list = outgoing.get(from) ?? []; list.push(index); outgoing.set(from, list);
  };
  const has = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && bytes[y * width + x] !== 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (has(x, y)) {
    if (!has(x, y - 1)) add(vertex(x, y), vertex(x + 1, y));
    if (!has(x + 1, y)) add(vertex(x + 1, y), vertex(x + 1, y + 1));
    if (!has(x, y + 1)) add(vertex(x + 1, y + 1), vertex(x, y + 1));
    if (!has(x - 1, y)) add(vertex(x, y + 1), vertex(x, y));
  }
  const loops: Point[][] = [];
  for (let start = 0; start < edges.length; start++) {
    if (edges[start].used) continue;
    const path: Point[] = []; let current = start;
    for (let count = 0; count <= edges.length; count++) {
      const edge = edges[current];
      if (edge.used) break;
      edge.used = true; path.push(fromVertex(edge.from));
      if (edge.to === edges[start].from) break;
      const next = outgoing.get(edge.to)?.find(index => !edges[index].used);
      if (next === undefined) throw new Error('Region boundary is open.');
      current = next;
    }
    if (path.length >= 3) loops.push(path);
  }
  return loops.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
}
function polygonContains(points: Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function sampledIoU(points: Point[], mask: RegionMask, bounds: Box): number {
  const stride = Math.max(1, Math.ceil(Math.sqrt(mask.bytes.length / 30_000)));
  let intersection = 0, union = 0;
  for (let y = 0; y < mask.height; y += stride) for (let x = 0; x < mask.width; x += stride) {
    const expected = mask.bytes[y * mask.width + x] !== 0;
    const actual = polygonContains(points, bounds.x + x + .5, bounds.y + y + .5);
    if (expected && actual) intersection++;
    if (expected || actual) union++;
  }
  return union ? intersection / union : 1;
}

function contourAgreement(original: Point[], fitted: Point[]): number {
  const bounds = original.reduce((box, point) => ({ left: Math.min(box.left, point.x), right: Math.max(box.right, point.x),
    top: Math.min(box.top, point.y), bottom: Math.max(box.bottom, point.y) }),
  { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
  const left = Math.floor(bounds.left), right = Math.ceil(bounds.right);
  const top = Math.floor(bounds.top), bottom = Math.ceil(bounds.bottom);
  let intersection = 0, union = 0;
  const stride = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, (right - left) * (bottom - top)) / 30_000)));
  for (let y = top; y < bottom; y += stride) for (let x = left; x < right; x += stride) {
    const expected = polygonContains(original, x + .5, y + .5), actual = polygonContains(fitted, x + .5, y + .5);
    if (expected && actual) intersection++;
    if (expected || actual) union++;
  }
  return union ? intersection / union : 1;
}

function flattenedPath(points: PathPoint[]): Point[] {
  const flattened: Point[] = [];
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    flattened.push({ x: a.x, y: a.y });
    if (!a.out && !b.in) continue;
    const p = a.out ?? a, q = b.in ?? b;
    const steps = Math.min(32, Math.max(4, Math.ceil((Math.hypot(p.x - a.x, p.y - a.y) + Math.hypot(q.x - p.x, q.y - p.y) + Math.hypot(b.x - q.x, b.y - q.y)) / .5)));
    for (let step = 1; step < steps; step++) {
      const t = step / steps, u = 1 - t;
      flattened.push({ x: u ** 3 * a.x + 3 * u ** 2 * t * p.x + 3 * u * t ** 2 * q.x + t ** 3 * b.x,
        y: u ** 3 * a.y + 3 * u ** 2 * t * p.y + 3 * u * t ** 2 * q.y + t ** 3 * b.y });
    }
  }
  return flattened;
}

function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (u: Point, v: Point, w: Point) => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return abC * abD < -1e-10 && cdA * cdB < -1e-10;
}

function selfIntersects(points: Point[]): boolean {
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) return true;
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      const c = points[j], d = points[(j + 1) % points.length];
      if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x)
        || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) continue;
      if (intersects(a, b, c, d)) return true;
    }
  }
  return false;
}

/** Move partially covered outer edges a bounded subpixel distance *outside*
 * the source pixel. The source-crop alpha owns the true antialias coverage;
 * shrinking its clipping path would multiply that alpha and erase the fringe. */
function coverageContour(loop: Point[], mask: RegionMask, bounds: Box, coverage?: Uint8Array): Point[] {
  if (!coverage || coverage.length !== mask.bytes.length) return loop;
  const inward = (a: Point, b: Point) => {
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length, ny = dx / length;
    const x = Math.floor((a.x + b.x) / 2 + nx * .25 - bounds.x);
    const y = Math.floor((a.y + b.y) / 2 + ny * .25 - bounds.y);
    const alpha = x >= 0 && y >= 0 && x < mask.width && y < mask.height ? coverage[y * mask.width + x] : 255;
    const shift = alpha < 255 ? -Math.min(.22, (255 - alpha) / 255 * .3) : 0;
    return { nx, ny, shift };
  };
  return loop.map((point, index) => {
    const before = inward(loop[(index + loop.length - 1) % loop.length], point);
    const after = inward(point, loop[(index + 1) % loop.length]);
    if (!before.shift && !after.shift) return point;
    const divisor = Math.max(.5, 1 + before.nx * after.nx + before.ny * after.ny);
    return { x: point.x + (before.nx * before.shift + after.nx * after.shift) / divisor,
      y: point.y + (before.ny * before.shift + after.ny * after.shift) / divisor };
  });
}

function arcPoints(loop: Point[], from: number, to: number): Point[] {
  const result = [loop[from]];
  for (let at = (from + 1) % loop.length; at !== to; at = (at + 1) % loop.length) result.push(loop[at]);
  result.push(loop[to]);
  return result;
}

function cubicPoint(a: Point, p: Point, q: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return { x: u ** 3 * a.x + 3 * u ** 2 * t * p.x + 3 * u * t ** 2 * q.x + t ** 3 * b.x,
    y: u ** 3 * a.y + 3 * u ** 2 * t * p.y + 3 * u * t ** 2 * q.y + t ** 3 * b.y };
}

function fitCubic(arc: Point[], tolerance: number): { out: Point; in: Point; error: number; lineError: number } | null {
  if (arc.length < 5 || arc.length > 256) return null;
  const a = arc[0], b = arc[arc.length - 1], chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (chord < 3) return null;
  const tangent = (from: Point, to: Point) => {
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    return length ? { x: (to.x - from.x) / length, y: (to.y - from.y) / length } : null;
  };
  const left = tangent(a, arc[Math.min(3, arc.length - 2)]), right = tangent(arc[Math.max(1, arc.length - 4)], b);
  if (!left || !right) return null;
  const distances = new Float64Array(arc.length);
  for (let index = 1; index < arc.length; index++) distances[index] = distances[index - 1] + Math.hypot(arc[index].x - arc[index - 1].x, arc[index].y - arc[index - 1].y);
  const total = distances[arc.length - 1];
  let xx = 0, xy = 0, yy = 0, bx = 0, by = 0;
  for (let index = 1; index < arc.length - 1; index++) {
    const t = distances[index] / total, u = 1 - t;
    const first = 3 * u * u * t, second = 3 * u * t * t;
    const ax = left.x * first, ay = left.y * first, cx = -right.x * second, cy = -right.y * second;
    const baseX = (u ** 3 + first) * a.x + (second + t ** 3) * b.x;
    const baseY = (u ** 3 + first) * a.y + (second + t ** 3) * b.y;
    const ex = arc[index].x - baseX, ey = arc[index].y - baseY;
    xx += ax * ax + ay * ay; xy += ax * cx + ay * cy; yy += cx * cx + cy * cy;
    bx += ax * ex + ay * ey; by += cx * ex + cy * ey;
  }
  const determinant = xx * yy - xy * xy;
  const leftLength = determinant > 1e-8 ? (bx * yy - by * xy) / determinant : chord / 3;
  const rightLength = determinant > 1e-8 ? (by * xx - bx * xy) / determinant : chord / 3;
  if (!Number.isFinite(leftLength) || !Number.isFinite(rightLength) || leftLength < chord * .08 || rightLength < chord * .08
    || leftLength > chord * .8 || rightLength > chord * .8) return null;
  const out = { x: a.x + left.x * leftLength, y: a.y + left.y * leftLength };
  const incoming = { x: b.x - right.x * rightLength, y: b.y - right.y * rightLength };
  let error = 0, lineError = 0;
  for (let index = 1; index < arc.length - 1; index++) {
    const t = distances[index] / total, fitted = cubicPoint(a, out, incoming, b, t);
    error = Math.max(error, Math.hypot(fitted.x - arc[index].x, fitted.y - arc[index].y));
    lineError = Math.max(lineError, pointDistance(arc[index], a, b));
  }
  // The reverse check prevents a curve from bulging between sampled pixels.
  const steps = Math.min(48, Math.max(12, Math.ceil(total)));
  for (let step = 1; step < steps; step++) {
    const point = cubicPoint(a, out, incoming, b, step / steps);
    let closest = Infinity;
    for (let index = 0; index < arc.length - 1; index++) closest = Math.min(closest, pointDistance(point, arc[index], arc[index + 1]));
    error = Math.max(error, closest);
  }
  if (error > Math.max(.35, Math.min(.85, tolerance)) || lineError < .28 || error > lineError * .9) return null;
  return { out, in: incoming, error, lineError };
}

function curvedContour(loop: Point[], anchors: Point[], tolerance: number): PathPoint[] {
  if (anchors.length < 4 || anchors.length > 256 || loop.length > 8192) return anchors.map(point => ({ ...point }));
  const indexOf = new Map(loop.map((point, index) => [point, index]));
  const indices = anchors.map(point => indexOf.get(point)!);
  // Remove only smooth anchors for which a single cubic follows every source
  // boundary sample. A long, abrupt turn remains a straight pixel-art corner.
  for (let pass = 0; pass < 2; pass++) for (let index = 0; index < indices.length && indices.length > 3; index++) {
    const previous = indices[(index + indices.length - 1) % indices.length], current = indices[index], next = indices[(index + 1) % indices.length];
    const before = arcPoints(loop, previous, current), after = arcPoints(loop, current, next);
    if (before.length < 3 || after.length < 3 || before.length + after.length > 257) continue;
    const first = before[Math.max(0, before.length - 4)], last = after[Math.min(3, after.length - 1)];
    const u = { x: loop[current].x - first.x, y: loop[current].y - first.y }, v = { x: last.x - loop[current].x, y: last.y - loop[current].y };
    const cosine = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y) || 1);
    if (cosine < .6) continue;
    if (fitCubic(arcPoints(loop, previous, next), tolerance)) { indices.splice(index, 1); index--; }
  }
  const points: PathPoint[] = indices.map(index => ({ ...loop[index] }));
  for (let index = 0; index < indices.length; index++) {
    const fit = fitCubic(arcPoints(loop, indices[index], indices[(index + 1) % indices.length]), tolerance);
    if (!fit) continue;
    points[index].out = fit.out;
    points[(index + 1) % indices.length].in = fit.in;
  }
  return points;
}

function fitVisibleContour(loop: Point[], mask: RegionMask, bounds: Box, settings: ReconstructionSettings, hasHoles: boolean, coverage?: Uint8Array) {
  let tolerance = settings.pathTolerance;
  let outer = simplify(loop, tolerance, settings.maxPathPoints);
  let quality = sampledIoU(outer, mask, bounds);
  // Use the requested tolerance as the initial complexity budget. If it drops
  // visible source pixels, spend a few more vertices while within maxPoints.
  // A compound region is scored after fitting its interior contours; do not
  // refine only the outside against a mask that includes transparent holes.
  for (let attempt = 0; attempt < 3 && !hasHoles && quality < .98 && tolerance > .08; attempt++) {
    tolerance /= 2;
    const candidate = simplify(loop, tolerance, settings.maxPathPoints);
    const improved = sampledIoU(candidate, mask, bounds);
    if (improved > quality) { outer = candidate; quality = improved; }
  }
  const refined = coverageContour(loop, mask, bounds, coverage);
  let trace = loop;
  if (refined !== loop) {
    const candidate = simplify(refined, tolerance, settings.maxPathPoints);
    const improved = sampledIoU(candidate, mask, bounds);
    if (improved >= quality - .005 && !selfIntersects(candidate)) { outer = candidate; trace = refined; }
  }
  const path = curvedContour(trace, outer, tolerance);
  const flattened = flattenedPath(path);
  const curvedQuality = sampledIoU(flattened, mask, bounds);
  if (path.length >= 3 && path.length <= settings.maxPathPoints && flattened.length <= 4096
    && !selfIntersects(flattened) && Math.abs(area(flattened)) > 1e-5
    && curvedQuality >= quality - .005 && (hasHoles || curvedQuality >= .98)) return { path, quality: curvedQuality };
  return { path: outer.map(point => ({ ...point })), quality: sampledIoU(outer, mask, bounds) };
}

function normalizedPath(path: PathPoint[], bounds: Box, holes: PathPoint[][] = []): ShapePath {
  const normalize = (point: Point) => ({ x: (point.x - bounds.x) / bounds.width, y: (point.y - bounds.y) / bounds.height });
  const contour = (points: PathPoint[]): ShapeContour => ({ points: points.map(point => ({ ...normalize(point),
    ...(point.in ? { in: normalize(point.in) } : {}), ...(point.out ? { out: normalize(point.out) } : {}) })) });
  return { ...contour(path), ...(holes.length ? { holes: holes.map(contour) } : {}) };
}

function sampledCompoundIoU(outer: Point[], holes: Point[][], mask: RegionMask, bounds: Box): number {
  const stride = Math.max(1, Math.ceil(Math.sqrt(mask.bytes.length / 30_000)));
  let intersection = 0, union = 0;
  for (let y = 0; y < mask.height; y += stride) for (let x = 0; x < mask.width; x += stride) {
    const px = bounds.x + x + .5, py = bounds.y + y + .5;
    const expected = mask.bytes[y * mask.width + x] !== 0;
    const actual = polygonContains(outer, px, py) && !holes.some(hole => polygonContains(hole, px, py));
    if (expected && actual) intersection++;
    if (expected || actual) union++;
  }
  return union ? intersection / union : 1;
}

/** Reject a fitted inner contour if it would move a source hole enough to
 * change its topology. Its raster evidence remains in the mask for fallback. */
function fitHoleContour(loop: Point[], settings: ReconstructionSettings): PathPoint[] | undefined {
  let tolerance = settings.pathTolerance;
  for (let attempt = 0; attempt < 4; attempt++) {
    let simplified: Point[];
    try { simplified = simplify(loop, tolerance, settings.maxPathPoints); }
    catch { return undefined; }
    const curved = curvedContour(loop, simplified, tolerance);
    const selected = [curved, simplified.map(point => ({ ...point }))].find(candidate => {
      const flattened = flattenedPath(candidate);
      return candidate.length >= 3 && candidate.length <= 4096 && flattened.length <= 4096 &&
        !selfIntersects(flattened) && Math.abs(area(flattened)) > 1e-5 && contourAgreement(loop, flattened) >= .98;
    });
    if (selected) return selected;
    tolerance /= 2;
    if (tolerance < .04) break;
  }
  return undefined;
}

function fitRegionContours(loops: Point[][], mask: RegionMask, bounds: Box, settings: ReconstructionSettings, coverage?: Uint8Array) {
  const { path } = fitVisibleContour(loops[0], mask, bounds, settings, loops.length > 1, coverage);
  const holes: PathPoint[][] = [];
  let pointCount = path.length;
  for (const loop of loops.slice(1)) {
    if (holes.length >= 64) break;
    const fitted = fitHoleContour(loop, settings);
    if (!fitted || pointCount + fitted.length > 16384) continue;
    holes.push(fitted); pointCount += fitted.length;
  }
  return { path: normalizedPath(path, bounds, holes), pointCount,
    holeCount: loops.length - 1,
    quality: sampledCompoundIoU(flattenedPath(path), holes.map(flattenedPath), mask, bounds) };
}

export function fitMaskGeometry(id: string, mask: RegionMask, bounds: Box, settings: ReconstructionSettings, texture: RegionGeometry['texture']): { geometry: RegionGeometry; holeCount: number } {
  const loops = contours(mask, bounds.x, bounds.y);
  if (!loops.length) throw new Error('Mask contains no foreground pixels.');
  if (loops.filter(loop => area(loop) > 0).length > 1) throw new Error('AMBIGUOUS_REGION: A single path cannot represent disconnected mask islands. Split them into separate regions.');
  const fitted = fitRegionContours(loops, mask, bounds, settings, mask.alpha);
  if (fitted.path.points.length > 4096) throw new Error('PATH_TOO_COMPLEX');
  return {
    geometry: { id: `${id}_geometry`, generatedPath: fitted.path, bounds,
      status: 'visible', quality: { maskIoU: fitted.quality, pathPointCount: fitted.pointCount, colorError: 0 }, texture, locked: false },
    holeCount: fitted.holeCount,
  };
}

function backgroundMask(image: DecodedImage, settings: ReconstructionSettings, diagnostics: DecompositionDiagnostic[], sourceId: string): Uint8Array {
  const { width, height, rgba } = image, total = width * height;
  const foreground = new Uint8Array(total);
  let transparent = 0;
  for (let index = 0; index < total; index++) if (rgba[index * 4 + 3] < settings.alphaThreshold) transparent++;
  if (transparent > total * .002) {
    for (let index = 0; index < total; index++) foreground[index] = rgba[index * 4 + 3] >= settings.alphaThreshold ? 1 : 0;
    return foreground;
  }
  // Opaque artwork: use the largest quantized border color as a *candidate* background.
  const border = new Map<string, { count: number; r: number; g: number; b: number }>();
  const observe = (x: number, y: number) => {
    const index = (y * width + x) * 4;
    const r = rgba[index], g = rgba[index + 1], b = rgba[index + 2];
    const key = [r, g, b].map(value => Math.floor(value / settings.colorStep)).join(':');
    const entry = border.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    entry.count++; entry.r += r; entry.g += g; entry.b += b; border.set(key, entry);
  };
  for (let x = 0; x < width; x++) { observe(x, 0); if (height > 1) observe(x, height - 1); }
  for (let y = 1; y < height - 1; y++) { observe(0, y); if (width > 1) observe(width - 1, y); }
  const ordered = [...border.values()].sort((a, b) => b.count - a.count);
  const dominant = ordered[0];
  const borderCount = width * 2 + Math.max(0, height - 2) * 2;
  if (!dominant || dominant.count / borderCount < .6) {
    diagnostics.push({ code: 'BACKGROUND_AMBIGUOUS', severity: 'warning', sourceId, message: 'Opaque border has no dominant color; the first pass retains all pixels as foreground.', suggestion: 'Mark background or provide a foreground mask.' });
    foreground.fill(1); return foreground;
  }
  const color = { r: dominant.r / dominant.count, g: dominant.g / dominant.count, b: dominant.b / dominant.count };
  foreground.fill(1);
  const queue = new Int32Array(total); let head = 0, tail = 0;
  const seed = (index: number) => {
    if (foreground[index] !== 1) return;
    const at = index * 4;
    if (Math.hypot(rgba[at] - color.r, rgba[at + 1] - color.g, rgba[at + 2] - color.b) > settings.colorStep * 1.6) return;
    foreground[index] = 0; queue[tail++] = index;
  };
  for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
  while (head < tail) {
    const index = queue[head++], x = index % width, y = (index / width) | 0;
    if (x > 0) seed(index - 1); if (x + 1 < width) seed(index + 1);
    if (y > 0) seed(index - width); if (y + 1 < height) seed(index + width);
  }
  return foreground;
}

/** Foreground-only 2× and 4× color evidence. Original pixels remain untouched. */
function colorPyramid(image: DecodedImage, foreground: Uint8Array, scale: 2 | 4, signal?: AbortSignal) {
  const width = Math.ceil(image.width / scale), height = Math.ceil(image.height / scale);
  const values = new Float32Array(width * height * 3), counts = new Uint8Array(width * height);
  for (let y = 0; y < image.height; y++) {
    if ((y & 63) === 0) abort(signal);
    for (let x = 0; x < image.width; x++) {
      const source = y * image.width + x;
      if (!foreground[source]) continue;
      const target = (Math.floor(y / scale) * width + Math.floor(x / scale));
      counts[target]++;
      for (let channel = 0; channel < 3; channel++) values[target * 3 + channel] += image.rgba[source * 4 + channel];
    }
  }
  for (let index = 0; index < counts.length; index++) if (counts[index]) {
    for (let channel = 0; channel < 3; channel++) values[index * 3 + channel] /= counts[index];
  }
  const distance = (a: number, b: number) => {
    const ax = a % image.width, ay = (a / image.width) | 0;
    const bx = b % image.width, by = (b / image.width) | 0;
    const left = Math.floor(ay / scale) * width + Math.floor(ax / scale);
    const right = Math.floor(by / scale) * width + Math.floor(bx / scale);
    return Math.hypot(values[left * 3] - values[right * 3], values[left * 3 + 1] - values[right * 3 + 1], values[left * 3 + 2] - values[right * 3 + 2]);
  };
  return { distance };
}

/** Connected, color-aware segmentation, with exact source masks and independent native paths. */
export function analyzeImage(image: DecodedImage, source: SourceReference, mode: DecompositionMode, settings: ReconstructionSettings, settingsFingerprint: string, signal?: AbortSignal): AnalysisResult {
  const { width, height, rgba } = image, total = width * height;
  const diagnostics: DecompositionDiagnostic[] = [];
  const foreground = backgroundMask(image, settings, diagnostics, source.id);
  const labels = new Int32Array(total); labels.fill(-1);
  const queue = new Int32Array(total);
  const components: Component[] = [];
  const bucket = (index: number) => {
    const at = index * 4;
    return ((rgba[at] / settings.colorStep) | 0) * 65536 + ((rgba[at + 1] / settings.colorStep) | 0) * 256 + ((rgba[at + 2] / settings.colorStep) | 0);
  };
  for (let start = 0; start < total; start++) {
    if (start % (width * 16) === 0) abort(signal);
    if (!foreground[start] || labels[start] !== -1) continue;
    const id = components.length, key = bucket(start);
    let head = 0, tail = 0, count = 0;
    let minX = width, minY = height, maxX = -1, maxY = -1, r = 0, g = 0, b = 0, squares = 0, partialAlpha = 0;
    labels[start] = id; queue[tail++] = start;
    while (head < tail) {
      if ((head & 65535) === 0) abort(signal);
      const index = queue[head++], x = index % width, y = (index / width) | 0, at = index * 4;
      count++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      r += rgba[at]; g += rgba[at + 1]; b += rgba[at + 2]; squares += rgba[at] ** 2 + rgba[at + 1] ** 2 + rgba[at + 2] ** 2;
      if (rgba[at + 3] < 255) partialAlpha++;
      const visit = (neighbor: number) => { if (foreground[neighbor] && labels[neighbor] === -1 && bucket(neighbor) === key) { labels[neighbor] = id; queue[tail++] = neighbor; } };
      if (x > 0) visit(index - 1); if (x + 1 < width) visit(index + 1);
      if (y > 0) visit(index - width); if (y + 1 < height) visit(index + width);
    }
    const means = { r: r / count, g: g / count, b: b / count };
    components.push({ id, count, minX, minY, maxX, maxY, ...means, variance: Math.max(0, squares / (count * 3) - (means.r ** 2 + means.g ** 2 + means.b ** 2) / 3), partialAlpha });
    if (components.length > 20_000) throw new Error('RESOURCE_LIMIT: Segmentation produced too many islands; increase minimum feature scale.');
  }
  const pyramid2 = colorPyramid(image, foreground, 2, signal);
  const pyramid4 = colorPyramid(image, foreground, 4, signal);
  const adjacency = new Map<string, BoundaryEvidence>();
  const interiorContrast = new Float64Array(components.length), interiorEdges = new Uint32Array(components.length);
  for (let y = 0; y < height; y++) {
    if ((y & 63) === 0) abort(signal);
    for (let x = 0; x < width; x++) {
      const index = y * width + x, left = labels[index]; if (left < 0) continue;
      for (const next of [x + 1 < width ? index + 1 : -1, y + 1 < height ? index + width : -1]) {
        if (next < 0 || labels[next] < 0) continue;
        const neighbor = labels[next], contrast = pixelDistance(rgba, index, next);
        if (neighbor === left) { interiorContrast[left] += contrast; interiorEdges[left]++; continue; }
        const key = `${Math.min(left, neighbor)}:${Math.max(left, neighbor)}`;
        const evidence = adjacency.get(key) ?? { shared: 0, contrast: 0, coarse2: 0, coarse4: 0 };
        evidence.shared++; evidence.contrast += contrast;
        evidence.coarse2 += pyramid2.distance(index, next);
        evidence.coarse4 += pyramid4.distance(index, next);
        adjacency.set(key, evidence);
      }
    }
  }
  const parent = Int32Array.from(components.map(item => item.id));
  const root = (id: number): number => { while (parent[id] !== id) id = parent[id] = parent[parent[id]]; return id; };
  const neighborMap = new Map<number, { other: number; shared: number }[]>();
  for (const [key, evidence] of adjacency) {
    const [a, b] = key.split(':').map(Number);
    for (const [id, other] of [[a, b], [b, a]]) {
      const list = neighborMap.get(id) ?? []; list.push({ other, shared: evidence.shared }); neighborMap.set(id, list);
    }
  }
  const narrowMark = (item: Component) => {
    const width = item.maxX - item.minX + 1, height = item.maxY - item.minY + 1;
    return Math.min(width, height) <= 2 && Math.max(width, height) >= 3;
  };
  const strongMarkBoundary = (id: number, other: number) => {
    const edge = adjacency.get(`${Math.min(id, other)}:${Math.max(id, other)}`);
    return edge !== undefined && edge.contrast / edge.shared >= Math.max(10, settings.colorStep * .6);
  };
  // Supersampled paint commonly makes one- or two-pixel transition colors at
  // silhouettes and paint boundaries. Keep high-contrast isolated marks as
  // possible real line art; moderate-color specks join a substantive neighbor.
  for (const component of components) {
    if (component.count >= settings.minRegionPixels) continue;
    const choice = (neighborMap.get(component.id) ?? [])
      .filter(item => components[item.other].count >= settings.minRegionPixels)
      .sort((a, b) => rgbDistance(component, components[a.other]) - rgbDistance(component, components[b.other]) || b.shared - a.shared || a.other - b.other)[0];
    if (choice && !(settings.preserveThinLines !== false && narrowMark(component) && strongMarkBoundary(component.id, choice.other))
      && (component.partialAlpha === component.count || rgbDistance(component, components[choice.other]) <= settings.colorStep * 3)) parent[root(component.id)] = root(choice.other);
  }
  for (const component of components) {
    if (component.count >= settings.minRegionPixels) continue;
    const choices = (neighborMap.get(component.id) ?? []).map(({ other, shared }) => {
      const edge = adjacency.get(`${Math.min(component.id, other)}:${Math.max(component.id, other)}`)!;
      return { other, shared, distance: rgbDistance(component, components[other]), contrast: edge.contrast / edge.shared };
    })
      .sort((a, b) => b.shared - a.shared || a.distance - b.distance || a.other - b.other);
    if (choices[0] && !(settings.preserveThinLines !== false && narrowMark(component) && strongMarkBoundary(component.id, choices[0].other))
      && choices[0].distance <= settings.colorStep * 2.5 && choices[0].contrast <= Math.max(8, settings.colorStep * .8)) parent[root(component.id)] = root(choices[0].other);
  }
  // Quantization can cut a smooth painted field into bands. At each candidate
  // seam compare original pixel contrast with variation *inside* both bands,
  // then require agreement in the 2×/4× pyramid. A flat hard edge has no
  // interior variation and stays a separate editable paint region.
  const smoothSeams = [...adjacency.entries()].sort(([a], [b]) => {
    const [a1, a2] = a.split(':').map(Number), [b1, b2] = b.split(':').map(Number);
    return a1 - b1 || a2 - b2;
  });
  for (const [key, edge] of smoothSeams) {
    const [a, b] = key.split(':').map(Number);
    if (root(a) === root(b)) continue;
    const first = components[a], second = components[b];
    const interior = Math.max(interiorEdges[a] ? interiorContrast[a] / interiorEdges[a] : 0, interiorEdges[b] ? interiorContrast[b] / interiorEdges[b] : 0);
    const contrast = edge.contrast / edge.shared;
    if (contrast > Math.max(4, interior * 2.5 + 3) || contrast > settings.colorStep * .8) continue;
    if (edge.coarse2 / edge.shared > settings.colorStep * .8 || edge.coarse4 / edge.shared > settings.colorStep * .8) continue;
    if (rgbDistance(first, second) > settings.colorStep * 2.5) continue;
    // Single-pixel strokes and tiny islands carry actual contour evidence.
    if (settings.preserveThinLines !== false && Math.min(first.maxX - first.minX + 1, first.maxY - first.minY + 1, second.maxX - second.minX + 1, second.maxY - second.minY + 1) <= 2 && interior < .5) continue;
    parent[Math.max(root(a), root(b))] = Math.min(root(a), root(b));
  }
  const grouped = new Map<number, Component>();
  for (let index = 0; index < total; index++) if (labels[index] >= 0) labels[index] = root(labels[index]);
  for (const component of components) {
    const id = root(component.id), previous = grouped.get(id);
    if (!previous) grouped.set(id, { ...component, id });
    else {
      const count = previous.count + component.count;
      const previousSquares = previous.variance + (previous.r ** 2 + previous.g ** 2 + previous.b ** 2) / 3;
      const componentSquares = component.variance + (component.r ** 2 + component.g ** 2 + component.b ** 2) / 3;
      previous.r = (previous.r * previous.count + component.r * component.count) / count;
      previous.g = (previous.g * previous.count + component.g * component.count) / count;
      previous.b = (previous.b * previous.count + component.b * component.count) / count;
      previous.variance = Math.max(0, (previousSquares * previous.count + componentSquares * component.count) / count - (previous.r ** 2 + previous.g ** 2 + previous.b ** 2) / 3);
      previous.partialAlpha += component.partialAlpha;
      previous.count = count; previous.minX = Math.min(previous.minX, component.minX); previous.minY = Math.min(previous.minY, component.minY);
      previous.maxX = Math.max(previous.maxX, component.maxX); previous.maxY = Math.max(previous.maxY, component.maxY);
    }
  }
  // Preserve source antialiasing outside the hard alpha threshold. Assign only
  // one-pixel fringe samples touching an existing hard component; do not grow
  // through transparency or turn an isolated low-alpha smudge into a part.
  for (let index = 0; index < total; index++) {
    if (labels[index] >= 0 || rgba[index * 4 + 3] === 0 || rgba[index * 4 + 3] >= settings.alphaThreshold) continue;
    const x = index % width, y = (index / width) | 0;
    let owner = -1, distance = Infinity, colorDistance = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy || x + dx < 0 || y + dy < 0 || x + dx >= width || y + dy >= height) continue;
      const neighbor = (y + dy) * width + x + dx;
      if (rgba[neighbor * 4 + 3] < settings.alphaThreshold || labels[neighbor] < 0) continue;
      const candidate = labels[neighbor], component = grouped.get(candidate)!;
      const d = dx * dx + dy * dy;
      const c = Math.hypot(rgba[index * 4] - component.r, rgba[index * 4 + 1] - component.g, rgba[index * 4 + 2] - component.b);
      if (d < distance || d === distance && (c < colorDistance || c === colorDistance && candidate < owner)) {
        owner = candidate; distance = d; colorDistance = c;
      }
    }
    if (owner < 0) continue;
    labels[index] = owner;
    const component = grouped.get(owner)!;
    component.count++; component.partialAlpha++;
    component.minX = Math.min(component.minX, x); component.maxX = Math.max(component.maxX, x);
    component.minY = Math.min(component.minY, y); component.maxY = Math.max(component.maxY, y);
  }
  const ordered = [...grouped.values()].sort((a, b) => a.minY - b.minY || a.minX - b.minX || b.count - a.count || a.id - b.id);
  const regions: RegionRecord[] = [], parts: PartRecord[] = [], masks = new Map<string, RegionMask>();
  const labelToRegion = new Map<number, RegionRecord>();
  const componentMasks = new Map<number, { bounds: Box; mask: RegionMask }>();
  let maskPixels = 0;
  for (const component of ordered) {
    const bounds = { x: component.minX, y: component.minY, width: component.maxX - component.minX + 1, height: component.maxY - component.minY + 1 };
    maskPixels += bounds.width * bounds.height;
    if (maskPixels > 32_000_000) throw new Error('RESOURCE_LIMIT: Region masks exceed the 32 million pixel analysis budget; increase color step or crop the source.');
    componentMasks.set(component.id, { bounds, mask: { width: bounds.width, height: bounds.height, bytes: new Uint8Array(bounds.width * bounds.height) } });
  }
  for (let index = 0; index < total; index++) if (labels[index] >= 0) {
    const entry = componentMasks.get(labels[index]);
    if (!entry) continue;
    const x = index % width, y = (index / width) | 0;
    entry.mask.bytes[(y - entry.bounds.y) * entry.bounds.width + x - entry.bounds.x] = 1;
  }
  for (let order = 0; order < ordered.length; order++) {
    abort(signal);
    const component = ordered[order], { bounds, mask } = componentMasks.get(component.id)!;
    const id = `${source.id}_region_${String(order + 1).padStart(4, '0')}`;
    const partId = source.role === 'primary' ? `${source.id}_part_${String(order + 1).padStart(4, '0')}` : undefined;
    const maskId = `${id}_mask`;
    const loops = contours(mask, bounds.x, bounds.y);
    if (!loops.length) continue;
    const coverage = component.partialAlpha ? new Uint8Array(mask.bytes.length) : undefined;
    if (coverage) for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) if (mask.bytes[y * mask.width + x]) {
      coverage[y * mask.width + x] = rgba[((bounds.y + y) * width + bounds.x + x) * 4 + 3];
    }
    const fitted = fitRegionContours(loops, mask, bounds, settings, coverage);
    if (fitted.path.points.length > 4096) throw new Error('PATH_TOO_COMPLEX');
    const shapePath = fitted.path, holeCount = fitted.holeCount;
    if (holeCount > (shapePath.holes?.length ?? 0)) diagnostics.push({ code: 'HOLE_NOT_REPRESENTABLE', severity: 'warning', sourceId: source.id, regionId: id, bounds,
      message: `${holeCount - (shapePath.holes?.length ?? 0)} interior source contour(s) exceed safe native vector fitting limits.`,
      suggestion: 'Refine or split the region; otherwise approve an explicit raster-alpha fallback at export.' });
    const variance = Math.sqrt(component.variance), texture = component.partialAlpha > 0 || settings.preserveTexture && variance > 8 ? 'source-crop' : 'flat';
    if (component.partialAlpha && !settings.preserveTexture) diagnostics.push({ code: 'TEXTURE_APPROXIMATION', severity: 'info', sourceId: source.id, regionId: id, bounds,
      message: 'The region keeps its source alpha fringe in an editable textured path even with texture preservation disabled.' });
    const region: RegionRecord = {
      id, sourceId: source.id, maskId, bounds, pixelCount: component.count, classification: 'foreground', color: hex(component.r, component.g, component.b), colorVariance: variance,
      confidence: { kind: 'heuristic', reasons: ['connected 4-neighbor foreground pixels', 'original-pixel boundary contrast and 2×/4× color agreement', 'visible alpha or opaque-border contrast'] },
      provenance: { algorithmVersion: ALGORITHM_VERSION, settingsFingerprint }, generationStatus: 'generated',
      locked: { mask: false, geometry: false, part: false }, lineage: { parents: [], children: [] }, partId,
      geometry: { id: `${id}_geometry`, generatedPath: shapePath, bounds, status: 'visible', quality: { maskIoU: fitted.quality, pathPointCount: fitted.pointCount, colorError: variance }, texture, locked: false },
      holeCount, adjacency: [],
    };
    regions.push(region); masks.set(maskId, mask); labelToRegion.set(component.id, region);
  }
  const regionContacts = new Map<string, { left: RegionRecord; right: RegionRecord; sharedBoundary: number; colorDistance: number }>();
  for (const [key, evidence] of adjacency) {
    const [a, b] = key.split(':').map(Number), left = labelToRegion.get(root(a)), right = labelToRegion.get(root(b));
    if (!left || !right || left.id === right.id) continue;
    const distance = rgbDistance(grouped.get(root(a))!, grouped.get(root(b))!);
    const ordered = left.id < right.id ? [left, right] : [right, left];
    const pair = `${ordered[0].id}:${ordered[1].id}`;
    const existing = regionContacts.get(pair);
    if (existing) existing.sharedBoundary += evidence.shared;
    else regionContacts.set(pair, { left: ordered[0], right: ordered[1], sharedBoundary: evidence.shared, colorDistance: distance });
  }
  for (const contact of regionContacts.values()) {
    contact.left.adjacency.push({ regionId: contact.right.id, sharedBoundary: contact.sharedBoundary, colorDistance: contact.colorDistance });
    contact.right.adjacency.push({ regionId: contact.left.id, sharedBoundary: contact.sharedBoundary, colorDistance: contact.colorDistance });
  }
  for (const region of regions) region.adjacency.sort((a, b) => a.regionId.localeCompare(b.regionId));
  // Group paint regions into rigid part candidates when their shared boundary is broad.
  // A narrow contact stays separate so a potential joint is not silently fused.
  if (source.role === 'primary') {
    const indexById = new Map(regions.map((region, index) => [region.id, index]));
    const parent = Int32Array.from(regions.map((_, index) => index));
    const root = (index: number): number => { while (parent[index] !== index) index = parent[index] = parent[parent[index]]; return index; };
    const contacts: { a: number; b: number; shared: number; score: number }[] = [];
    for (const region of regions) for (const edge of region.adjacency) {
      const a = indexById.get(region.id)!, b = indexById.get(edge.regionId);
      if (b === undefined || a >= b) continue;
      const other = regions[b];
      const perimeter = Math.min(2 * (region.bounds.width + region.bounds.height), 2 * (other.bounds.width + other.bounds.height));
      const contact = edge.sharedBoundary / Math.max(1, perimeter);
      const similarity = 1 - edge.colorDistance / Math.max(1, settings.colorStep * 3.5);
      const threshold = mode === 'appearance' ? .18 : .3;
      if (contact >= threshold && similarity > 0) contacts.push({ a, b, shared: edge.sharedBoundary, score: contact * similarity });
    }
    contacts.sort((a, b) => b.score - a.score || b.shared - a.shared || a.a - b.a || a.b - b.b);
    for (const contact of contacts) {
      const a = root(contact.a), b = root(contact.b);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
    const groups = new Map<number, RegionRecord[]>();
    for (let index = 0; index < regions.length; index++) {
      const key = root(index), group = groups.get(key) ?? [];
      group.push(regions[index]); groups.set(key, group);
    }
    let order = 0;
    for (const group of groups.values()) {
      const id = `${source.id}_part_${String(++order).padStart(4, '0')}`;
      const x = Math.min(...group.map(item => item.bounds.x)), y = Math.min(...group.map(item => item.bounds.y));
      const right = Math.max(...group.map(item => item.bounds.x + item.bounds.width));
      const bottom = Math.max(...group.map(item => item.bounds.y + item.bounds.height));
      const bounds = { x, y, width: right - x, height: bottom - y };
      for (const region of group) region.partId = id;
      parts.push({ id, name: `Part ${String(order).padStart(2, '0')}`, regionIds: group.map(item => item.id), bounds,
        pivot: { x: x + bounds.width / 2, y: y + bounds.height / 2 }, pivotLocked: false,
        attachmentApproved: false, hiddenGeometry: 'none', zOrder: order - 1, transformLocked: false });
    }
  }
  const layers: LayerRecord[] = [];
  for (const front of regions) for (const back of regions) if (front !== back && boxContains(back.bounds, front.bounds)) {
    layers.push({ id: `${front.id}_front_${back.id}`, frontRegionId: front.id, backRegionId: back.id, origin: 'automatic', evidence: ['one visible region is enclosed by another region bounding box'], status: 'proposed' });
  }
  if (regions.length === 0) diagnostics.push({ code: 'INSUFFICIENT_STRUCTURE', severity: 'warning', sourceId: source.id, message: 'No foreground survived alpha/background analysis.', suggestion: 'Mark foreground or adjust alpha and background settings.' });
  if (regions.length > 500) diagnostics.push({ code: 'AMBIGUOUS_REGION', severity: 'warning', sourceId: source.id, message: 'The first pass produced many small regions; part grouping needs review.', suggestion: 'Increase color quantization or minimum region size.' });
  if (regions.length > 300 && regions.filter(region => region.pixelCount < settings.minRegionPixels).length / regions.length >= .7)
    diagnostics.push({ code: 'INSUFFICIENT_STRUCTURE', severity: 'error', sourceId: source.id, message: `The first pass made ${regions.length} mostly tiny fragments, which are not useful native parts.`, suggestion: 'Crop to the intended subject, raise color step, or merge annotated regions before native export.', evidence: ['more than 300 regions', 'at least 70% are smaller than the configured minimum region size'] });
  if (mode === 'animation-ready' && parts.length > 1) diagnostics.push({ code: 'OCCLUSION_UNDERCONSTRAINED', severity: 'info', sourceId: source.id, message: 'A single view does not justify hidden surfaces or moving joints; parts remain independent until confirmed.', suggestion: 'Adjust pivots and attachments or add another reference.' });
  if (mode === 'animation-ready' && parts.length > 1 && Math.min(width, height) < 96)
    diagnostics.push({ code: 'LOW_SOURCE_RESOLUTION', severity: 'warning', sourceId: source.id,
      message: `${width}×${height} source pixels can leave visible stair steps when a recovered part rotates.`,
      suggestion: 'Use a larger antialiased reference or smooth editable path anchors before posing the part.' });
  if (source.mime !== 'image/png') diagnostics.push({ code: 'COLOR_SPACE_WARNING', severity: 'info', sourceId: source.id, message: 'JPEG/WebP decoding can differ by browser color management; the canonical decoded RGBA is saved in the working document.' });
  return { regions, parts, masks, layers, diagnostics };
}

/** Conservative correspondence proposals; different poses never become keyframes. */
export function proposeCorrespondences(primary: RegionRecord[], alternate: RegionRecord[]): CorrespondenceRecord[] {
  const candidates: CorrespondenceRecord[] = [];
  for (const region of alternate) {
    const ranked = primary.map(other => {
      const parse = (value: string) => [1, 3, 5].map(start => parseInt(value.slice(start, start + 2), 16));
      const a = parse(region.color), b = parse(other.color);
      const colorDistance = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      const areaRatio = Math.max(region.pixelCount, other.pixelCount) / Math.max(1, Math.min(region.pixelCount, other.pixelCount));
      const aspectRatio = Math.max(region.bounds.width / region.bounds.height, other.bounds.width / other.bounds.height) / Math.min(region.bounds.width / region.bounds.height, other.bounds.width / other.bounds.height);
      return { other, score: colorDistance / 255 + Math.log(areaRatio) + Math.log(aspectRatio) };
    }).sort((a, b) => a.score - b.score || a.other.id.localeCompare(b.other.id));
    for (const item of ranked.slice(0, 3)) if (item.score < 1.25) candidates.push({
      id: `${region.id}_match_${item.other.id}`, sourceIds: [item.other.sourceId, region.sourceId], regionIds: [item.other.id, region.id],
      kind: 'possible-match', origin: 'automatic', evidence: [`color/area/aspect heuristic score ${item.score.toFixed(3)}`],
      ambiguity: ranked.length > 1 && ranked[1].score - ranked[0].score < .2 ? 'Similar candidate regions cannot be distinguished reliably.' : undefined,
    });
  }
  return candidates;
}
