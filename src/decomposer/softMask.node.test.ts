// @vitest-environment node
import { expect, it } from 'vitest';
import { runBrowserTask } from '../cliBrowserRunner';
import { decodePng, encodePng } from './image';
import { DecompositionSession } from './session';

it('preserves editable soft-mask coverage through undo, source-document reopen and native Hyde export', async () => {
  const width = 20, height = 20, rgba = new Uint8Array(width * height * 4);
  for (let y = 3; y < 17; y++) for (let x = 3; x < 17; x++) rgba.set([192, 80, 46, 255], (y * width + x) * 4);
  const bytes = encodePng({ width, height, rgba });
  const session = await DecompositionSession.importSources([{ bytes, name: 'flat.png', mime: 'image/png' }]);
  await session.analyze();
  const region = session.snapshot().regions[0];
  expect(region.geometry.texture).toBe('flat');
  const original = session.maskFor(region.maskId);
  expect(() => session.stageMask({ width: 2, height: 1, bytes: Uint8Array.of(1, 0), alpha: Uint8Array.of(255, 64) })).toThrow('Invalid soft mask');
  const alpha = Uint8Array.from(original.bytes, bit => bit ? 255 : 0);
  const softPixel = Math.floor(original.height / 2) * original.width + Math.floor(original.width / 2);
  expect(original.bytes[softPixel]).toBe(1);
  alpha[softPixel] = 96;
  const edited = { ...original, alpha };
  const handle = session.stageMask(edited);
  const result = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'region.refineMask', regionId: region.id, handle }] });
  expect(result.ok).toBe(true);
  const current = session.snapshot().regions.find(item => item.id === region.id)!;
  expect(session.maskFor(current.maskId).alpha?.[softPixel]).toBe(96);
  const native = await session.exportHyde({ format: 'hyde' });
  const polygon = native.project.elements.find(item => item.id === native.mapping.regionIds[region.id])!;
  expect(polygon.assetId).toBeTruthy();
  const texture = native.project.assets.find(item => item.id === polygon.assetId)!;
  const png = decodePng(Uint8Array.from(Buffer.from(texture.dataUrl.split(',')[1], 'base64')));
  expect(png.rgba[softPixel * 4 + 3]).toBe(96);
  if (process.env.HYDE_TEST_BROWSER) {
    const rendered = await runBrowserTask(native.project, { kind: 'preview', options: { timeSeconds: 0, width, height, format: 'png' } });
    const pixels = decodePng(rendered.bytes).rgba;
    const imageX = region.bounds.x + softPixel % original.width, imageY = region.bounds.y + Math.floor(softPixel / original.width);
    expect(pixels[(imageY * width + imageX) * 4 + 3]).toBeGreaterThanOrEqual(80);
    expect(pixels[(imageY * width + imageX) * 4 + 3]).toBeLessThanOrEqual(110);
  }
  expect(native.warnings.map(item => item.code)).toContain('TEXTURE_APPROXIMATION');
  const reopened = await DecompositionSession.openDocument(await session.saveDocument());
  expect(reopened.maskFor(current.maskId).alpha).toEqual(alpha);
  expect(reopened.sourceBytesFor(region.sourceId)).toEqual(bytes);
  await reopened.close();
  expect(session.undo(session.revision)).toBe(true);
  const reverted = session.snapshot().regions.find(item => item.id === region.id)!;
  expect(session.maskFor(reverted.maskId).alpha).toBeUndefined();
  await session.close();
}, 30_000);

it('keeps a source antialias fringe outside the hard threshold as native editable geometry', async () => {
  const width = 24, height = 24, rgba = new Uint8Array(width * height * 4);
  for (let y = 4; y < 20; y++) for (let x = 4; x < 20; x++) {
    const edge = x === 4 || x === 19 || y === 4 || y === 19;
    rgba.set([220, 74, 45, edge ? 96 : 255], (y * width + x) * 4);
  }
  const bytes = encodePng({ width, height, rgba });
  const session = await DecompositionSession.importSources([{ bytes, name: 'antialias.png', mime: 'image/png' }], { settings: { alphaThreshold: 128, preserveTexture: false } });
  await session.analyze();
  const region = session.snapshot().regions.find(item => item.geometry.status === 'visible')!;
  expect(region.bounds).toMatchObject({ x: 4, y: 4, width: 16, height: 16 });
  expect(region.geometry.texture).toBe('source-crop');
  expect(session.maskFor(region.maskId).bytes[0]).toBe(1);
  const native = await session.exportHyde({ format: 'hyde' });
  const polygon = native.project.elements.find(item => item.id === native.mapping.regionIds[region.id])!;
  expect(polygon.shapePath?.points.length).toBeGreaterThanOrEqual(4);
  const texture = native.project.assets.find(item => item.id === polygon.assetId)!;
  const crop = decodePng(Uint8Array.from(Buffer.from(texture.dataUrl.split(',')[1], 'base64')));
  expect(crop.rgba[3]).toBe(96);
  if (process.env.HYDE_TEST_BROWSER) {
    const rendered = await runBrowserTask(native.project, { kind: 'preview', options: { timeSeconds: 0, width, height, format: 'png' } });
    const renderedAlpha = decodePng(rendered.bytes).rgba[(4 * width + 4) * 4 + 3];
    expect(renderedAlpha).toBeGreaterThanOrEqual(75);
    expect(renderedAlpha).toBeLessThanOrEqual(115);
  }
  await session.close();
}, 30_000);

