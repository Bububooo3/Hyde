// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HydeSDK, HYDE_EXECUTE_SCHEMA_V1 } from './sdk';

describe('public Node SDK', () => {
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
    expect(await reopened.diagnostics()).toEqual([]);
    await session.close();
    expect(() => session.snapshot()).toThrow('closed');
  });
});
