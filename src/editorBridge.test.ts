// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorBridge } from './editorBridge';
import { createProject } from './model';

describe('opt-in same-page editor bridge', () => {
  it('keeps read-only access read-only and rejects requests after revocation', async () => {
    let project = createProject(), revision = 0;
    const bridge = new EditorBridge(new Set(['read']), {
      project: () => project, revision: () => revision,
      commit: next => { project = next; revision++; }, select: () => {}, setPlayhead: () => {},
    });
    const envelope = { protocolVersion: 1 as const, sessionId: bridge.sessionId, requestId: 'one' };
    expect((await bridge.request({ ...envelope, operation: 'inspect', payload: { target: 'project' } })).ok).toBe(true);
    const denied = await bridge.request({ ...envelope, operation: 'execute', payload: { expectedRevision: 0, commands: [{ op: 'scene.rename', args: { id: project.sequences[0].id, name: 'No' } }] } });
    expect(denied.ok).toBe(false);
    expect(revision).toBe(0);
    bridge.revoke();
    expect((await bridge.request({ ...envelope, operation: 'inspect', payload: { target: 'project' } })).ok).toBe(false);
  });

  it('commits one SDK batch through the editor callback and checks GUI revisions', async () => {
    let project = createProject(), revision = 0, commits = 0;
    const bridge = new EditorBridge(new Set(['read', 'write']), {
      project: () => project, revision: () => revision,
      commit: next => { project = next; revision++; commits++; }, select: () => {}, setPlayhead: () => {},
    });
    const request = { protocolVersion: 1 as const, sessionId: bridge.sessionId, requestId: 'batch', operation: 'execute' as const, payload: { protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'element.create', args: { alias: '$a', kind: 'rectangle' } },
      { op: 'element.create', args: { alias: '$b', kind: 'ellipse' } },
    ] } };
    const applied = await bridge.request(request);
    expect(applied.ok).toBe(true);
    expect(commits).toBe(1);
    expect(revision).toBe(1);
    expect(project.elements).toHaveLength(2);
    expect((await bridge.request(request)).ok).toBe(false);
    expect(commits).toBe(1);
    bridge.revoke();
  });
});
