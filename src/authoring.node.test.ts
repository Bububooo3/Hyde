// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HydeAuthoringSession } from './authoring';
import { decodeProjectBytes } from './archive';

describe('authoring transactions in Node', () => {
  it('creates editable native content through aliases and round-trips its archive', async () => {
    const session = HydeAuthoringSession.create('Authored in Node');
    const imageBytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64'));
    const image = session.stageAsset(imageBytes, 'image/png', 'image');
    const commands = [
      { op: 'scene.create', args: { alias: '$second', name: 'Second', start: 8, duration: 4 } },
      { op: 'asset.add', args: { alias: '$image', handle: image, name: 'dot.png' } },
      { op: 'element.create', args: { alias: '$body', kind: 'rectangle', sceneId: '$second', properties: { name: 'Body', x: 100, y: 110, assetId: '$image', start: 8, duration: 4 } } },
      { op: 'element.create', args: { alias: '$head', kind: 'ellipse', sceneId: '$second', properties: { name: 'Head', x: 20, y: 0, start: 8, duration: 4 } } },
      { op: 'assembly.attach', args: { id: '$head', parentId: '$body', type: 'hinge', min: -30, max: 30 } },
      { op: 'keyframe.upsert', args: { elementId: '$body', property: 'rotation', timeSeconds: 0, value: 10 } },
      { op: 'caption.create', args: { sceneId: '$second', text: 'Hello', start: 8, end: 10 } },
    ] as const;
    const preview = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: commands as never, dryRun: true });
    expect(preview.ok).toBe(true);
    expect(session.revision).toBe(0);
    const result = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: commands as never });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(session.revision).toBe(1);
    const archive = session.exportProject();
    const reopened = decodeProjectBytes(archive);
    expect(reopened.elements.find(item => item.id === result.idMap.$head)?.attachment).toEqual({ type: 'hinge', parentId: result.idMap.$body, min: -30, max: 30 });
    expect(reopened.elements.find(item => item.id === result.idMap.$body)?.assetId).toBe(result.idMap.$image);
    expect(reopened.assets).toHaveLength(1);
    expect(reopened.captions).toHaveLength(1);
    expect(HydeAuthoringSession.open(archive).snapshot()).toEqual(reopened);
    expect(session.inspect({ target: 'assets' })).not.toHaveProperty('dataUrl');
  });

  it('rolls back invalid batches, checks revisions, and undoes one whole batch', async () => {
    const session = HydeAuthoringSession.create();
    const before = session.snapshot();
    const failed = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'element.create', args: { alias: '$a', kind: 'rectangle' } },
      { op: 'element.create', args: { alias: '$b', kind: 'ellipse' } },
      { op: 'assembly.attach', args: { id: '$a', parentId: '$b', type: 'fixed' } },
      { op: 'assembly.attach', args: { id: '$b', parentId: '$a', type: 'fixed' } },
    ] });
    expect(failed.ok).toBe(false);
    expect(session.snapshot()).toEqual(before);
    expect(session.revision).toBe(0);
    const valid = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'element.create', args: { alias: '$a', kind: 'rectangle' } },
      { op: 'element.create', args: { alias: '$b', kind: 'ellipse' } },
    ] });
    expect(valid.ok).toBe(true);
    expect(session.snapshot().elements).toHaveLength(2);
    expect((await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: [{ op: 'scene.rename', args: { id: before.sequences[0].id, name: 'stale' } }] })).ok).toBe(false);
    expect(session.undo(1)).toBe(true);
    expect(session.snapshot()).toEqual(before);
    expect(session.redo(2)).toBe(true);
    expect(session.snapshot().elements).toHaveLength(2);
  });

  it('commits timeline and media commands with native geometry in one revision', async () => {
    const session = HydeAuthoringSession.create('Adapter integration');
    const image = session.stageAsset(Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64')), 'image/png', 'image');
    const result = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'asset.add', args: { alias: '$image', handle: image, name: 'dot.png' } },
      { op: 'element.create', args: { alias: '$body', kind: 'rectangle', properties: { width: 80, height: 60, assetId: '$image' } } },
      { op: 'shape.setPrimitive', args: { id: '$body', kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 40, y: 60 }] } },
      { op: 'media.setOpacity', args: { id: '$body', opacity: 0.5 } },
      { op: 'keyframe.upsert', args: { elementId: '$body', property: 'rotation', timeSeconds: 1, value: 30, alias: '$turn' } },
      { op: 'motion.add', args: { elementId: '$body', behavior: { type: 'oscillation', settings: { property: 'rotation', amplitude: 5, frequency: 1 } }, alias: '$motion' } },
    ] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.idMap.$body).toBeTruthy();
    expect(result.idMap.$turn).toBeTruthy();
    expect(result.idMap.$motion).toBeTruthy();
    const reopened = decodeProjectBytes(session.exportProject());
    const body = reopened.elements.find(item => item.id === result.idMap.$body);
    expect(body?.kind).toBe('polygon');
    expect(body?.points).toHaveLength(3);
    expect(body?.mediaOpacity).toBe(0.5);
    expect(body?.tracks.find(track => track.property === 'rotation')?.keyframes[0]?.id).toBe(result.idMap.$turn);
    expect(body?.motionBehaviors?.[0]?.id).toBe(result.idMap.$motion);
    expect(session.revision).toBe(1);
    expect(session.undo(1)).toBe(true);
    expect(session.snapshot().elements).toHaveLength(0);
  });

  it('stages and imports a native assembly without leaking its source IDs', async () => {
    const source = HydeAuthoringSession.create('Source');
    const made = await source.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'element.create', args: { alias: '$root', kind: 'group', properties: { name: 'Mover' } } },
      { op: 'element.create', args: { alias: '$child', kind: 'ellipse', properties: { name: 'Part', parentId: '$root' } } },
    ] });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const archive = source.exportAssembly(made.idMap.$root);
    const target = HydeAuthoringSession.create('Target');
    const handle = target.stageAssembly(archive);
    const imported = await target.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'assembly.import', args: { handle, timeSeconds: 1, alias: '$imported' } },
    ] });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    if (!imported.ok) return;
    const reopened = HydeAuthoringSession.open(target.exportProject()).snapshot();
    expect(reopened.elements).toHaveLength(2);
    expect(reopened.elements.some(item => item.id === made.idMap.$root)).toBe(false);
    expect(reopened.elements.find(item => item.id === imported.idMap.$imported)?.name).toBe('Mover');
    expect(reopened.elements.find(item => item.name === 'Part')?.parentId).toBe(imported.idMap.$imported);
  });
});
