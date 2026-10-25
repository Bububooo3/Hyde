import type { DecodedImage } from './image';

export interface ImagePyramidLevel extends DecodedImage { scale: number }

/** Deterministic, premultiplied-alpha 2× reductions. The original level is retained;
 * additional levels cost about one third of its pixel storage in total. */
export function buildImagePyramid(image: DecodedImage, maxSide = 512): ImagePyramidLevel[] {
  if (!Number.isInteger(maxSide) || maxSide < 1 || maxSide > 4096) throw new Error('Preview side limit must be between 1 and 4096.');
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 ||
    image.width * image.height > 4_000_000 || image.rgba.length !== image.width * image.height * 4) throw new Error('Invalid source image for preview pyramid.');
  const levels: ImagePyramidLevel[] = [{ ...image, scale: 1 }];
  while (Math.max(levels[levels.length - 1].width, levels[levels.length - 1].height) > maxSide) {
    const input = levels[levels.length - 1], width = Math.ceil(input.width / 2), height = Math.ceil(input.height / 2);
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let samples = 0, alpha = 0, red = 0, green = 0, blue = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = x * 2 + dx, sy = y * 2 + dy;
        if (sx >= input.width || sy >= input.height) continue;
        const at = (sy * input.width + sx) * 4, weight = input.rgba[at + 3];
        samples++; alpha += weight; red += input.rgba[at] * weight; green += input.rgba[at + 1] * weight; blue += input.rgba[at + 2] * weight;
      }
      const at = (y * width + x) * 4;
      if (alpha) { rgba[at] = Math.round(red / alpha); rgba[at + 1] = Math.round(green / alpha); rgba[at + 2] = Math.round(blue / alpha); }
      rgba[at + 3] = Math.round(alpha / samples);
    }
    levels.push({ width, height, rgba, scale: input.scale * 2 });
  }
  return levels;
}
