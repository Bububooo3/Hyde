import {mediaPlanePoint, type MediaTransform} from './mediaTransform';

/** Four corners in top-left, top-right, bottom-right, bottom-left order.
 * Coordinates are normalized to the element's untransformed width and height.
 * Values outside 0..1 are intentional: a creator may pull a corner off-stage. */
export interface PinPoint { x: number; y: number }
export type PinCorners = readonly [PinPoint, PinPoint, PinPoint, PinPoint];

export interface PinRect { x: number; y: number; width: number; height: number }
export interface PinMesh {
  /** Element-local pixel positions, directly accepted by Pixi MeshGeometry. */
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}
export interface PinMeshOptions {
  /** Texture detail across each axis. More cells reduce affine triangle error. */
  subdivisions?: number;
  /** Portion of the pinned quadrilateral occupied by the source. For fit mode. */
  contentRect?: PinRect;
  /** Portion of the source texture sampled. For fill/cover mode. */
  uvRect?: PinRect;
  /** Independent source placement before the corner warp. */
  mediaTransform?: MediaTransform;
}

export const DEFAULT_PIN_CORNERS: PinCorners = [
  { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
];

const cross = (a: PinPoint, b: PinPoint, c: PinPoint) =>
  (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);

/** Only strictly convex, finite quads admit a stable pin. This also rejects
 * crossed edges, coincident corners, and collapsed/sliver geometry. */
export function validPinCorners(corners: readonly PinPoint[]): corners is PinCorners {
  if (corners.length !== 4 || corners.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) return false;
  const xs = corners.map(point => point.x);
  const ys = corners.map(point => point.y);
  const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (!Number.isFinite(extent) || extent < 1e-9) return false;
  const threshold = Math.max(1e-14, extent * extent * 1e-9);
  const turns = corners.map((point, index) => cross(point, corners[(index + 1) % 4], corners[(index + 2) % 4]));
  return turns.every(turn => turn > threshold) || turns.every(turn => turn < -threshold);
}

interface Homography { a: number; b: number; c: number; d: number; e: number; f: number; g: number; h: number }

/** Maps source unit-square coordinates into the normalized pinned quad. */
function homography(corners: PinCorners): Homography | null {
  const [p0, p1, p2, p3] = corners;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-14) return null;
  const g = (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = (dx1 * dy3 - dx3 * dy1) / denominator;
  const coefficients = {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g, h,
  };
  // A pole inside the source rectangle would fold the mesh, even if its
  // corners happened to be finite. Convex quads normally pass this check.
  if ([1, 1 + g, 1 + h, 1 + g + h].some(value => !Number.isFinite(value) || value <= 1e-9)) return null;
  return coefficients;
}

function map(h: Homography, u: number, v: number): PinPoint {
  const divisor = 1 + h.g * u + h.h * v;
  return { x: (h.a * u + h.b * v + h.c) / divisor, y: (h.d * u + h.e * v + h.f) / divisor };
}

/** Useful for stage handles and hit testing; returns null for an invalid pin. */
export function projectivePinPoint(corners: readonly PinPoint[], u: number, v: number): PinPoint | null {
  if (!validPinCorners(corners) || !Number.isFinite(u) || !Number.isFinite(v)) return null;
  const transform = homography(corners);
  if (!transform) return null;
  const result = map(transform, u, v);
  return Number.isFinite(result.x) && Number.isFinite(result.y) ? result : null;
}

export function pointInPinCorners(corners:readonly PinPoint[],point:PinPoint):boolean{
  if(!validPinCorners(corners))return false;
  let inside=false;
  for(let index=0,j=3;index<4;j=index++){
    const a=corners[index],b=corners[j];
    if((a.y>point.y)!==(b.y>point.y)&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
  }
  return inside;
}

const validRect = (rect: PinRect) =>
  Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.width) &&
  Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0;

/** Existing mediaFit semantics: fill crops to cover, fit leaves the shape fill
 * visible around the image, and stretch uses the whole texture and shape. */
export function mediaPinRects(
  fit: 'fill' | 'fit' | 'stretch',
  elementWidth: number,
  elementHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): { contentRect: PinRect; uvRect: PinRect } | null {
  if (![elementWidth, elementHeight, sourceWidth, sourceHeight].every(value => Number.isFinite(value) && value > 0)) return null;
  const whole = { x: 0, y: 0, width: 1, height: 1 };
  if (fit === 'stretch') return { contentRect: whole, uvRect: whole };
  const targetRatio = elementWidth / elementHeight;
  const sourceRatio = sourceWidth / sourceHeight;
  if (fit === 'fill') {
    if (targetRatio > sourceRatio) {
      const height = sourceRatio / targetRatio;
      return { contentRect: whole, uvRect: { x: 0, y: (1 - height) / 2, width: 1, height } };
    }
    const width = targetRatio / sourceRatio;
    return { contentRect: whole, uvRect: { x: (1 - width) / 2, y: 0, width, height: 1 } };
  }
  if (fit === 'fit') {
    if (targetRatio > sourceRatio) {
      const width = sourceRatio / targetRatio;
      return { contentRect: { x: (1 - width) / 2, y: 0, width, height: 1 }, uvRect: whole };
    }
    const height = targetRatio / sourceRatio;
    return { contentRect: { x: 0, y: (1 - height) / 2, width: 1, height }, uvRect: whole };
  }
  return null;
}

/** Build a deterministic, subdivided approximation of a projectively pinned
 * texture. Pixi MeshGeometry accepts these three arrays as-is. The homography
 * is exact at every mesh vertex; subdivisions limit affine interpolation error
 * within each triangle. Invalid input returns null, leaving the caller free to
 * retain its last valid pin or ordinary sprite rendering. */
export function buildProjectivePinMesh(
  corners: readonly PinPoint[],
  width: number,
  height: number,
  options: PinMeshOptions = {},
): PinMesh | null {
  if (!validPinCorners(corners) || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null;
  const subdivisions = options.subdivisions ?? 16;
  if (!Number.isInteger(subdivisions) || subdivisions < 1 || subdivisions > 128) return null;
  const content = options.contentRect ?? { x: 0, y: 0, width: 1, height: 1 };
  const uv = options.uvRect ?? { x: 0, y: 0, width: 1, height: 1 };
  // A transformed Fill plane deliberately extends beyond the mask, so content
  // coordinates may lie outside the pinned quadrilateral. UVs stay in source.
  if (!validRect(content) || !validRect(uv) ||
      uv.x < 0 || uv.y < 0 || uv.x + uv.width > 1 || uv.y + uv.height > 1) return null;
  const transform = homography(corners);
  if (!transform) return null;
  const stride = subdivisions + 1;
  const positions = new Float32Array(stride * stride * 2);
  const uvs = new Float32Array(positions.length);
  const indices = new Uint32Array(subdivisions * subdivisions * 6);
  for (let row = 0; row <= subdivisions; row++) {
    for (let column = 0; column <= subdivisions; column++) {
      const tx = column / subdivisions, ty = row / subdivisions;
      const sourcePoint = { x: (content.x + content.width * tx) * width, y: (content.y + content.height * ty) * height };
      const placed = options.mediaTransform
        ? mediaPlanePoint(sourcePoint, width, height, options.mediaTransform)
        : sourcePoint;
      const point = map(transform, placed.x / width, placed.y / height);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
      const offset = (row * stride + column) * 2;
      positions[offset] = point.x * width;
      positions[offset + 1] = point.y * height;
      uvs[offset] = uv.x + uv.width * tx;
      uvs[offset + 1] = uv.y + uv.height * ty;
    }
  }
  for (let row = 0; row < subdivisions; row++) {
    for (let column = 0; column < subdivisions; column++) {
      const topLeft = row * stride + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + stride;
      const bottomRight = bottomLeft + 1;
      const offset = (row * subdivisions + column) * 6;
      indices.set([topLeft, topRight, bottomLeft, topRight, bottomRight, bottomLeft], offset);
    }
  }
  return { positions, uvs, indices };
}
