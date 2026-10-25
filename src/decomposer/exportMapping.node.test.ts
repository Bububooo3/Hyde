// @vitest-environment node
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { makeSyntheticFixture } from '../../tests/decomposerSyntheticFixtures';
import { DecompositionSession } from './session';
import { decodeAssemblyBytes } from '../archive';

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

it('plans and explicitly replaces a matching native assembly without losing stable IDs', async () => {
  const fixture = makeSyntheticFixture('simple-icon');
  const session = await DecompositionSession.importSources([fixture.input]);
  try {
    await session.analyze();
    const first = await session.exportHyde({ format: 'hyproj', name: 'Initial icon' });
    const root = `hc_${session.snapshot().id}_root`;
    const part = session.snapshot().parts[0];
    expect((await session.execute({ expectedRevision: session.revision, edits: [
      { op: 'part.rename', partId: part.id, name: 'Revised part' },
    ] })).ok).toBe(true);
    expect(session.snapshot().exportMapping).toBeUndefined();
    const impact = await session.planAssemblyReplacement(first.bytes);
    expect(impact).toMatchObject({ targetName: 'Initial icon assembly', targetFingerprint: first.mapping.outputFingerprint,
      addedIds: [], removedIds: [] });
    expect(impact.replacedIds).toContain(root);
    expect(impact.replacedIds).toContain(first.mapping.partIds[part.id]);
    const unrelated = await DecompositionSession.importSources([makeSyntheticFixture('occlusion').input]);
    try {
      await unrelated.analyze();
      const otherAssembly = await unrelated.exportHyde({ format: 'hyproj' });
      await expect(session.planAssemblyReplacement(otherAssembly.bytes)).rejects.toThrow('TARGET_MISMATCH');
    } finally { await unrelated.close(); }
    const beforeFailure = session.snapshot();
    await expect(session.exportHyde({ format: 'hyproj', targetAssemblyBytes: first.bytes,
      expectedTargetFingerprint: impact.targetFingerprint })).rejects.toThrow('REPLACEMENT_REQUIRES_CONFIRMATION');
    await expect(session.exportHyde({ format: 'hyproj', targetAssemblyBytes: first.bytes,
      expectedTargetFingerprint: '0'.repeat(64), replaceExisting: true })).rejects.toThrow('TARGET_CHANGED');
    expect(session.snapshot()).toEqual(beforeFailure);
    const replacement = await session.exportHyde({ format: 'hyproj', name: 'Revised icon', targetAssemblyBytes: first.bytes,
      expectedTargetFingerprint: impact.targetFingerprint, replaceExisting: true });
    expect(replacement.replacementImpact).toEqual(impact);
    expect(replacement.mapping.partIds[part.id]).toBe(first.mapping.partIds[part.id]);
    expect(decodeAssemblyBytes(first.bytes).elements.find(item => item.id === first.mapping.partIds[part.id])?.name).not.toBe('Revised part');
    expect(decodeAssemblyBytes(replacement.bytes).elements.find(item => item.id === first.mapping.partIds[part.id])?.name).toBe('Revised part');
    const reopened = await DecompositionSession.openDocument(await session.saveDocument());
    expect(reopened.snapshot().exportMapping).toEqual(replacement.mapping);
    await reopened.close();
  } finally { await session.close(); }
});
