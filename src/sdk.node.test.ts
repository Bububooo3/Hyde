// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HydeSDK, HYDE_EXECUTE_SCHEMA_V1 } from './sdk';

describe('public Node SDK', () => {
  it('keeps declared media source duration and editable video timing through the public archive path', async () => {
    const sdk = new HydeSDK(), session = await sdk.createProject({ name: 'Video structure', duration: 8 });
    // Header-only bytes exercise structural authoring and archives, not codec playback.
    const videoBytes = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
    const handle = session.stageAsset(videoBytes, 'video/mp4', 'video');
    const committed = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'asset.add', args: { alias: '$videoAsset', handle, name: 'sample.mp4', duration: 10 } },
      { op: 'element.create', args: { alias: '$movie', kind: 'video', properties: { assetId: '$videoAsset', duration: 8, width: 320, height: 180 } } },
      { op: 'video.setSourceTiming', args: { id: '$movie', inTime: 1, outTime: 7, speed: 2, endBehavior: 'hide' } },
      { op: 'video.setAudioMix', args: { id: '$movie', volume: .4, muted: false, fadeIn: .25, fadeOut: .25,
        pitchSemitones: 2, linkSpeedPitch: false, effects: [{ id: 'video-echo', type: 'echo', enabled: true, delay: .25, feedback: .3, mix: .4 }] } },
    ] });
    expect(committed.ok, JSON.stringify(committed)).toBe(true);
    if (!committed.ok) return;
    const movieId = committed.idMap.$movie, assetId = committed.idMap.$videoAsset;
    const reopened = await sdk.openProject(await session.exportProject());
    expect(reopened.snapshot().assets.find(item => item.id === assetId)?.duration).toBe(10);
    expect(reopened.snapshot().elements.find(item => item.id === movieId)).toMatchObject({
      kind: 'video', assetId, duration: 3, sourceOffset: 1, speed: 2, videoEndBehavior: 'hide',
      volume: .4, fadeIn: .25, fadeOut: .25, pitchSemitones: 2, linkSpeedPitch: false,
      audioEffects: [{ id: 'video-echo', type: 'echo', enabled: true }],
    });
    const replacement = reopened.stageAsset(Uint8Array.from([...videoBytes.slice(0, 12), 1, 0, 0, 0]), 'video/mp4', 'video');
    const before = reopened.snapshot();
    const withoutDuration = await reopened.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'asset.replace', args: { id: assetId, handle: replacement } },
    ] });
    expect(withoutDuration.ok).toBe(false);
    if (!withoutDuration.ok) expect(withoutDuration.errors[0]).toMatchObject({ field: 'duration', targetId: assetId });
    expect(reopened.snapshot()).toEqual(before);
    const replaced = await reopened.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'asset.replace', args: { id: assetId, handle: replacement, duration: 12 } },
      { op: 'video.setSourceTiming', args: { id: movieId, inTime: 2, outTime: 10, speed: 2 } },
    ] });
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
    expect((await sdk.openProject(await reopened.exportProject())).snapshot().assets.find(item => item.id === assetId)?.duration).toBe(12);
    expect(reopened.snapshot().elements.find(item => item.id === movieId)).toMatchObject({ sourceOffset: 2, duration: 4 });
    await session.close(); await reopened.close();
  });

  it('creates, edits, inspects, evaluates, and reopens a native Hyde archive', async () => {
    const sdk = new HydeSDK();
    expect(HYDE_EXECUTE_SCHEMA_V1.properties.commands.items.oneOf.length).toBeGreaterThan(80);
    const session = await sdk.createProject({ name: 'Native SDK', width: 640, height: 480, duration: 4 });
    const scene = session.snapshot().sequences[0].id;
    const committed = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'element.create', args: { alias: '$piece', kind: 'ellipse', sceneId: scene, properties: { x: 30, y: 40, start: 0, duration: 4 } } },
      { op: 'keyframe.upsert', args: { elementId: '$piece', property: 'x', timeSeconds: 2, value: 100 } },
    ] });
    expect(committed.ok).toBe(true);
    const inspected = await session.inspect({ target: 'project' });
    expect(inspected).toMatchObject({ revision: 1, project: { name: 'Native SDK', width: 640, elementCount: 1 } });
    const tree = await session.inspect({ target: 'tree', sceneId: scene, depth: 2 });
    expect(tree).toMatchObject({ items: [{ name: 'Ellipse', childCount: 0 }] });
    const timeline = await session.inspect({ target: 'timeline', sceneId: scene, timeStart: 0, timeEnd: 4 });
    expect(timeline).toMatchObject({ items: [{ tracks: [{ property: 'x', keyframes: [{ value: 100 }] }] }] });
    const evaluated = await session.evaluate(2);
    expect(evaluated.elements).toHaveLength(1);
    expect(evaluated.camera).toBeDefined();
    const bytes = await session.exportProject();
    const reopened = await sdk.openProject(bytes);
    expect(reopened.snapshot()).toEqual(session.snapshot());
    const savedDigest = await session.contentDigest();
    expect(savedDigest).toMatchObject({ algorithm: 'SHA-256', digestVersion: 1, archiveType: 'hyde', archiveVersion: 1 });
    expect(savedDigest.hex).toMatch(/^[0-9a-f]{64}$/);
    expect(await reopened.contentDigest()).toEqual(savedDigest);
    const renamed = await reopened.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'scene.rename', args: { id: scene, name: 'Changed after reopen' } },
    ] });
    expect(renamed.ok).toBe(true);
    expect((await reopened.contentDigest()).hex).not.toBe(savedDigest.hex);
    expect(reopened.undo(1)).toBe(true);
    expect(await reopened.contentDigest()).toEqual(savedDigest);
    expect(await reopened.diagnostics()).toEqual([]);
    await session.close();
    expect(() => session.snapshot()).toThrow('closed');
  });

  it('reports the same assembly content digest after a native assembly round trip', async () => {
    const sdk = new HydeSDK();
    const session = await sdk.createProject();
    const result = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'element.create', args: { alias: '$root', kind: 'group' } },
      { op: 'element.create', args: { kind: 'ellipse', properties: { parentId: '$root' } } },
    ] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bytes = await session.exportAssembly(result.idMap.$root);
    const first = await sdk.openAssembly(bytes);
    const second = await sdk.openAssembly(first.exportBytes());
    expect(await first.contentDigest()).toMatchObject({ algorithm: 'SHA-256', digestVersion: 1, archiveType: 'hyde-assembly', archiveVersion: 1 });
    expect(await second.contentDigest()).toEqual(await first.contentDigest());
  });
});
