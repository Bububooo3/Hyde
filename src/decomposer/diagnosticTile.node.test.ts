// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from './image';
import { DecompositionSession } from './session';

function artwork() {
  const width = 24, height = 20, rgba = new Uint8Array(width * height * 4);
  for (let y = 4; y < 16; y++) for (let x = 5; x < 19; x++) rgba.set([171, 63, 44, 255], (y * width + x) * 4);
  return { bytes: encodePng({ width, height, rgba }), name: 'tile.png', mime: 'image/png' };
}

describe('bounded decomposition evidence inspection', () => {
  it('returns exact source pixels, editable mask coverage and visible boundary evidence after reopen', async () => {
    const session = await DecompositionSession.importSources([artwork()]);
    try {
      await session.analyze();
      const region = session.snapshot().regions[0];
      const request = { view: 'source' as const, bounds: { x: 4, y: 3, width: 4, height: 4 } };
      const sourceTile = session.renderDiagnosticTile(request);
      expect(sourceTile).toMatchObject({ mime: 'image/png', bounds: request.bounds });
      const source = decodePng(sourceTile.bytes);
      expect(source.width).toBe(4);
      expect(Array.from(source.rgba.subarray((2 * 4 + 2) * 4, (2 * 4 + 2) * 4 + 4))).toEqual([171, 63, 44, 255]);
      const mask = decodePng(session.renderDiagnosticTile({ view: 'mask', regionId: region.id,
        bounds: { x: 0, y: 0, width: 24, height: 20 } }).bytes);
      expect(mask.rgba[(8 * 24 + 8) * 4 + 3]).toBe(255);
      expect(mask.rgba[(1 * 24 + 1) * 4 + 3]).toBe(0);
      const evidence = decodePng(session.renderDiagnosticTile({ view: 'evidence', regionId: region.id,
        bounds: { x: 0, y: 0, width: 24, height: 20 } }).bytes);
      expect(Array.from(evidence.rgba.subarray((4 * 24 + 8) * 4, (4 * 24 + 8) * 4 + 4))).toEqual([255, 38, 38, 255]);
      expect(Array.from(evidence.rgba.subarray((8 * 24 + 8) * 4, (8 * 24 + 8) * 4 + 4))).toEqual([171, 63, 44, 255]);
      const reopened = await DecompositionSession.openDocument(await session.saveDocument());
      expect(reopened.renderDiagnosticTile(request).bytes).toEqual(sourceTile.bytes);
      await reopened.close();
    } finally { await session.close(); }
  });

  it('rejects missing IDs, mixed-source requests, large tiles and malformed pagination explicitly', async () => {
    const session = await DecompositionSession.importSources([artwork()]);
    try {
      await session.analyze();
      const regionId = session.snapshot().regions[0].id;
      expect(session.inspect({ target: 'region', id: 'missing' })).toMatchObject({ error: { code: 'TARGET_NOT_FOUND' } });
      expect(session.inspect({ target: 'regions', limit: Number.NaN })).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
      expect(session.inspect({ target: 'unknown' as never })).toMatchObject({ error: { code: 'OPERATION_UNSUPPORTED' } });
      expect(() => session.renderDiagnosticTile({ view: 'mask', regionId: 'missing' })).toThrow('TARGET_NOT_FOUND');
      expect(() => session.renderDiagnosticTile({ view: 'mask', regionId, sourceId: 'missing' })).toThrow('TARGET_NOT_FOUND');
      expect(() => session.renderDiagnosticTile({ view: 'source', bounds: { x: 0, y: 0, width: 513, height: 1 } })).toThrow('RESOURCE_LIMIT');
    } finally { await session.close(); }
  });
});
