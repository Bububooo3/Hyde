// @vitest-environment node
import { expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runBrowserTask } from '../cliBrowserRunner';
import { DecompositionSession } from './session';
import { compareNativeRender } from './quality';
import { encodePng } from './image';
import { makeSyntheticFixture } from '../../tests/decomposerSyntheticFixtures';

it('keeps a layered antialiased illustration in distinct, inspectable parts', async () => {
  const fixture = makeSyntheticFixture('storybook-fox');
  const session = await DecompositionSession.importSources([fixture.input], { mode: 'animation-ready' });
  try {
    await session.analyze();
    const document = session.snapshot();
    const regions = document.regions.filter(region => region.generationStatus !== 'historical');
    console.info('complex-art structure', JSON.stringify({ regions: regions.length, parts: document.parts.length,
      tiny: regions.filter(region => region.pixelCount < document.settings.minRegionPixels).length,
      holes: regions.filter(region => region.holeCount).length,
      diagnostics: document.diagnostics.reduce<Record<string, number>>((counts, item) => { counts[item.code] = (counts[item.code] ?? 0) + 1; return counts; }, {}) }));
    expect(regions.length).toBeGreaterThan(5);
    expect(regions.length).toBeLessThan(80);
    expect(document.parts.length).toBeGreaterThan(3);
    expect(document.parts.length).toBeLessThan(regions.length + 1);
    expect(regions.every(region => region.geometry.generatedPath.points.length >= 3)).toBe(true);
    expect(regions.some(region => region.geometry.texture === 'source-crop')).toBe(true);
    const reopened = await DecompositionSession.openDocument(await session.saveDocument());
    expect(reopened.snapshot().regions).toEqual(document.regions);
    await reopened.close();
  } finally { await session.close(); }
}, 120_000);

(process.env.HYDE_TEST_BROWSER ? it : it.skip)('measures the layered illustration using actual Hyde pixels', async () => {
  const fixture = makeSyntheticFixture('storybook-fox');
  const session = await DecompositionSession.importSources([fixture.input], { mode: 'animation-ready' });
  try {
    await session.analyze();
    const document = session.snapshot();
    const native = await session.exportHyde({ format: 'hyde', allowHoleApproximation: true });
    const frame = await runBrowserTask(native.project, { kind: 'preview', options: {
      timeSeconds: 0, width: fixture.image.width, height: fixture.image.height, format: 'png',
    } });
    const quality = compareNativeRender(fixture.image, frame.bytes, document);
    if (process.env.HYDE_CAPTURE_COMPLEX) {
      await mkdir(process.env.HYDE_CAPTURE_COMPLEX, { recursive: true });
      await Promise.all([
        writeFile(join(process.env.HYDE_CAPTURE_COMPLEX, 'storybook-fox-source.png'), encodePng(fixture.image)),
        writeFile(join(process.env.HYDE_CAPTURE_COMPLEX, 'storybook-fox-hyde.png'), frame.bytes),
        writeFile(join(process.env.HYDE_CAPTURE_COMPLEX, 'storybook-fox-residual.png'), quality.residualOverlayPng),
      ]);
    }
    console.info('complex-art native quality', JSON.stringify({ iou: quality.silhouette.iou,
      boundaryMean: quality.boundary.meanDistancePixels, uncovered: quality.coverage.uncoveredPixels,
      excess: quality.coverage.excessPixels, colorError: quality.color.meanAbsoluteSrgbChannelError,
      regions: quality.complexity.activeRegionCount, parts: quality.complexity.activePartCount,
      warnings: native.warnings.reduce<Record<string, number>>((counts, item) => { counts[item.code] = (counts[item.code] ?? 0) + 1; return counts; }, {}) }));
    expect(quality.silhouette.iou).toBeGreaterThan(.98);
    expect(quality.boundary.meanDistancePixels).not.toBeNull();
    expect(quality.boundary.meanDistancePixels!).toBeLessThan(.8);
    expect(quality.color.meanAbsoluteSrgbChannelError!).toBeLessThan(.03);
    expect(quality.complexity.activePartCount).toBeGreaterThan(3);
    expect(native.project.elements.filter(element => element.shapePath).length).toBe(document.regions.filter(region => region.generationStatus !== 'historical' && !region.suppressed).length);
    expect(native.project.elements.every(element => !element.tracks.length && !element.assemblyClips?.length && !element.motionBehaviors?.length)).toBe(true);
  } finally { await session.close(); }
}, 120_000);
