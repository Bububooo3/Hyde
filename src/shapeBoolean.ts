import * as clipping from 'polygon-clipping';
import { worldPoses } from './editing';
import { createElement, type Project, type StoryElement } from './model';
import { editablePathForElement, pathPointToWorld, shapePathCommands } from './shapePath';

export type ShapeBooleanOperation = 'union' | 'separate' | 'negate' | 'intersect';
type Pair = clipping.Pair;

function distanceToLine(point: Pair, from: Pair, to: Pair): number {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  return Math.abs((point[0] - from[0]) * dy - (point[1] - from[1]) * dx) / Math.max(.000001, Math.hypot(dx, dy));
}

function flattenCubic(from: Pair, a: Pair, b: Pair, to: Pair, output: Pair[], depth = 0): void {
  if (depth >= 8 || Math.max(distanceToLine(a, from, to), distanceToLine(b, from, to)) <= .5) { output.push(to); return; }
  const mid = (p: Pair, q: Pair): Pair => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const ab = mid(from, a), bc = mid(a, b), cd = mid(b, to), abc = mid(ab, bc), bcd = mid(bc, cd), center = mid(abc, bcd);
  flattenCubic(from, ab, abc, center, output, depth + 1);
  flattenCubic(center, bcd, cd, to, output, depth + 1);
}

function contourRing(pose: StoryElement, contour: ReturnType<typeof editablePathForElement>): clipping.Ring {
  const ring: clipping.Ring = [];
  const world = (x: number, y: number): Pair => {
    const point = pathPointToWorld(pose, { x: x / pose.width, y: y / pose.height });
    return [point.x, point.y];
  };
  for (const command of shapePathCommands(contour, pose.width, pose.height)) {
    if (command.type === 'move' || command.type === 'line') ring.push(world(command.x, command.y));
    else if (command.type === 'cubic') {
      const from = ring.at(-1)!;
      flattenCubic(from, world(command.x1, command.y1), world(command.x2, command.y2), world(command.x, command.y), ring);
    }
  }
  if (ring.length > 1 && Math.hypot(ring[0][0] - ring.at(-1)![0], ring[0][1] - ring.at(-1)![1]) < 1e-7) ring.pop();
  if (ring.length < 3 || ring.length > 4096) throw new Error('This shape has too many or too few boundary points for a Boolean operation.');
  return ring;
}

export function worldShapePolygon(pose: StoryElement): clipping.Polygon {
  const path = editablePathForElement(pose);
  return [contourRing(pose, path), ...(path.holes ?? []).map(hole => contourRing(pose, hole))];
}

function area(ring: clipping.Ring): number {
  let twice = 0;
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index], b = ring[(index + 1) % ring.length];
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

/** Snapshot an editable filled-region operation at the playhead. Source shapes
 * remain intact and hidden, so unhiding or undo always recovers them. */
export function booleanShapes(project: Project, ids: readonly string[], operation: ShapeBooleanOperation, time: number): { project: Project; resultIds: string[] } {
  const sources = ids.map(id => project.elements.find(element => element.id === id)).filter((element): element is StoryElement => !!element);
  if (sources.length < (operation === 'separate' ? 1 : 2)) throw new Error(`Select ${operation === 'separate' ? 'a shape' : 'at least two shapes'} first.`);
  if (sources.some(element => !['rectangle', 'ellipse', 'polygon'].includes(element.kind))) throw new Error('Boolean operations require rectangle, ellipse, or polygon shapes.');
  if (new Set(sources.map(element => element.sceneId)).size > 1) throw new Error('Select shapes in the same scene.');
  const poses = worldPoses(project, time);
  const polygons = sources.map(element => worldShapePolygon(poses.get(element.id) ?? element));
  const output = operation === 'union' || operation === 'separate' ? clipping.union(polygons[0], ...polygons.slice(1))
    : operation === 'intersect' ? clipping.intersection(polygons[0], ...polygons.slice(1))
      : clipping.difference(polygons[0], ...polygons.slice(1));
  const valid = output.filter(polygon => polygon.length && area(polygon[0]) > .0001);
  if (!valid.length) throw new Error('The selected shapes produce an empty result. The source shapes were kept.');
  if (valid.length > 64 || valid.reduce((count, polygon) => count + polygon.reduce((total, ring) => total + ring.length, 0), 0) > 16384)
    throw new Error('The Boolean result is too complex for an editable Hyde path. The source shapes were kept.');
  const next = structuredClone(project), primary = sources[0], results: StoryElement[] = [];
  for (const [index, polygon] of valid.entries()) {
    const points = polygon.flat();
    const left = Math.min(...points.map(point => point[0])), right = Math.max(...points.map(point => point[0]));
    const top = Math.min(...points.map(point => point[1])), bottom = Math.max(...points.map(point => point[1]));
    const width = right - left, height = bottom - top;
    if (width < .0001 || height < .0001) continue;
    const normalize = (ring: clipping.Ring) => ({ points: ring.slice(0, -1).map(([x, y]) => ({ x: (x - left) / width, y: (y - top) / height })) });
    const path = { ...normalize(polygon[0]), ...(polygon.length > 1 ? { holes: polygon.slice(1).map(normalize) } : {}) };
    const result = createElement('polygon', {
      name: `${operation[0].toUpperCase()}${operation.slice(1)} ${primary.name}${valid.length > 1 ? ` ${index + 1}` : ''}`,
      x: (left + right) / 2, y: (top + bottom) / 2, width, height, pivotX: .5, pivotY: .5,
      shapePath: path, fill: primary.fill, stroke: primary.stroke, strokeWidth: primary.strokeWidth,
      opacity: primary.opacity, shadow: structuredClone(primary.shadow), assetId: primary.assetId,
      mediaFit: primary.mediaFit, mediaOpacity: primary.mediaOpacity, mediaTransform: structuredClone(primary.mediaTransform),
      start: primary.start, duration: primary.duration, sceneId: primary.sceneId, folderId: primary.folderId,
    });
    results.push(result);
  }
  if (!results.length) throw new Error('The Boolean result has no usable area. The source shapes were kept.');
  const sourceIds = new Set(sources.map(element => element.id));
  for (const source of next.elements) if (sourceIds.has(source.id)) source.hidden = true;
  next.elements.push(...results);
  return { project: next, resultIds: results.map(element => element.id) };
}
