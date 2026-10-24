// @vitest-environment node
import { expect, it } from 'vitest';
import { runBrowserTask } from '../cliBrowserRunner';
import { fitMaskGeometry } from './analysis';
import { encodePng } from './image';
import { compareNativeRender } from './quality';
import { DecompositionSession } from './session';
import { defaultSettings, type RegionMask } from './types';

function antialiasedDisk(size = 96) {
  const rgba = new Uint8Array(size * size * 4);
  const mask: RegionMask = { width: size, height: size, bytes: new Uint8Array(size * size), alpha: new Uint8Array(size * size) };
  const radius = size * .29, center = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let covered = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      if ((x + (sx + .5) / 4 - center) ** 2 + (y + (sy + .5) / 4 - center) ** 2 <= radius ** 2) covered++;
    }
    const alpha = Math.round(covered * 255 / 16), at = y * size + x;
    rgba.set([200, 62, 47, alpha], at * 4);
    if (alpha) { mask.bytes[at] = 1; mask.alpha![at] = alpha; }
  }
  return { rgba, mask, size };
}

it('fits bounded cubic handles to a smooth antialiased contour and keeps binary source evidence', () => {
  const { mask, size } = antialiasedDisk();
  const before = Uint8Array.from(mask.bytes);
  const first = fitMaskGeometry('disk', mask, { x: 0, y: 0, width: size, height: size }, defaultSettings('appearance'), 'source-crop');
  const second = fitMaskGeometry('disk', mask, { x: 0, y: 0, width: size, height: size }, defaultSettings('appearance'), 'source-crop');
  expect(first).toEqual(second);
  expect(mask.bytes).toEqual(before);
  expect(first.geometry.quality.maskIoU).toBeGreaterThan(.98);
  expect(first.geometry.generatedPath.points.length).toBeLessThan(80);
  expect(first.geometry.generatedPath.points.filter(point => point.in || point.out).length).toBeGreaterThan(2);
  for (const point of first.geometry.generatedPath.points) for (const coordinate of [point, point.in, point.out]) if (coordinate) {
    expect(Number.isFinite(coordinate.x) && Number.isFinite(coordinate.y)).toBe(true);
  }
});

it('keeps long orthogonal pixel-art corners and one-pixel protrusions straight', () => {
  const width = 48, height = 40;
  const bytes = new Uint8Array(width * height);
  for (let y = 6; y < 34; y++) for (let x = 5; x < 34; x++) if (x < 13 || y >= 25) bytes[y * width + x] = 1;
  for (let x = 34; x < 42; x++) bytes[29 * width + x] = 1;
  const mask = { width, height, bytes };
  const fitted = fitMaskGeometry('pixel', mask, { x: 0, y: 0, width, height }, defaultSettings('appearance'), 'flat');
  expect(fitted.geometry.quality.maskIoU).toBeGreaterThan(.98);
  expect(fitted.geometry.generatedPath.points.every(point => !point.in && !point.out)).toBe(true);
  expect(fitted.geometry.generatedPath.points.length).toBeGreaterThanOrEqual(8);
});

(process.env.HYDE_TEST_BROWSER ? it : it.skip)('preserves a curved transparent sticker in actual Hyde pixels', async () => {
  const { rgba, size } = antialiasedDisk();
  const source = { width: size, height: size, rgba };
  const session = await DecompositionSession.importSources([{ bytes: encodePng(source), name: 'antialiased-disk.png', mime: 'image/png' }]);
  try {
    await session.analyze();
    const document = session.snapshot();
    const native = await session.exportHyde({ format: 'hyde' });
    const rendered = await runBrowserTask(native.project, { kind: 'preview', options: { timeSeconds: 0, width: size, height: size, format: 'png' } });
    const quality = compareNativeRender(source, rendered.bytes, document);
    console.info('antialiased disk native', JSON.stringify({ iou: quality.silhouette.iou, boundaryMean: quality.boundary.meanDistancePixels,
      uncovered: quality.coverage.uncoveredPixels, excess: quality.coverage.excessPixels, colorError: quality.color.meanAbsoluteSrgbChannelError,
      pathPoints: document.regions.map(region => region.geometry.generatedPath.points.length), handles: document.regions.map(region => region.geometry.generatedPath.points.filter(point => point.in || point.out).length) }));
    expect(document.regions).toHaveLength(1);
    expect(document.regions[0].geometry.generatedPath.points.some(point => point.in || point.out)).toBe(true);
    expect(quality.silhouette.iou).toBeGreaterThan(.98);
    expect(quality.boundary.meanDistancePixels!).toBeLessThan(.8);
  } finally { await session.close(); }
}, 60_000);
