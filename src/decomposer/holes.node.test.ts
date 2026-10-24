// @vitest-environment node
import { expect, it } from 'vitest';
import { decodeAssemblyBytes, decodeProjectBytes } from '../archive';
import { HydeAuthoringSession } from '../authoring';
import { runBrowserTask } from '../cliBrowserRunner';
import { pointInShapePath } from '../shapePath';
import { decodePng, encodePng } from './image';
import { compareNativeRender } from './quality';
import { DecompositionSession } from './session';

function holedArt(textured = false) {
  const width = 72, height = 64, rgba = new Uint8Array(width * height * 4);
  for (let y = 7; y < 57; y++) for (let x = 8; x < 64; x++) {
    if (x >= 20 && x < 31 && y >= 21 && y < 34 || x >= 43 && x < 54 && y >= 28 && y < 45) continue;
    rgba.set([textured ? 120 + x : 176, textured ? 55 + (y >> 1) : 68, 51, 255], (y * width + x) * 4);
  }
  return { image: { width, height, rgba }, input: { bytes: encodePng({ width, height, rgba }),
    name: textured ? 'textured-holes.png' : 'flat-holes.png', mime: 'image/png' } };
}

it('fits two independently editable native hole contours and preserves them through both Hyde archives', async () => {
  const fixture = holedArt();
  const session = await DecompositionSession.importSources([fixture.input]);
  try {
    await session.analyze();
    const region = session.snapshot().regions.find(item => item.holeCount === 2)!;
    expect(region).toBeTruthy();
    expect(region.geometry.generatedPath.holes).toHaveLength(2);
    expect(region.geometry.quality.maskIoU).toBeGreaterThan(.99);
    const native = await session.exportHyde({ format: 'hyde' });
    expect(native.warnings.map(item => item.code)).not.toContain('HOLE_NOT_REPRESENTABLE');
    const path = native.project.elements.find(item => item.id === native.mapping.regionIds[region.id])!.shapePath!;
    expect(path.holes).toHaveLength(2);
    expect(pointInShapePath(path, region.bounds.width, region.bounds.height, 17, 20)).toBe(false);
    expect(pointInShapePath(path, region.bounds.width, region.bounds.height, 8, 8)).toBe(true);
    expect(decodeProjectBytes(native.bytes).elements.find(item => item.id === native.mapping.regionIds[region.id])!.shapePath).toEqual(path);
    const sdk = HydeAuthoringSession.open(native.bytes);
    const regionId = native.mapping.regionIds[region.id];
    const outerBefore = structuredClone(path.points);
    const holeBefore = structuredClone(path.holes![0].points);
    const moved = await sdk.execute({ protocolVersion: 1, expectedRevision: sdk.revision, commands: [
      { op: 'shape.movePoint', args: { id: regionId, contourIndex: 1, index: 0, x: holeBefore[0].x + .01, y: holeBefore[0].y } },
    ] });
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    const editedPath = decodeProjectBytes(sdk.exportProject()).elements.find(item => item.id === regionId)!.shapePath!;
    expect(editedPath.points).toEqual(outerBefore);
    expect(editedPath.holes![0].points[0].x).toBeCloseTo(holeBefore[0].x + .01);
    const invalid = await sdk.execute({ protocolVersion: 1, expectedRevision: sdk.revision, commands: [
      { op: 'shape.movePoint', args: { id: regionId, contourIndex: 3, index: 0, x: 0, y: 0 } },
    ] });
    expect(invalid.ok).toBe(false);
    expect(sdk.snapshot().elements.find(item => item.id === regionId)!.shapePath).toEqual(editedPath);
    const assembly = await session.exportHyde({ format: 'hyproj' });
    expect(decodeAssemblyBytes(assembly.bytes).elements.find(item => item.id === native.mapping.regionIds[region.id])!.shapePath).toEqual(path);
    const reopened = await DecompositionSession.openDocument(await session.saveDocument());
    expect(reopened.snapshot().regions.find(item => item.id === region.id)!.geometry.generatedPath.holes).toEqual(path.holes);
    await reopened.close();
  } finally { await session.close(); }
});

it('requires explicit fallback if a manual path discards a source hole', async () => {
  const fixture = holedArt();
  const session = await DecompositionSession.importSources([fixture.input]);
  try {
    await session.analyze();
    const region = session.snapshot().regions.find(item => item.holeCount === 2)!;
    const path = structuredClone(region.geometry.generatedPath);
    path.holes = path.holes?.slice(0, 1);
    const edited = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'region.setPath', regionId: region.id, path }] });
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    await expect(session.exportHyde({ format: 'hyde' })).rejects.toThrow('HOLE_NOT_REPRESENTABLE');
    const fallback = await session.exportHyde({ format: 'hyde', allowHoleApproximation: true });
    expect(fallback.warnings.map(item => item.code)).toContain('HOLE_NOT_REPRESENTABLE');
  } finally { await session.close(); }
});

(process.env.HYDE_TEST_BROWSER ? it : it.skip)('renders editable flat and textured hole masks in actual Hyde', async () => {
  for (const textured of [false, true]) {
    const fixture = holedArt(textured);
    const session = await DecompositionSession.importSources([fixture.input]);
    try {
      await session.analyze();
      const native = await session.exportHyde({ format: 'hyde' });
      const png = await runBrowserTask(native.project, { kind: 'preview', options: { timeSeconds: 0, width: fixture.image.width, height: fixture.image.height, format: 'png' } });
      const decoded = decodePng(png.bytes);
      const quality = compareNativeRender(fixture.image, png.bytes, session.snapshot());
      expect(decoded.rgba[(25 * fixture.image.width + 25) * 4 + 3], 'first native hole').toBe(0);
      expect(decoded.rgba[(35 * fixture.image.width + 48) * 4 + 3], 'second native hole').toBe(0);
      expect(quality.silhouette.iou).toBeGreaterThan(.98);
      expect(quality.color.meanAbsoluteSrgbChannelError!).toBeLessThan(.03);
    } finally { await session.close(); }
  }
}, 120_000);