it('expands a guided outward feather into transparent pixels without changing source evidence', async () => {
  const width = 24, height = 24, rgba = new Uint8Array(width * height * 4);
  for (let y = 6; y < 18; y++) for (let x = 6; x < 18; x++) rgba.set([194, 86, 51, 255], (y * width + x) * 4);
  const bytes = encodePng({ width, height, rgba });
  const session = await DecompositionSession.importSources([{ bytes, name: 'outward.png', mime: 'image/png' }]);
  await session.analyze();
  const before = session.snapshot().regions[0], sourceMask = session.maskFor(before.maskId);
  const changed = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'region.featherOutside', regionId: before.id, radius: 2, strength: .8 }] });
  expect(changed.ok).toBe(true);
  const after = session.snapshot().regions.find(item => item.id === before.id)!;
  expect(after.bounds.x).toBe(4);
  expect(after.originalMaskId).toBe(before.maskId);
  const expanded = session.maskFor(after.maskId);
  const local = (12 - after.bounds.y) * expanded.width + 4 - after.bounds.x;
  expect(expanded.alpha?.[local]).toBeGreaterThan(50);
  expect(session.maskFor(before.maskId)).toEqual(sourceMask);
  const native = await session.exportHyde({ format: 'hyde' });
  const shape = native.project.elements.find(item => item.id === native.mapping.regionIds[after.id])!;
  const crop = decodePng(Uint8Array.from(Buffer.from(native.project.assets.find(item => item.id === shape.assetId)!.dataUrl.split(',')[1], 'base64')));
  expect(crop.rgba[local * 4 + 3]).toBe(expanded.alpha?.[local]);
  if (process.env.HYDE_TEST_BROWSER) {
    const rendered = await runBrowserTask(native.project, { kind: 'preview', options: { timeSeconds: 0, width, height, format: 'png' } });
    expect(decodePng(rendered.bytes).rgba[(12 * width + 4) * 4 + 3]).toBeGreaterThan(25);
  }
  const reopened = await DecompositionSession.openDocument(await session.saveDocument());
  expect(reopened.maskFor(after.maskId).alpha).toEqual(expanded.alpha);
  await reopened.close();
  expect(session.undo(session.revision)).toBe(true);
  expect(session.snapshot().regions[0].bounds).toEqual(before.bounds);
  await session.close();
}, 30_000);

it('extends a brushed region beyond its first-pass bounds through native export and source recovery', async () => {
  const width = 24, height = 24, rgba = new Uint8Array(width * height * 4);
  for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) rgba.set([194, 86, 51, 255], (y * width + x) * 4);
  const session = await DecompositionSession.importSources([{ bytes: encodePng({ width, height, rgba }), name: 'brush.png', mime: 'image/png' }]);
  await session.analyze();
  const before = session.snapshot().regions[0], original = session.maskFor(before.maskId);
  const bounds = { x: 5, y: 8, width: 11, height: 8 };
  const bytes = new Uint8Array(bounds.width * bounds.height);
  for (let row = 0; row < original.height; row++) bytes.set(original.bytes.subarray(row * original.width, (row + 1) * original.width), row * bounds.width + before.bounds.x - bounds.x);
  for (let column = 0; column <= 3; column++) bytes[3 * bounds.width + column] = 1;
  const handle = session.stageMask({ width: bounds.width, height: bounds.height, bytes, alpha: Uint8Array.from(bytes, bit => bit ? 255 : 0) });
  const changed = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'region.refineMask', regionId: before.id, handle, bounds }] });
  expect(changed.ok, JSON.stringify(changed)).toBe(true);
  const after = session.snapshot().regions[0];
  expect(after.bounds).toEqual(bounds);
  expect(after.originalMaskId).toBe(before.maskId);
  const native = await session.exportHyde({ format: 'hyde' });
  const shape = native.project.elements.find(item => item.id === native.mapping.regionIds[after.id])!;
  expect(shape.shapePath?.points.length).toBeGreaterThanOrEqual(4);
  const crop = decodePng(Uint8Array.from(Buffer.from(native.project.assets.find(item => item.id === shape.assetId)!.dataUrl.split(',')[1], 'base64')));
  expect(crop.rgba[(3 * bounds.width) * 4 + 3]).toBe(255);
  if (process.env.HYDE_TEST_BROWSER) {
    const rendered = await runBrowserTask(native.project, { kind: 'preview', options: { timeSeconds: 0, width, height, format: 'png' } });
    expect(decodePng(rendered.bytes).rgba[(11 * width + 5) * 4 + 3]).toBeGreaterThan(200);
  }
  const reopened = await DecompositionSession.openDocument(await session.saveDocument());
  expect(reopened.snapshot().regions[0].bounds).toEqual(bounds);
  expect(reopened.maskFor(after.maskId).bytes[3 * bounds.width]).toBe(1);
  expect(reopened.maskFor(before.maskId)).toEqual(original);
  await reopened.close();
  expect(session.undo(session.revision)).toBe(true);
  expect(session.snapshot().regions[0].bounds).toEqual(before.bounds);
  await session.close();
}, 30_000);
