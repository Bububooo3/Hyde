// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { makeSDKAcceptanceStory } from '../tests/sdkAcceptanceFixture';
import { HydeSDK } from './sdk';
import { decodeProjectBytes, encodeProjectBytes } from './archive';
import { createPrimaryShowcase } from './showcase';

describe('public SDK acceptance story', () => {
  it('round-trips arrangement, folders, cloning and scene ripple through native Hyde', async () => {
    const sdk = new HydeSDK(), session = await sdk.createProject({ name: 'Arranged parts', duration: 10 });
    const firstSceneId = session.snapshot().sequences[0].id;
    const result = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'element.create', args: { alias: '$left', kind: 'rectangle', properties: { name: 'Left', x: 20, y: 30, width: 20, height: 20, duration: 10 } } },
      { op: 'element.create', args: { alias: '$middle', kind: 'rectangle', properties: { name: 'Middle', x: 80, y: 70, width: 20, height: 20, duration: 10 } } },
      { op: 'element.create', args: { alias: '$right', kind: 'rectangle', properties: { name: 'Right', x: 200, y: 110, width: 20, height: 20, duration: 10 } } },
      { op: 'folder.create', args: { alias: '$folder', name: 'Character parts' } },
      { op: 'folder.assign', args: { folderId: '$folder', elementIds: ['$left', '$middle', '$right'] } },
      { op: 'element.align', args: { ids: ['$left', '$middle', '$right'], mode: 'top', timeSeconds: 0 } },
      { op: 'element.distribute', args: { ids: ['$left', '$middle', '$right'], mode: 'distributeX', timeSeconds: 0 } },
      { op: 'element.clone', args: { id: '$left', alias: '$copy' } },
      { op: 'element.reorder', args: { id: '$copy', beforeId: '$middle' } },
      { op: 'scene.create', args: { alias: '$outro', name: 'Outro', start: 10, duration: 5 } },
      { op: 'scene.ripple', args: { id: firstSceneId, deltaSeconds: 2 } },
    ] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const reopened = await sdk.openProject(await session.exportProject());
    const project = reopened.snapshot(), ids = result.idMap;
    expect(project.folders?.find(folder => folder.id === ids.$folder)?.name).toBe('Character parts');
    expect([ids.$left, ids.$middle, ids.$right].map(id => project.elements.find(item => item.id === id)?.folderId)).toEqual([ids.$folder, ids.$folder, ids.$folder]);
    expect(project.elements.find(item => item.id === ids.$copy)?.folderId).toBe(ids.$folder);
    expect(project.elements.findIndex(item => item.id === ids.$copy)).toBeLessThan(project.elements.findIndex(item => item.id === ids.$middle));
    const arranged = (await reopened.evaluate(0)).elements.filter(item => [ids.$left, ids.$middle, ids.$right].includes(item.id));
    expect(new Set(arranged.map(item => item.y)).size).toBe(1);
    const x = (id: string) => arranged.find(item => item.id === id)!.x;
    expect(x(ids.$middle)).toBeCloseTo((x(ids.$left) + x(ids.$right)) / 2);
    expect(project.sequences.find(scene => scene.id === firstSceneId)?.duration).toBe(12);
    expect(project.sequences.find(scene => scene.id === ids.$outro)?.start).toBe(12);
    expect(await reopened.diagnostics()).toEqual([]);
    expect(session.undo(session.revision)).toBe(true);
    expect(session.snapshot().elements).toHaveLength(0);
    expect(session.redo(session.revision)).toBe(true);
    expect(session.snapshot().elements).toHaveLength(4);
    await reopened.close(); await session.close();
  });

  it('remaps a native assembly with clips, attachment limits and audio across existing ID collisions', async () => {
    const { sdk, session, ids } = await makeSDKAcceptanceStory();
    const expanded = await session.execute({ protocolVersion: 1, expectedRevision: session.revision, commands: [
      { op: 'assembly.attach', args: { id: ids.$audio, parentId: ids.$assembly, type: 'fixed' } },
      { op: 'clip.capture', args: { rootId: ids.$assembly, sourceStart: 0, duration: 2, name: 'Beam turn', alias: '$turn' } },
      { op: 'clip.place', args: { rootId: ids.$assembly, clipId: '$turn', at: 0.5, alias: '$placed' } },
      { op: 'clip.setPriority', args: { rootId: ids.$assembly, instanceId: '$placed', elementId: ids.$beam, property: 'rotation', priority: 2 } },
    ] });
    expect(expanded.ok, JSON.stringify(expanded)).toBe(true);
    if (!expanded.ok) return;
    const assembly = await session.exportAssembly(ids.$assembly);
    const sourceAsset = session.snapshot().assets.find(asset => asset.id === ids.$tone)!;
    const conflictingBytes = Uint8Array.from(Buffer.from(sourceAsset.dataUrl.split(',')[1], 'base64'));
    conflictingBytes[conflictingBytes.length - 1] ^= 1;
    const recipient = await sdk.createProject({ name: 'Collision recipient', duration: 6 });
    const handle = recipient.stageAsset(conflictingBytes, 'audio/wav', 'audio');
    const existing = await recipient.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'asset.add', args: { id: ids.$tone, handle, name: 'Existing other tone' } },
      { op: 'element.create', args: { id: ids.$assembly, kind: 'ellipse', properties: { name: 'Existing root ID' } } },
      { op: 'element.create', args: { id: ids.$beam, kind: 'ellipse', properties: { name: 'Existing beam ID' } } },
    ] });
    expect(existing.ok, JSON.stringify(existing)).toBe(true);
    const imported = await recipient.execute({ protocolVersion: 1, expectedRevision: recipient.revision, commands: [
      { op: 'assembly.import', args: { handle: recipient.stageAssembly(assembly), timeSeconds: 0, alias: '$copy' } },
    ] });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    if (!imported.ok) return;
    const reopened = await sdk.openProject(await recipient.exportProject());
    const project = reopened.snapshot(), root = project.elements.find(item => item.id === imported.idMap.$copy)!;
    const beam = project.elements.find(item => item.name === 'Hinged beam')!, audio = project.elements.find(item => item.name === 'Ambient tone')!;
    expect(root.id).not.toBe(ids.$assembly);
    expect(beam.id).not.toBe(ids.$beam);
    expect(beam.parentId).toBe(root.id);
    expect(beam.attachment).toMatchObject({ type: 'hinge', parentId: root.id, min: -25, max: 25 });
    expect(audio.parentId).toBe(root.id);
    expect(audio.assetId).not.toBe(ids.$tone);
    expect(project.assets).toHaveLength(3);
    expect(project.assets.find(asset => asset.id === audio.assetId)?.dataUrl).toBe(sourceAsset.dataUrl);
    expect(project.assets.find(asset => asset.id === ids.$tone)?.dataUrl).not.toBe(sourceAsset.dataUrl);
    const clip = root.assemblyClips![0], placed = root.clipInstances![0];
    expect(clip.id).not.toBe(expanded.idMap.$turn);
    expect(placed.id).not.toBe(expanded.idMap.$placed);
    expect(placed.clipId).toBe(clip.id);
    expect(clip.tracks.some(track => track.elementId === beam.id)).toBe(true);
    const sourceClip = session.snapshot().elements.find(item => item.id === ids.$assembly)!.assemblyClips![0];
    expect(clip.tracks.flatMap(track => track.keyframes.map(key => key.id))).not.toEqual(sourceClip.tracks.flatMap(track => track.keyframes.map(key => key.id)));
    expect(placed.priorityOverrides?.[0]).toMatchObject({ elementId: beam.id, property: 'rotation', priority: 2 });
    expect(project.elements.find(item => item.id === ids.$assembly)?.name).toBe('Existing root ID');
    expect(await reopened.diagnostics()).toEqual([]);
    await reopened.close(); await recipient.close(); await session.close();
  });

  it('opens the current Story Studio showcase and preserves unrelated native content after a focused SDK edit', async () => {
    const original = decodeProjectBytes(encodeProjectBytes(createPrimaryShowcase())), sdk = new HydeSDK();
    const session = await sdk.openProject(encodeProjectBytes(original));
    expect(session.snapshot()).toEqual(original);
    const flight = original.sequences.find(scene => scene.name !== original.sequences[0].name)!;
    const flightElements = original.elements.filter(item => item.sceneId === flight.id);
    const beforeAtFlight = await session.evaluate(flight.start + 1);
    const edited = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'element.updateAppearance', args: { id: 'desk-map', appearance: { opacity: .9 } } },
    ] });
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    const reopened = await sdk.openProject(await session.exportProject());
    const after = reopened.snapshot();
    expect(after.elements.find(item => item.id === 'desk-map')?.opacity).toBe(.9);
    expect(after.elements.filter(item => item.sceneId === flight.id)).toEqual(flightElements);
    expect(after.sequences).toEqual(original.sequences);
    expect(after.assets).toEqual(original.assets);
    expect(after.captions).toEqual(original.captions);
    expect(await reopened.evaluate(flight.start + 1)).toEqual(beforeAtFlight);
    expect(after.elements.map(item => item.id)).toEqual(original.elements.map(item => item.id));
    await session.close(); await reopened.close();
  });

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
