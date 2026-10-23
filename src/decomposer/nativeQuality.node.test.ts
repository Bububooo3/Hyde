// @vitest-environment node
import { expect, it } from 'vitest';
import { runBrowserTask } from '../cliBrowserRunner';
import { DecompositionSession } from './session';
import { compareNativeRender } from './quality';
import { makeSyntheticFixture } from '../../tests/decomposerSyntheticFixtures';

// Runs against Hyde's actual Pixi renderer. The default unit suite remains
// browser-independent; set HYDE_TEST_BROWSER=1 when checking visual output.
(process.env.HYDE_TEST_BROWSER ? it : it.skip)('measures native-render quality and editability on distinct decomposition challenges', async () => {
  const cases = [
    { name: 'articulated-character', mode: 'animation-ready' },
    { name: 'occlusion', mode: 'appearance' },
    { name: 'occlusion', mode: 'animation-ready' },
    { name: 'pixel-art', mode: 'appearance' },
  ] as const;
  for (const { name, mode } of cases) {
    const fixture = makeSyntheticFixture(name);
    const session = await DecompositionSession.importSources([fixture.input], { mode });
    try {
      await session.analyze();
      const document = session.snapshot();
      const native = await session.exportHyde({ format: 'hyde', allowHoleApproximation: true });
      const frame = await runBrowserTask(native.project, { kind: 'preview', options: {
        timeSeconds: 0, width: fixture.image.width, height: fixture.image.height, format: 'png',
      } });
      const quality = compareNativeRender(fixture.image, frame.bytes, document);
      expect(quality.width).toBe(fixture.image.width);
      expect(quality.height).toBe(fixture.image.height);
      expect(quality.silhouette.iou, name).toBeGreaterThan(.95);
      expect(quality.boundary.meanDistancePixels, name).not.toBeNull();
      expect(quality.boundary.meanDistancePixels!, name).toBeLessThan(1);
      expect(quality.color.meanAbsoluteSrgbChannelError!, name).toBeLessThan(.05);
      expect(quality.complexity.activeRegionCount).toBeGreaterThan(1);
      if (name === 'occlusion') expect(quality.complexity.inferredRegionCount).toBe(mode === 'animation-ready' ? 1 : 0);
      if (name !== 'articulated-character') expect(native.warnings.map(item => item.code), name).toContain('HOLE_NOT_REPRESENTABLE');
      expect(native.project.elements.every(element => element.tracks.length === 0 && !element.assemblyClips?.length && !element.motionBehaviors?.length)).toBe(true);
      console.info(`native-quality ${name}/${mode}`, JSON.stringify({
        iou: quality.silhouette.iou, boundaryMean: quality.boundary.meanDistancePixels,
        uncovered: quality.coverage.uncoveredPixels, excess: quality.coverage.excessPixels,
        colorError: quality.color.meanAbsoluteSrgbChannelError,
        regions: quality.complexity.activeRegionCount, parts: quality.complexity.activePartCount,
        warnings: native.warnings.map(item => item.code),
      }));
    } finally { await session.close(); }
  }
}, 120_000);
