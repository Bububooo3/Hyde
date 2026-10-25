// @vitest-environment node
import { expect, it } from 'vitest';
import { buildImagePyramid } from './pyramid';

it('builds bounded deterministic previews without mutating canonical source pixels', () => {
  const rgba = new Uint8Array(4 * 4 * 4);
  for (let index = 0; index < 16; index++) rgba.set(index === 0 ? [210, 45, 20, 255] : [0, 0, 255, 0], index * 4);
  const original = Uint8Array.from(rgba);
  const levels = buildImagePyramid({ width: 4, height: 4, rgba }, 1);
  expect(levels.map(level => [level.width, level.height, level.scale])).toEqual([[4, 4, 1], [2, 2, 2], [1, 1, 4]]);
  expect([...levels[2].rgba]).toEqual([210, 45, 20, 16]);
  expect(rgba).toEqual(original);
  expect(buildImagePyramid({ width: 4, height: 4, rgba }, 1)[2].rgba).toEqual(levels[2].rgba);
  expect(() => buildImagePyramid({ width: 4, height: 4, rgba: new Uint8Array(4) }, 1)).toThrow(/Invalid source image/);
});
