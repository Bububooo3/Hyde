// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeProjectBytes } from '../archive';
import { decodePng, encodePng } from './image';
import { DecompositionSession } from './session';
import { makeSyntheticFixture } from '../../tests/decomposerSyntheticFixtures';

function source(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(paint(x, y), (y * width + x) * 4);
  return { bytes: encodePng({ width, height, rgba }), name: 'original-synthetic-art.png', mime: 'image/png' };
}

describe('deterministic multi-scale color segmentation and path fidelity', () => {
  it('rejoins smooth quantization bands while retaining authentic raster color inside one editable mask', async () => {
    const input = source(96, 40, (x, y) => {
      if (x < 4 || x >= 92 || y < 4 || y >= 36) return [0, 0, 0, 0];
      const value = Math.round(25 + x * 1.6);
      return [value, value, value, 255];
    });
    const session = await DecompositionSession.importSources([input]);
    await session.analyze();
    const { regions, parts } = session.snapshot();
    expect(regions).toHaveLength(1);
    expect(parts).toHaveLength(1);
    expect(regions[0].pixelCount).toBe(88 * 32);
    expect(regions[0].colorVariance).toBeGreaterThan(8);
    expect(regions[0].geometry.texture).toBe('source-crop');
    expect(regions[0].geometry.quality.maskIoU).toBe(1);
    await session.close();
  });

  it('retains an actual flat paint edge even when the two colors are close', async () => {
    const input = source(64, 32, (x, y) => x >= 4 && x < 60 && y >= 4 && y < 28
      ? x < 32 ? [90, 90, 90, 255] : [110, 110, 110, 255]
      : [0, 0, 0, 0]);
    const session = await DecompositionSession.importSources([input]);
    await session.analyze();
    const { regions } = session.snapshot();
    expect(regions).toHaveLength(2);
    expect(regions.map(region => region.pixelCount)).toEqual([28 * 24, 28 * 24]);
    expect(regions.map(region => region.geometry.quality.maskIoU)).toEqual([1, 1]);
    await session.close();
  });

  it('fits the character head and retains independently editable interior holes', async () => {
    const character = makeSyntheticFixture('articulated-character');
    const session = await DecompositionSession.importSources([character.input], { mode: 'animation-ready' });
    await session.analyze();
    const head = session.snapshot().regions.find(region => region.pixelCount === 256)!;
    expect(head.geometry.generatedPath.points.length).toBeGreaterThan(4);
    expect(head.geometry.quality.maskIoU).toBeGreaterThan(.98);
    const second = await DecompositionSession.importSources([character.input], { mode: 'animation-ready' });
    await second.analyze();
    expect(second.snapshot().regions).toEqual(session.snapshot().regions);
    await second.close(); await session.close();
    for (const name of ['occlusion', 'pixel-art'] as const) {
      const fixture = makeSyntheticFixture(name);
      const withHole = await DecompositionSession.importSources([fixture.input]);
      await withHole.analyze();
      for (const region of withHole.snapshot().regions.filter(item => item.holeCount > 0))
        expect(region.geometry.generatedPath.holes?.length).toBe(region.holeCount);
      await withHole.close();
    }
  });

  it('retains a one-pixel line and authentic partial alpha as inspectable source evidence', async () => {
    const input = source(64, 40, (x, y) => {
      if (x >= 7 && x < 28 && y >= 7 && y < 32) return [52, 91, 170, 255];
      if (x >= 28 && x < 55 && y === 18) return [52, 91, 170, 255];
      if (x >= 6 && x < 29 && (y === 6 || y === 32)) return [52, 91, 170, 96];
      return [0, 0, 0, 0];
    });
    const session = await DecompositionSession.importSources([input]);
    await session.analyze();
    const { regions } = session.snapshot();
    expect(regions).toHaveLength(1);
    expect(regions[0].geometry.texture).toBe('source-crop');
    expect(regions[0].geometry.quality.maskIoU).toBeGreaterThan(.97);
    const mask = session.maskFor(regions[0].maskId);
    expect(mask.bytes[(18 - regions[0].bounds.y) * mask.width + 54 - regions[0].bounds.x]).toBe(1);
    const native = decodeProjectBytes((await session.exportHyde({ format: 'hyde' })).bytes);
    expect(native.assets).toHaveLength(1);
    const texture = decodePng(Uint8Array.from(Buffer.from(native.assets[0].dataUrl.split(',')[1], 'base64')));
    expect(texture.rgba[3]).toBe(96);
    await session.close();
    const withoutTexture = await DecompositionSession.importSources([input], { settings: { preserveTexture: false } });
    await withoutTexture.analyze();
    expect(withoutTexture.snapshot().diagnostics.map(item => item.code)).toContain('TEXTURE_APPROXIMATION');
    await withoutTexture.close();
  });

  it('lets the artist preserve a narrow high-contrast mark during small-island cleanup', async () => {
    const input = source(48, 40, (x, y) => {
      if (x >= 4 && x < 28 && y >= 4 && y < 32) return [70, 70, 70, 255];
      if (x >= 28 && x < 40 && y === 18) return [90, 70, 70, 255];
      return [0, 0, 0, 0];
    });
    const kept = await DecompositionSession.importSources([input], { settings: { minRegionPixels: 16, preserveThinLines: true } });
    await kept.analyze();
    expect(kept.snapshot().regions).toHaveLength(2);
    expect(kept.snapshot().regions.some(region => region.pixelCount === 12)).toBe(true);
    const saved = await kept.saveDocument();
    const reopened = await DecompositionSession.openDocument(saved);
    expect(reopened.snapshot().settings.preserveThinLines).toBe(true);
    await reopened.close(); await kept.close();
    const merged = await DecompositionSession.importSources([input], { settings: { minRegionPixels: 16, preserveThinLines: false } });
    await merged.analyze();
    expect(merged.snapshot().regions).toHaveLength(1);
    expect(merged.snapshot().regions[0].pixelCount).toBe(24 * 28 + 12);
    await merged.close();
  });
});
