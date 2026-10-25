// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportMedia } from './mediaExport';
import { createProject } from './model';
import { EditorBridge } from './editorBridge';

vi.mock('./mediaExport', () => ({ exportMedia: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

function bridge() {
  const project = createProject('Bridge jobs');
  return new EditorBridge(new Set(['read', 'preview', 'export']), {
    project: () => project, revision: () => 0, commit: () => undefined,
    select: () => undefined, setPlayhead: () => undefined,
  });
}
function request(owner: EditorBridge, operation: Parameters<EditorBridge['request']>[0]['operation'], payload?: unknown) {
  return owner.request({ protocolVersion: 1, sessionId: owner.sessionId, requestId: crypto.randomUUID(), operation, payload });
}

describe('live editor export job bounds', () => {
  it('exposes bounded environment inspection without opening a renderer for a read-only grant', async () => {
    const project = createProject('Read only');
    const owner = new EditorBridge(new Set(['read']), {
      project: () => project, revision: () => 7, commit: () => undefined,
      select: () => undefined, setPlayhead: () => undefined,
    });
    expect(await request(owner, 'inspect', { target: 'environment', fields: ['environment', 'preview', 'scopes', 'pendingJobCount'] })).toMatchObject({
      ok: true, revision: 7, result: { revision: 7, environment: { environment: 'live-editor', preview: { frames: false }, scopes: ['read'], pendingJobCount: 0 } },
    });
    expect(await request(owner, 'inspect', { target: 'jobs' })).toMatchObject({ ok: true, result: { revision: 7, items: [] } });
    owner.revoke();
  });

  it('rejects concurrent expensive work and cancels the pending export', async () => {
    vi.mocked(exportMedia).mockImplementation((_project, _settings, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('Canceled.')), { once: true });
    }));
    const owner = bridge();
    const started = await request(owner, 'startExport', { format: 'gif' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = (started.result as { jobId: string }).jobId;
    expect(await request(owner, 'inspect', { target: 'jobs', fields: ['id', 'state'] })).toMatchObject({
      ok: true, result: { items: [{ id, state: expect.stringMatching(/queued|preparing|running/) }] },
    });
    expect(await request(owner, 'startExport', { format: 'gif' })).toMatchObject({ ok: false, errors: [{ code: 'RESOURCE_LIMIT' }] });
    expect(await request(owner, 'renderFrame', { timeSeconds: 0 })).toMatchObject({ ok: false, errors: [{ code: 'RESOURCE_LIMIT' }] });
    expect(await request(owner, 'cancelJob', { jobId: id })).toMatchObject({ ok: true, result: { state: 'canceled' } });
    expect(await request(owner, 'jobStatus', { jobId: id })).toMatchObject({ ok: true, result: { state: 'canceled', hasArtifact: false } });
    owner.revoke();
  });

  it('fails a job after its bounded timeout and rejects a revoked session', async () => {
    vi.useFakeTimers();
    vi.mocked(exportMedia).mockImplementation((_project, _settings, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('Canceled.')), { once: true });
    }));
    const owner = bridge();
    const started = await request(owner, 'startExport', { format: 'gif' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = (started.result as { jobId: string }).jobId;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await request(owner, 'jobStatus', { jobId: id })).toMatchObject({ ok: true, result: { state: 'failed', hasArtifact: false } });
    owner.revoke();
    expect(await request(owner, 'jobStatus', { jobId: id })).toMatchObject({ ok: false, errors: [{ code: 'PERMISSION_DENIED' }] });
  });
});
