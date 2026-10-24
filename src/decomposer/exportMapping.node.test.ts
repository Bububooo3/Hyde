// @vitest-environment node
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { makeSyntheticFixture } from '../../tests/decomposerSyntheticFixtures';
import { DecompositionSession } from './session';

it('records a versioned native mapping in the recoverable source and invalidates it after an edit', async () => {
  const fixture = makeSyntheticFixture('simple-icon');
  const session = await DecompositionSession.importSources([fixture.input]);
  try {
    await session.analyze();
    const revision = session.revision;
    const native = await session.exportHyde({ format: 'hyproj', name: 'Mapped icon' });
    expect(session.revision).toBe(revision);
    expect(native.mapping).toMatchObject({ sdkVersion: '0.1.0', nativeSchemaVersion: 1, format: 'hyproj',
      options: { name: 'Mapped icon', allowHoleApproximation: false }, warnings: [] });
    expect(native.mapping.outputFingerprint).toBe(createHash('sha256').update(native.bytes).digest('hex'));
    const region = session.snapshot().regions[0];
    expect(native.mapping.regionIds[region.id]).toBeTruthy();
    expect(native.mapping.geometryIds[region.geometry.id]).toBe(native.mapping.regionIds[region.id]);
    await expect(session.exportHyde({ format: 'hyde', width: 0 })).rejects.toThrow();
    expect(session.snapshot().exportMapping).toEqual(native.mapping);
    const reopened = await DecompositionSession.openDocument(await session.saveDocument());
    expect(reopened.snapshot().exportMapping).toEqual(native.mapping);
    const repeat = await reopened.exportHyde({ format: 'hyproj', name: 'Mapped icon' });
    expect(repeat.mapping.sourceFingerprint).toBe(native.mapping.sourceFingerprint);
    expect(repeat.mapping.outputFingerprint).toBe(createHash('sha256').update(repeat.bytes).digest('hex'));
    const part = reopened.snapshot().parts[0];
    const changed = await reopened.execute({ expectedRevision: reopened.revision,
      edits: [{ op: 'part.rename', partId: part.id, name: 'Edited part' }] });
    expect(changed.ok).toBe(true);
    expect(reopened.snapshot().exportMapping).toBeUndefined();
    await reopened.close();
  } finally { await session.close(); }
});
