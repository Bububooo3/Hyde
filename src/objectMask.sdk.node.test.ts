// @vitest-environment node
import { expect, it } from 'vitest';
import { HydeSDK, HYDE_OPERATIONS } from './sdk';

it('authors and reopens a validated object mask through the public SDK', async () => {
  const sdk = new HydeSDK(), session = await sdk.createProject({ name: 'Mask SDK' });
  expect(HYDE_OPERATIONS).toContain('element.setObjectMask');
  const created = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
    { op: 'element.create', args: { id: 'target', kind: 'rectangle' } },
    { op: 'element.create', args: { id: 'source', kind: 'ellipse' } },
    { op: 'element.setObjectMask', args: { id: 'target', mode: 'include', objectIds: ['source'] } },
  ] });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const rejected = await session.execute({ protocolVersion: 1, expectedRevision: 1, commands: [
    { op: 'element.setObjectMask', args: { id: 'source', mode: 'exclude', objectIds: ['target'] } },
  ] });
  expect(rejected.ok).toBe(false);
  expect(session.snapshot().elements.find(element=>element.id==='source')?.objectMask).toBeUndefined();
  const reopened = await sdk.openProject(await session.exportProject());
  expect(reopened.snapshot().elements.find(element=>element.id==='target')?.objectMask).toEqual({mode:'include',objectIds:['source']});
});
