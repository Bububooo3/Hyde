// @vitest-environment node
import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runBrowserTask } from '../cliBrowserRunner';
import { makeSmoothArticulatedFixture } from '../../tests/decomposerSmoothFixture';
import { DecompositionSession } from './session';
import { compareNativeRender } from './quality';
import { decodePng } from './image';
import { poseNativeDecomposition } from './pose';

it('keeps an antialiased articulated reference editable and renders a smooth manual hinge pose', async () => {
  const fixture = makeSmoothArticulatedFixture();
  const session = await DecompositionSession.importSources([fixture.input], { mode: 'animation-ready' });
  try {
    await session.analyze();
    const doc = session.snapshot();
    expect(doc.diagnostics.map(item => item.code)).not.toContain('LOW_SOURCE_RESOLUTION');
    const arm = doc.parts.find(part => part.bounds.x < 60 && part.bounds.y < 100 && part.bounds.width > 20 && part.bounds.height >= 10);
    const torso = doc.parts.find(part => part.id !== arm?.id && part.bounds.x <= 75 && part.bounds.x + part.bounds.width >= 120 && part.bounds.y <= 65);
    expect(arm, 'The left painted arm should remain independently editable.').toBeTruthy();
    expect(torso, 'A separate torso should remain available as a parent.').toBeTruthy();
    const accepted = await session.execute({ expectedRevision: session.revision, edits: [
      { op: 'part.reparent', partId: arm!.id, parentId: torso!.id },
      { op: 'part.setPivot', partId: arm!.id, x: 71, y: 87 },
      { op: 'part.setAttachment', partId: arm!.id, type: 'hinge', min: -35, max: 35, approved: true },
    ] });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    const native = await session.exportHyde({ format: 'hyde' });
    const pose = poseNativeDecomposition(native, arm!.id, 25);
    expect(pose.appliedValue).toBe(25);
    expect(native.project.elements.every(element => !element.tracks.length && !element.assemblyClips?.length && !element.motionBehaviors?.length)).toBe(true);
    if (process.env.HYDE_TEST_BROWSER) {
      const options = { timeSeconds: 0, width: fixture.image.width, height: fixture.image.height, format: 'png' as const };
      const neutral = await runBrowserTask(native.project, { kind: 'preview', options });
      const posed = await runBrowserTask(pose.project, { kind: 'preview', options });
      const quality = compareNativeRender(fixture.image, neutral.bytes, session.snapshot());
      expect(quality.silhouette.iou).toBeGreaterThan(.97);
      expect(quality.color.meanAbsoluteSrgbChannelError!).toBeLessThan(.04);
      const neutralPixels = decodePng(neutral.bytes).rgba, posedPixels = decodePng(posed.bytes).rgba;
      expect(posedPixels.some((channel, at) => channel !== neutralPixels[at])).toBe(true);
      expect(posedPixels.filter((value, at) => at % 4 === 3 && value > 0 && value < 255).length).toBeGreaterThan(80);
      if (process.env.HYDE_CAPTURE_SMOOTH_POSE) {
        await writeFile(join(process.env.HYDE_CAPTURE_SMOOTH_POSE, '02-smooth-source.png'), fixture.input.bytes);
        await writeFile(join(process.env.HYDE_CAPTURE_SMOOTH_POSE, '02-smooth-native.png'), neutral.bytes);
        await writeFile(join(process.env.HYDE_CAPTURE_SMOOTH_POSE, '02-smooth-posed.png'), posed.bytes);
      }
    }
  } finally { await session.close(); }
}, 120_000);
