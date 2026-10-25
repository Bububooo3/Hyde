// @vitest-environment node
import { expect, it } from 'vitest';
import { encodePng } from './image';
import { DecompositionSession } from './session';

function opaqueReference(): Uint8Array {
  const width = 24, height = 24, rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    rgba.set(x >= 8 && x < 16 && y >= 8 && y < 16 ? [184, 50, 38, 255] : [255, 255, 255, 255], (y * width + x) * 4);
  }
  return encodePng({ width, height, rgba });
}

it('revises an opaque reference background without destroying the original or committed reconstruction', async () => {
  const session = await DecompositionSession.importSources([{ bytes: opaqueReference(), name: 'opaque.png', mime: 'image/png', role: 'primary' }]);
  await session.analyze();
  const sourceId = session.snapshot().sources[0].id;
  expect(session.snapshot().regions.filter(item => item.generationStatus !== 'historical')).toHaveLength(1);
  const before = session.snapshot(), revision = session.revision;
  const invalid = await session.execute({ expectedRevision: revision, edits: [{ op: 'reference.setBackground', sourceId, color: 'white' }] });
  expect(invalid.ok).toBe(false);
  expect(session.revision).toBe(revision);
  expect(session.snapshot()).toEqual(before);
  const keepAll = await session.execute({ expectedRevision: revision, edits: [{ op: 'reference.setBackground', sourceId, color: null }] });
  expect(keepAll.ok).toBe(true);
  await session.analyze();
  const kept = session.snapshot();
  expect(kept.sources[0].backgroundColor).toBeNull();
  expect(kept.regions.filter(item => item.generationStatus !== 'historical')).toHaveLength(2);
  const white = kept.regions.find(item => item.color === '#ffffff' && item.generationStatus !== 'historical');
  expect(white?.pixelCount).toBe(24 * 24 - 8 * 8);
  const chosen = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'reference.setBackground', sourceId, color: '#FFFFFF' }] });
  expect(chosen.ok).toBe(true);
  await session.analyze();
  const corrected = session.snapshot();
  expect(corrected.sources[0].backgroundColor).toBe('#ffffff');
  expect(corrected.regions.filter(item => item.generationStatus !== 'historical')).toHaveLength(1);
  expect(corrected.regions.find(item => item.generationStatus !== 'historical')?.color).toBe('#b83226');
  const reopened = await DecompositionSession.openDocument(await session.saveDocument());
  expect(reopened.snapshot().sources[0].backgroundColor).toBe('#ffffff');
  expect(reopened.snapshot().regions.filter(item => item.generationStatus !== 'historical')).toHaveLength(1);
  expect(reopened.sourceBytesFor(sourceId)).toEqual(opaqueReference());
  const native = await reopened.exportHyde({ format: 'hyde' });
  expect(native.project.elements.some(item => item.fill === '#b83226')).toBe(true);
  await reopened.close(); await session.close();
});

it('keeps alpha segmentation authoritative and reports an inactive opaque-background choice', async () => {
  const rgba = new Uint8Array(16 * 16 * 4);
  for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) rgba.set([184, 50, 38, 255], (y * 16 + x) * 4);
  const session = await DecompositionSession.importSources([{ bytes: encodePng({ width: 16, height: 16, rgba }), name: 'transparent.png', mime: 'image/png', role: 'primary' }]);
  const sourceId = session.snapshot().sources[0].id;
  const edit = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'reference.setBackground', sourceId, color: '#b83226' }] });
  expect(edit.ok).toBe(true);
  await session.analyze();
  expect(session.snapshot().diagnostics.some(item => item.code === 'BACKGROUND_OVERRIDE_INACTIVE' && item.sourceId === sourceId)).toBe(true);
  expect(session.snapshot().regions.filter(item => item.generationStatus !== 'historical').map(item => item.pixelCount)).toEqual([64]);
  await session.close();
});
