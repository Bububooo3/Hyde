import { encodePng } from '../src/decomposer/image';

/** Rights-clear analytic art with antialiased edges at a useful edit scale. */
export function makeSmoothArticulatedFixture() {
  const width = 192, height = 192, rgba = new Uint8Array(width * height * 4);
  const rect = (x: number, y: number, left: number, top: number, right: number, bottom: number, radius: number) => {
    const cx = Math.max(left + radius, Math.min(right - radius, x));
    const cy = Math.max(top + radius, Math.min(bottom - radius, y));
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  const paint = (x: number, y: number): [number, number, number] | undefined => {
    let result: [number, number, number] | undefined;
    if (rect(x, y, 78, 124, 92, 177, 3) || rect(x, y, 101, 124, 115, 177, 3)) result = [91, 69, 155];
    if (rect(x, y, 38, 79, 76, 95, 6) || rect(x, y, 116, 79, 154, 95, 6)) result = [199, 65, 61];
    if (rect(x, y, 70, 59, 122, 135, 8)) result = [47, 111, 180];
    if ((x - 96) ** 2 + (y - 43) ** 2 <= 27 ** 2) result = [241, 188, 110];
    return result;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let r = 0, g = 0, b = 0, count = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const color = paint(x + (sx + .5) / 4, y + (sy + .5) / 4);
      if (!color) continue;
      count++; r += color[0]; g += color[1]; b += color[2];
    }
    const at = (y * width + x) * 4;
    if (count) rgba.set([Math.round(r / count), Math.round(g / count), Math.round(b / count), Math.round(count * 255 / 16)], at);
  }
  const image = { width, height, rgba };
  return { image, input: { name: 'smooth-articulated-character.png', mime: 'image/png', bytes: encodePng(image) } };
}
