// @vitest-environment node
import { expect, it } from 'vitest';
import { DecompositionSession } from './session';
import { encodePng, sourceColorMetadataWarning, unsupportedPngColorMetadata } from './image';

function withChunk(png: Uint8Array, type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, 8 + data.length)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
  const afterHeader = 8 + 12 + 13;
  const output = new Uint8Array(png.length + chunk.length);
  output.set(png.subarray(0, afterHeader)); output.set(chunk, afterHeader);
  output.set(png.subarray(afterHeader), afterHeader + chunk.length);
  return output;
}

it('warns when PNG color metadata is retained but not applied to canonical analysis pixels', async () => {
  const rgba = new Uint8Array(16 * 16 * 4);
  for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) rgba.set([187, 63, 42, 255], (y * 16 + x) * 4);
  const plain = encodePng({ width: 16, height: 16, rgba });
  const gamma = withChunk(plain, 'gAMA', Uint8Array.of(0, 0, 177, 143));
  expect(unsupportedPngColorMetadata(gamma)).toMatch(/gamma\/chromaticity/);
  expect(unsupportedPngColorMetadata(withChunk(gamma, 'sRGB', Uint8Array.of(0)))).toBeUndefined();
  expect(unsupportedPngColorMetadata(withChunk(plain, 'iCCP', Uint8Array.of(0)))).toMatch(/ICC profile/);
  const session = await DecompositionSession.importSources([{ bytes: gamma, name: 'gamma.png', mime: 'image/png' }]);
  try {
    expect(session.snapshot().diagnostics).toEqual([expect.objectContaining({ code: 'COLOR_SPACE_WARNING', severity: 'warning' })]);
    await session.analyze();
    expect(session.snapshot().diagnostics.some(item => item.code === 'COLOR_SPACE_WARNING')).toBe(true);
    const reopened = await DecompositionSession.openDocument(await session.saveDocument());
    expect(reopened.sourceBytesFor(reopened.snapshot().sources[0].id)).toEqual(gamma);
    expect(reopened.snapshot().diagnostics.some(item => item.code === 'COLOR_SPACE_WARNING')).toBe(true);
    await reopened.close();
  } finally { await session.close(); }
});

it('keeps JPEG and WebP ICC metadata visible as source warnings after analysis and reopen', async () => {
  const profile = new TextEncoder().encode('ICC_PROFILE\0');
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe2, 0, profile.length + 4, ...profile, 1, 1, 0xff, 0xda]);
  const webp = new Uint8Array(12 + 8 + 2);
  webp.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(webp.buffer).setUint32(4, webp.length - 8, true);
  webp.set(new TextEncoder().encode('WEBPICCP'), 8);
  new DataView(webp.buffer).setUint32(16, 2, true);
  webp.set([1, 2], 20);
  expect(sourceColorMetadataWarning('image/jpeg', jpeg)).toMatch(/JPEG ICC profile/);
  expect(sourceColorMetadataWarning('image/webp', webp)).toMatch(/WebP ICC profile/);
  expect(sourceColorMetadataWarning('image/jpeg', Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).toBeUndefined();
  const rgba = new Uint8Array(16 * 16 * 4);
  for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) rgba.set([187, 63, 42, 255], (y * 16 + x) * 4);
  for (const [name, mime, bytes] of [['profile.jpg', 'image/jpeg', jpeg], ['profile.webp', 'image/webp', webp]] as const) {
    const session = await DecompositionSession.importSources([{ name, mime, bytes, decoded: { width: 16, height: 16, rgba } }]);
    try {
      expect(session.snapshot().diagnostics).toEqual([expect.objectContaining({ code: 'COLOR_SPACE_WARNING', severity: 'warning' })]);
      await session.analyze();
      expect(session.snapshot().diagnostics.some(item => item.code === 'COLOR_SPACE_WARNING')).toBe(true);
      const reopened = await DecompositionSession.openDocument(await session.saveDocument());
      expect(reopened.sourceBytesFor(reopened.snapshot().sources[0].id)).toEqual(bytes);
      expect(reopened.snapshot().diagnostics.some(item => item.code === 'COLOR_SPACE_WARNING')).toBe(true);
      await reopened.close();
    } finally { await session.close(); }
  }
});
