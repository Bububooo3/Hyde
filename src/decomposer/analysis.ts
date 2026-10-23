import type { ShapePath } from '../model';
import type { Box, CorrespondenceRecord, DecompositionDiagnostic, DecompositionMode, LayerRecord, PartRecord, Point, ReconstructionSettings, RegionGeometry, RegionMask, RegionRecord, SourceReference } from './types';
import type { DecodedImage } from './image';

export const ALGORITHM_VERSION = 'deterministic-regions-1';
interface Component { id: number; count: number; minX: number; minY: number; maxX: number; maxY: number; r: number; g: number; b: number; variance: number }
export interface AnalysisResult { regions: RegionRecord[]; parts: PartRecord[]; masks: Map<string, RegionMask>; layers: LayerRecord[]; diagnostics: DecompositionDiagnostic[] }
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('CANCELED'); };
const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map(value => clamp(value).toString(16).padStart(2, '0')).join('')}`;
const rgbDistance = (a: Pick<Component, 'r' | 'g' | 'b'>, b: Pick<Component, 'r' | 'g' | 'b'>) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
const boxContains = (a: Box, b: Box) => b.x > a.x && b.y > a.y && b.x + b.width < a.x + a.width && b.y + b.height < a.y + a.height;
const area = (points: Point[]) => points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y;
}, 0) / 2;
const pointDistance = (point: Point, a: Point, b: Point) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx || dy ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
};
function simplify(points: Point[], tolerance: number, maxPoints: number): Point[] {
  let current = points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length], next = points[(index + 1) % points.length];
    return (point.x - previous.x) * (next.y - point.y) !== (point.y - previous.y) * (next.x - point.x);
  });
  if (current.length < 3) current = points;
  let error = tolerance;
  while (current.length > maxPoints || error === tolerance) {
    let changed = true;
    while (changed && current.length > 3) {
      changed = false;
      const kept: Point[] = [];
      for (let index = 0; index < current.length; index++) {
        const previous = current[(index + current.length - 1) % current.length];
        const point = current[index], next = current[(index + 1) % current.length];
        if (current.length - (index - kept.length) > 3 && pointDistance(point, previous, next) <= error) { changed = true; continue; }
        kept.push(point);
      }
      if (kept.length >= 3) current = kept;
    }
    if (current.length <= maxPoints) break;
    error *= 1.5;
    if (error > 128) throw new Error('PATH_TOO_COMPLEX');
  }
  return current;
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

export function fitMaskGeometry(id: string, mask: RegionMask, bounds: Box, settings: ReconstructionSettings, texture: RegionGeometry['texture']): { geometry: RegionGeometry; holeCount: number } {
  const loops = contours(mask, bounds.x, bounds.y);
  if (!loops.length) throw new Error('Mask contains no foreground pixels.');
  if (loops.filter(loop => area(loop) > 0).length > 1) throw new Error('AMBIGUOUS_REGION: A single path cannot represent disconnected mask islands. Split them into separate regions.');
  const outer = simplify(loops[0], settings.pathTolerance, settings.maxPathPoints);
  if (outer.length > 4096) throw new Error('PATH_TOO_COMPLEX');
  return {
    geometry: { id: `${id}_geometry`, generatedPath: { points: outer.map(point => ({ x: (point.x - bounds.x) / bounds.width, y: (point.y - bounds.y) / bounds.height })) }, bounds,
      status: 'visible', quality: { maskIoU: sampledIoU(outer, mask, bounds), pathPointCount: outer.length, colorError: 0 }, texture, locked: false },
    holeCount: Math.max(0, loops.length - 1),
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
    let minX = width, minY = height, maxX = -1, maxY = -1, r = 0, g = 0, b = 0, squares = 0;
    labels[start] = id; queue[tail++] = start;
    while (head < tail) {
      if ((head & 65535) === 0) abort(signal);
      const index = queue[head++], x = index % width, y = (index / width) | 0, at = index * 4;
      count++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      r += rgba[at]; g += rgba[at + 1]; b += rgba[at + 2]; squares += rgba[at] ** 2 + rgba[at + 1] ** 2 + rgba[at + 2] ** 2;
      const visit = (neighbor: number) => { if (foreground[neighbor] && labels[neighbor] === -1 && bucket(neighbor) === key) { labels[neighbor] = id; queue[tail++] = neighbor; } };
      if (x > 0) visit(index - 1); if (x + 1 < width) visit(index + 1);
      if (y > 0) visit(index - width); if (y + 1 < height) visit(index + width);
    }
    const means = { r: r / count, g: g / count, b: b / count };
    components.push({ id, count, minX, minY, maxX, maxY, ...means, variance: Math.max(0, squares / (count * 3) - (means.r ** 2 + means.g ** 2 + means.b ** 2) / 3) });
    if (components.length > 20_000) throw new Error('RESOURCE_LIMIT: Segmentation produced too many islands; increase minimum feature scale.');
  }
  const adjacency = new Map<string, number>();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x, left = labels[index]; if (left < 0) continue;
    for (const neighbor of [x + 1 < width ? labels[index + 1] : -1, y + 1 < height ? labels[index + width] : -1]) {
      if (neighbor < 0 || neighbor === left) continue;
      const key = `${Math.min(left, neighbor)}:${Math.max(left, neighbor)}`;
      adjacency.set(key, (adjacency.get(key) ?? 0) + 1);
    }
  }
  const parent = Int32Array.from(components.map(item => item.id));
  const root = (id: number): number => { while (parent[id] !== id) id = parent[id] = parent[parent[id]]; return id; };
  const neighborMap = new Map<number, { other: number; shared: number }[]>();
  for (const [key, shared] of adjacency) {
    const [a, b] = key.split(':').map(Number);
    for (const [id, other] of [[a, b], [b, a]]) {
      const list = neighborMap.get(id) ?? []; list.push({ other, shared }); neighborMap.set(id, list);
    }
  }
  for (const component of components) {
    if (component.count >= settings.minRegionPixels) continue;
    const choices = (neighborMap.get(component.id) ?? []).map(({ other, shared }) => ({ other, shared, distance: rgbDistance(component, components[other]) }))
      .sort((a, b) => b.shared - a.shared || a.distance - b.distance || a.other - b.other);
    if (choices[0] && choices[0].distance <= settings.colorStep * 2.5) parent[root(component.id)] = root(choices[0].other);
  }
  const grouped = new Map<number, Component>();
  for (let index = 0; index < total; index++) if (labels[index] >= 0) labels[index] = root(labels[index]);
  for (const component of components) {
    const id = root(component.id), previous = grouped.get(id);
    if (!previous) grouped.set(id, { ...component, id });
    else {
      const count = previous.count + component.count;
      previous.r = (previous.r * previous.count + component.r * component.count) / count;
      previous.g = (previous.g * previous.count + component.g * component.count) / count;
      previous.b = (previous.b * previous.count + component.b * component.count) / count;
      previous.variance = (previous.variance * previous.count + component.variance * component.count) / count;
      previous.count = count; previous.minX = Math.min(previous.minX, component.minX); previous.minY = Math.min(previous.minY, component.minY);
      previous.maxX = Math.max(previous.maxX, component.maxX); previous.maxY = Math.max(previous.maxY, component.maxY);
    }
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
    const outer = simplify(loops[0], settings.pathTolerance, settings.maxPathPoints);
    if (outer.length > 4096) throw new Error('PATH_TOO_COMPLEX');
    const shapePath: ShapePath = { points: outer.map(point => ({ x: (point.x - bounds.x) / bounds.width, y: (point.y - bounds.y) / bounds.height })) };
    const holeCount = Math.max(0, loops.length - 1);
    if (holeCount) diagnostics.push({ code: 'HOLE_NOT_REPRESENTABLE', severity: 'warning', sourceId: source.id, regionId: id, bounds, message: 'The source mask has interior holes; a single Hyde path cannot preserve transparent cutouts.', suggestion: 'Keep a masked raster texture or manually split the geometry.' });
    const variance = Math.sqrt(component.variance), texture = settings.preserveTexture && variance > 8 ? 'source-crop' : 'flat';
    const region: RegionRecord = {
      id, sourceId: source.id, maskId, bounds, pixelCount: component.count, classification: 'foreground', color: hex(component.r, component.g, component.b), colorVariance: variance,
      confidence: { kind: 'heuristic', reasons: ['connected 4-neighbor foreground pixels', 'similar quantized sRGB color', 'visible alpha or opaque-border contrast'] },
      provenance: { algorithmVersion: ALGORITHM_VERSION, settingsFingerprint }, generationStatus: 'generated',
      locked: { mask: false, geometry: false, part: false }, lineage: { parents: [], children: [] }, partId,
      geometry: { id: `${id}_geometry`, generatedPath: shapePath, bounds, status: 'visible', quality: { maskIoU: sampledIoU(outer, mask, bounds), pathPointCount: outer.length, colorError: variance }, texture, locked: false },
      holeCount, adjacency: [],
    };
    regions.push(region); masks.set(maskId, mask); labelToRegion.set(component.id, region);
  }
  const regionContacts = new Map<string, { left: RegionRecord; right: RegionRecord; sharedBoundary: number; colorDistance: number }>();
  for (const [key, sharedBoundary] of adjacency) {
    const [a, b] = key.split(':').map(Number), left = labelToRegion.get(root(a)), right = labelToRegion.get(root(b));
    if (!left || !right || left.id === right.id) continue;
    const distance = rgbDistance(grouped.get(root(a))!, grouped.get(root(b))!);
    const ordered = left.id < right.id ? [left, right] : [right, left];
    const pair = `${ordered[0].id}:${ordered[1].id}`;
    const existing = regionContacts.get(pair);
    if (existing) existing.sharedBoundary += sharedBoundary;
    else regionContacts.set(pair, { left: ordered[0], right: ordered[1], sharedBoundary, colorDistance: distance });
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
