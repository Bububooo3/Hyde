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
