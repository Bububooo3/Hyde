// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { makeSDKAcceptanceStory } from '../tests/sdkAcceptanceFixture';

describe('public SDK acceptance story', () => {
  it('authors and reopens editable multi-scene media, text, camera, caption and assembly content', async () => {
    const { sdk, session, sceneIds, ids, bytes } = await makeSDKAcceptanceStory();
    expect(session.revision).toBe(1);
    expect(session.capabilities()).toMatchObject({ environment: 'node', preview: { frames: false }, exports: ['hyde', 'hy', 'hyproj'] });
    expect(await session.diagnostics()).toEqual([]);

    const reopened = await sdk.openProject(bytes);
    const original = session.snapshot(), restored = reopened.snapshot();
    expect(restored).toEqual(original);
    expect(restored.sequences.map(scene => [scene.id, scene.start, scene.duration])).toEqual([[sceneIds[0], 0, 3], [sceneIds[1], 3, 3]]);
    expect(restored.assets.map(asset => [asset.id, asset.kind, asset.mime])).toEqual([
      [ids.$texture, 'image', 'image/png'], [ids.$tone, 'audio', 'audio/wav'],
    ]);
    const island = restored.elements.find(item => item.id === ids.$island)!;
    const beam = restored.elements.find(item => item.id === ids.$beam)!;
    const title = restored.elements.find(item => item.id === ids.$title)!;
    const audio = restored.elements.find(item => item.id === ids.$audio)!;
    expect(island).toMatchObject({ kind: 'polygon', assetId: ids.$texture, parentId: ids.$assembly, attachment: { type: 'fixed', parentId: ids.$assembly } });
    expect(island.shapePath?.points).toHaveLength(6);
    expect(beam.attachment).toEqual({ type: 'hinge', parentId: ids.$assembly, min: -25, max: 25 });
    expect(beam.tracks.find(track => track.property === 'rotation')?.keyframes).toHaveLength(2);
    expect(title).toMatchObject({ flowAroundId: ids.$island, textShapeMode: 'clip', textAnimation: { effect: 'reveal' } });
    expect(title.tracks.find(track => track.property === 'x')?.keyframes).toHaveLength(2);
    expect(audio).toMatchObject({ assetId: ids.$tone, volume: 0.35, fadeIn: 0.2, fadeOut: 0.2 });
    expect(restored.sequences[0].camera?.tracks.find(track => track.property === 'zoom')?.keyframes[0].value).toBe(1.12);
    expect(restored.captions.map(caption => caption.text)).toEqual(['The island awakens.', 'Night settles in.']);
    expect((await reopened.inspect({ target: 'assets' })).items).toHaveLength(2);
    expect(JSON.stringify(await reopened.inspect({ target: 'assets' }))).not.toContain('dataUrl');
    expect((await reopened.inspect({ target: 'timeline', sceneId: sceneIds[0], timeStart: 0, timeEnd: 3 })).captions).toHaveLength(1);
    expect((await reopened.evaluate(1.5)).elements.some(item => item.id === ids.$title)).toBe(true);
    expect((await reopened.evaluate(4.5)).elements.some(item => item.id === ids.$moon)).toBe(true);

    const assemblyBytes = await reopened.exportAssembly(ids.$assembly);
    const assembly = await sdk.openAssembly(assemblyBytes);
    const inspect = assembly.inspect();
    expect(inspect.elements.map(item => item.name)).toEqual(expect.arrayContaining(['Lantern assembly', 'Textured island', 'Hinged beam']));
    expect(inspect.assets).toMatchObject([{ id: ids.$texture, kind: 'image', mime: 'image/png' }]);
    expect(JSON.stringify(inspect)).not.toContain('dataUrl');
    expect((await sdk.openAssembly(assembly.exportBytes())).inspect()).toEqual(inspect);

    const recipient = await sdk.createProject({ name: 'Assembly recipient', width: 640, height: 360 });
    const handle = recipient.stageAssembly(assemblyBytes);
    const imported = await recipient.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'assembly.import', args: { handle, timeSeconds: 1, alias: '$imported' } },
    ] });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    if (imported.ok) {
      const copy = recipient.snapshot();
      expect(copy.elements.find(item => item.id === imported.idMap.$imported)?.name).toBe('Lantern assembly');
      expect(copy.elements.some(item => item.id === ids.$assembly)).toBe(false);
      expect(copy.assets).toHaveLength(1);
      expect(copy.elements.find(item => item.name === 'Textured island')?.assetId).toBe(copy.assets[0].id);
      expect((await sdk.openProject(await recipient.exportProject())).snapshot()).toEqual(copy);
    }
    await recipient.close();
    await reopened.close();
    await session.close();
  });

  it('revises one target scene and exposes a concise revision diff without disturbing the other scene', async () => {
    const { session, sceneIds, ids } = await makeSDKAcceptanceStory();
    const before = session.snapshot();
    const secondBefore = before.elements.find(item => item.id === ids.$moon)!;
    const changed = await session.execute({ protocolVersion: 1, expectedRevision: 1, commands: [
      { op: 'element.setTransform', args: { id: ids.$moon, transform: { x: secondBefore.x + 30 } } },
      { op: 'scene.setCamera', args: { sceneId: sceneIds[1], camera: { zoom: 1.2 } } },
    ] });
    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    if (changed.ok) {
      expect(changed.changes).toMatchObject({ added: [], removed: [], changed: expect.arrayContaining([`element:${ids.$moon}`, `scene:${sceneIds[1]}`]) });
      expect(changed.changes.changed).toHaveLength(2);
    }
    const after = session.snapshot();
    expect(after.elements.filter(item => item.sceneId === sceneIds[0])).toEqual(before.elements.filter(item => item.sceneId === sceneIds[0]));
    expect(after.sequences.find(item => item.id === sceneIds[0])).toEqual(before.sequences.find(item => item.id === sceneIds[0]));
    expect(after.assets).toEqual(before.assets);
    expect(after.captions).toEqual(before.captions);
    expect((await session.inspect({ target: 'changes', sinceRevision: 1 })).changes).toHaveLength(1);
    await session.close();
  });
});
