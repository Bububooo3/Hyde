import type { Box, RegionMask } from './types';

/** Expand editable mask topology using a bounded, deterministic chamfer distance. */
export function featherMaskOutward(bounds: Box, mask: RegionMask, sourceWidth: number, sourceHeight: number,
  radius: number, strength: number, occupied?: Uint8Array): { bounds: Box; mask: RegionMask; pixelCount: number } {
  if (!Number.isInteger(radius) || radius < 1 || radius > 40 || !Number.isFinite(strength) || strength <= 0 || strength > 1)
    throw new Error('INVALID_ARGUMENT: Feather radius must be 1–40 pixels and strength must be above 0 and at most 1.');
  const x0 = Math.max(0, bounds.x - radius), y0 = Math.max(0, bounds.y - radius);
  const x1 = Math.min(sourceWidth, bounds.x + bounds.width + radius), y1 = Math.min(sourceHeight, bounds.y + bounds.height + radius);
  const width = x1 - x0, height = y1 - y0, length = width * height;
  if (length > 4_000_000) throw new Error('RESOURCE_LIMIT: Feathered mask exceeds the source pixel budget.');
  const distance = new Float32Array(length), bytes = new Uint8Array(length), alpha = new Uint8Array(length);
  distance.fill(Infinity);
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
    const previous = y * mask.width + x;
    if (!mask.bytes[previous]) continue;
    const at = (bounds.y - y0 + y) * width + bounds.x - x0 + x;
    distance[at] = 0; bytes[at] = 1; alpha[at] = mask.alpha?.[previous] ?? 255;
  }
  const diagonal = Math.SQRT2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * width + x;
    if (x) distance[at] = Math.min(distance[at], distance[at - 1] + 1);
    if (y) distance[at] = Math.min(distance[at], distance[at - width] + 1);
    if (x && y) distance[at] = Math.min(distance[at], distance[at - width - 1] + diagonal);
    if (x + 1 < width && y) distance[at] = Math.min(distance[at], distance[at - width + 1] + diagonal);
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const at = y * width + x;
    if (x + 1 < width) distance[at] = Math.min(distance[at], distance[at + 1] + 1);
    if (y + 1 < height) distance[at] = Math.min(distance[at], distance[at + width] + 1);
    if (x + 1 < width && y + 1 < height) distance[at] = Math.min(distance[at], distance[at + width + 1] + diagonal);
    if (x && y + 1 < height) distance[at] = Math.min(distance[at], distance[at + width - 1] + diagonal);
  }
  let pixelCount = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * width + x;
    if (!bytes[at] && distance[at] <= radius && !occupied?.[(y0 + y) * sourceWidth + x0 + x]) {
      const coverage = Math.round(255 * strength * (radius + 1 - distance[at]) / (radius + 1));
      if (coverage > 0) { bytes[at] = 1; alpha[at] = coverage; }
    }
    pixelCount += bytes[at];
  }
  return { bounds: { x: x0, y: y0, width, height }, mask: { width, height, bytes, alpha }, pixelCount };
}
