// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HydeSDK, HYDE_EXECUTE_SCHEMA_V1 } from './sdk';

describe('public Node SDK', () => {
  it('marks a crowded timeline inspection as truncated without embedding all captions', async () => {
    const session = await new HydeSDK().createProject({ duration: 8 });
    const made = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: Array.from({ length: 105 }, (_, index) => ({
      op: 'caption.create' as const, args: { id: `caption-${index}`, text: `Line ${index}`, start: 1, end: 2 },
    })) });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const timeline = await session.inspect({ target: 'timeline', timeStart: 0, timeEnd: 3, limit: 100 });
    expect(timeline.captions).toHaveLength(100);
    expect(timeline).toMatchObject({ visibleCaptionCount: 105, captionsTruncated: true, nextCaptionCursor: 100 });
    const next = await session.inspect({ target: 'timeline', timeStart: 0, timeEnd: 3, limit: 100, cursor: 100 });
    expect(next.captions).toHaveLength(5);
    expect(next).toMatchObject({ visibleCaptionCount: 105, captionsTruncated: false });
    expect((await session.inspect({ target: 'timeline', timeStart: 3, timeEnd: 4 })).visibleCaptionCount).toBe(0);
  });

  it('round-trips authored assembly clips, placed overrides and timeline inspection through the public facade', async () => {
    const sdk = new HydeSDK(), session = await sdk.createProject({ name: 'Clip interchange', duration: 8 });
    const made = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'element.create', args: { id: 'rig', kind: 'group', properties: { name: 'Rig', start: 0, duration: 8 } } },
      { op: 'element.create', args: { id: 'arm', kind: 'rectangle', properties: { name: 'Arm', parentId: 'rig', start: 0, duration: 8, x: 80 } } },
      { op: 'assembly.attach', args: { id: 'arm', parentId: 'rig', type: 'fixed' } },
      { op: 'keyframe.upsert', args: { elementId: 'arm', property: 'x', timeSeconds: 0, value: 80 } },
      { op: 'keyframe.upsert', args: { elementId: 'arm', property: 'x', timeSeconds: 2, value: 160 } },
      { op: 'clip.capture', args: { rootId: 'rig', sourceStart: 0, duration: 2, name: 'Reach', alias: '$reach' } },
      { op: 'clip.place', args: { rootId: 'rig', clipId: '$reach', at: 1, alias: '$first' } },
      { op: 'clip.place', args: { rootId: 'rig', clipId: '$reach', at: 4, alias: '$second' } },
      { op: 'clip.setGapTransition', args: { rootId: 'rig', instanceId: '$second', elementId: 'arm', property: 'x', transition: { mode: 'hold' } } },
      { op: 'clip.setPriority', args: { rootId: 'rig', instanceId: '$second', elementId: 'arm', property: 'x', priority: 3 } },
      { op: 'clip.editPlacedKey', args: { rootId: 'rig', clipId: '$reach', instanceId: '$second', elementId: 'arm', property: 'x', action: 'add', timeSeconds: 1, alias: '$override' } },
    ] });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    if (!made.ok) return;
    const timeline = await session.inspect({ target: 'timeline', timeStart: 0, timeEnd: 8 });
    expect(timeline.items?.find(item => item.id === 'rig')).toMatchObject({
      assemblyClips: [{ id: made.idMap.$reach, name: 'Reach', duration: 2 }],
      clipInstances: [{ id: made.idMap.$first }, { id: made.idMap.$second }],
    });
    expect((await session.inspect({ target: 'timeline', timeStart: 3.5, timeEnd: 6.5 })).items?.find(item => item.id === 'rig')).toMatchObject({
      clipInstances: [{ id: made.idMap.$second, timelineStart: 4, overrideCount: 1, gapTransitionCount: 1, priorityOverrideCount: 1 }],
      visibleClipInstanceCount: 1, clipInstancesTruncated: false,
    });
    const sceneId = session.snapshot().sequences[0].id;
    const firstPage = await session.inspect({ target: 'scene', id: sceneId, limit: 1 });
    expect(firstPage).toMatchObject({ elementCount: 2, nextCursor: 1, elements: [{ id: 'arm', trackCount: 1 }] });
    expect(firstPage.elements?.[0]).not.toHaveProperty('tracks');
    const secondPage = await session.inspect({ target: 'scene', id: sceneId, limit: 1, cursor: 1 });
    expect(secondPage).toMatchObject({ elementCount: 2, elements: [{ id: 'rig', clipCount: 1, instanceCount: 2 }] });
    expect(secondPage.elements?.[0]).not.toHaveProperty('assemblyClips');
    expect((await session.inspect({ target: 'element', id: 'rig' })).element).toHaveProperty('assemblyClips');
    const before = await session.evaluate(5);
    const reopened = await sdk.openProject(await session.exportProject());
    expect(reopened.snapshot()).toEqual(session.snapshot());
    expect(await reopened.evaluate(5)).toEqual(before);
    expect((await reopened.inspect({ target: 'assembly', id: 'rig' })).items?.[0]).toMatchObject({
      id: 'rig', children: [{ id: 'arm', attachment: { type: 'fixed', parentId: 'rig' } }],
    });
    const placed = reopened.snapshot().elements.find(item => item.id === 'rig')!.clipInstances![1];
    expect(placed.gapTransitions?.[0]).toMatchObject({ mode: 'hold' });
    expect(placed.priorityOverrides?.[0]).toMatchObject({ priority: 3 });
    expect(placed.trackOverrides?.[0].keyframes.some(key => key.id === made.idMap.$override)).toBe(true);
    const invalid = await reopened.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'clip.rename', args: { rootId: 'rig', clipId: made.idMap.$reach, name: 'Changed temporarily' } },
      { op: 'clip.retime', args: { rootId: 'rig', instanceId: made.idMap.$second, duration: -1 } },
    ] });
    expect(invalid.ok).toBe(false);
    expect(reopened.revision).toBe(0);
    expect(reopened.snapshot()).toEqual(session.snapshot());
  });

  it('keeps differing source durations separate when importing byte-identical assembly media', async () => {
    const sdk = new HydeSDK();
    const videoBytes = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
    const source = await sdk.createProject({ duration: 8 });
    const sourceHandle = source.stageAsset(videoBytes, 'video/mp4', 'video');
    const made = await source.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'asset.add', args: { id: 'shared_video', handle: sourceHandle, name: 'Long source', duration: 10 } },
      { op: 'element.create', args: { id: 'movie', kind: 'video', properties: { assetId: 'shared_video', duration: 7 } } },
      { op: 'video.setSourceTiming', args: { id: 'movie', inTime: 1, outTime: 8 } },
    ] });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const assembly = await source.exportAssembly('movie');
    const recipient = await sdk.createProject({ duration: 8 });
    const recipientHandle = recipient.stageAsset(videoBytes, 'video/mp4', 'video');
    const existing = await recipient.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'asset.add', args: { id: 'shared_video', handle: recipientHandle, name: 'Short source', duration: 6 } },
      { op: 'element.create', args: { id: 'movie', kind: 'ellipse', properties: { name: 'Existing object' } } },
    ] });
    expect(existing.ok, JSON.stringify(existing)).toBe(true);
    const importHandle = recipient.stageAssembly(assembly);
    const imported = await recipient.execute({ protocolVersion: 1, expectedRevision: 1, commands: [
      { op: 'assembly.import', args: { handle: importHandle, timeSeconds: 0, alias: '$imported' } },
    ] });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    if (imported.ok) {
      const reopened = await sdk.openProject(await recipient.exportProject());
      const project = reopened.snapshot(), importedMovie = project.elements.find(item => item.id === imported.idMap.$imported)!;
      expect(importedMovie.id).not.toBe('movie');
      expect(importedMovie.assetId).not.toBe('shared_video');
      expect(project.assets.map(item => item.duration).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([6, 10]);
      expect(project.assets.find(item => item.id === importedMovie.assetId)?.duration).toBe(10);
      expect(importedMovie).toMatchObject({ kind: 'video', sourceOffset: 1, duration: 7 });
      expect(project.elements.find(item => item.id === 'movie')?.name).toBe('Existing object');
      await reopened.close();
      const sameHandle = recipient.stageAssembly(assembly);
      const again = await recipient.execute({ protocolVersion: 1, expectedRevision: 2, commands: [
        { op: 'assembly.import', args: { handle: sameHandle, timeSeconds: 0, alias: '$again' } },
      ] });
      expect(again.ok, JSON.stringify(again)).toBe(true);
      if (again.ok) {
        expect(recipient.snapshot().assets).toHaveLength(2);
        expect(recipient.snapshot().elements.find(item => item.id === again.idMap.$again)?.assetId).toBe(importedMovie.assetId);
      }
    }
    await source.close(); await recipient.close();
  });

  it('identifies a missing media duration before source timing changes', async () => {
    const session = await new HydeSDK().createProject();
    const bytes = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
    const handle = session.stageAsset(bytes, 'video/mp4', 'video');
    const created = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'asset.add', args: { alias: '$asset', handle, name: 'unmeasured.mp4' } },
      { op: 'element.create', args: { alias: '$movie', kind: 'video', properties: { assetId: '$asset' } } },
    ] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = session.snapshot();
    const timing = await session.execute({ protocolVersion: 1, expectedRevision: 1, commands: [
      { op: 'video.setSourceTiming', args: { id: created.idMap.$movie, inTime: 0, outTime: 2 } },
    ] });
    expect(timing.ok).toBe(false);
    if (!timing.ok) expect(timing.errors[0]).toMatchObject({ code: 'INVALID_ASSET', field: 'assetId', targetId: created.idMap.$movie });
    expect(session.snapshot()).toEqual(before);
    expect(session.revision).toBe(1);
    await session.close();
  });

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
    expect(await reopened.inspect({ target: 'asset', id: assetId, fields: ['id', 'kind', 'duration'] })).toMatchObject({
      asset: { id: assetId, kind: 'video', duration: 10 },
    });
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
    expect(await session.inspect({ target: 'environment', fields: ['environment', 'preview', 'pendingJobCount'] })).toMatchObject({
      environment: { environment: 'node', preview: { frames: false }, pendingJobCount: 0 },
    });
    expect(await session.inspect({ target: 'jobs' })).toMatchObject({ items: [] });
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
