// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { encodeProjectBytes } from './archive';
import { enrichAssetInspection } from './assetInspection';
import { HydeAuthoringSession } from './authoring';
import { runCli } from './cli';
import { EditorBridge } from './editorBridge';
import { createProject } from './model';
import { HydeAssemblyHandle, HydeSDK, HydeSession } from './sdk';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64'));

it('provides the same bounded asset hash and image size through SDK, CLI and read-only bridge', async () => {
  const project = createProject('Inspected assets');
  project.assets.push({ id: 'image-one', name: 'pixel.png', mime: 'image/png', kind: 'image', dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}` });
  const expected = { id: 'image-one', byteLength: png.length, contentSha256: createHash('sha256').update(png).digest('hex'), width: 1, height: 1 };
  const archive = encodeProjectBytes(project);
  const session = await new HydeSDK().openProject(archive);
  expect(await session.inspect({ target: 'assets' })).toMatchObject({ items: [expected] });
  expect(await session.inspect({ target: 'asset', id: 'image-one', fields: 'id,contentSha256,width,height' })).toMatchObject({ asset: {
    id: expected.id, contentSha256: expected.contentSha256, width: 1, height: 1,
  } });
  expect(JSON.stringify(await session.inspect({ target: 'assets' }))).not.toContain('data:image');
  await mkdir(join(process.cwd(), 'tmp'), { recursive: true });
  const path = await mkdtemp(join(process.cwd(), 'tmp', 'hyde-asset-inspect-'));
  try {
    const file = join(path, 'assets.hyde'); await writeFile(file, archive);
    let stdout = '';
    const code = await runCli(['project', 'inspect', file, '--target', 'assets', '--json'], { stdout: value => { stdout += value; }, stderr: () => undefined });
    expect(code).toBe(0);
    expect(JSON.parse(stdout).result.items[0]).toMatchObject(expected);
  } finally { await rm(path, { recursive: true, force: true }); }
  const bridge = new EditorBridge(new Set(['read']), {
    project: () => project, revision: () => 0, commit: () => undefined, select: () => undefined, setPlayhead: () => undefined,
  });
  const response = await bridge.request({ protocolVersion: 1, sessionId: bridge.sessionId, requestId: 'asset-read', operation: 'inspect', payload: { target: 'assets' } });
  expect(response).toMatchObject({ ok: true, result: { items: [expected] } });
  bridge.revoke();
  expect(new HydeAuthoringSession(project).inspect({ target: 'assets', fields: 'id' })).toMatchObject({ items: [{ id: 'image-one' }] });
});

it('reads bounded WebP and JPEG dimensions without raster decoding', async () => {
  const project = createProject();
  const webp = new Uint8Array(30); webp.set(Buffer.from('RIFF'), 0); webp.set(Buffer.from('WEBPVP8X'), 8);
  webp[24] = 31; webp[27] = 15;
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 24, 0, 40, 1, 1, 0x11, 0, 0xff, 0xd9]);
  project.assets.push(
    { id: 'webp', name: 'wide.webp', mime: 'image/webp', kind: 'image', dataUrl: `data:image/webp;base64,${Buffer.from(webp).toString('base64')}` },
    { id: 'jpeg', name: 'photo.jpg', mime: 'image/jpeg', kind: 'image', dataUrl: `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}` },
  );
  const session = new HydeAuthoringSession(project);
  const inspected = await enrichAssetInspection(project, { target: 'assets', fields: 'id,width,height' }, session.inspect({ target: 'assets', fields: 'id,width,height' }));
  expect(inspected.items).toEqual([{ id: 'jpeg', width: 40, height: 24 }, { id: 'webp', width: 32, height: 16 }]);
});

it('inspects project summaries and asset pages without cloning embedded media', async () => {
  const project = createProject('Large embedded asset');
  project.assets.push({ id: 'large', name: 'large.bin', mime: 'application/octet-stream', kind: 'image', dataUrl: `data:application/octet-stream;base64,${'A'.repeat(4 * 1024 * 1024)}` });
  const authoring = new HydeAuthoringSession(project);
  const snapshot = vi.spyOn(authoring, 'snapshot').mockImplementation(() => { throw new Error('Inspection cloned the project.'); });
  const session = new HydeSession(authoring);
  expect(await session.inspect({ target: 'project' })).toMatchObject({ project: { assetCount: 1 } });
  expect(await session.inspect({ target: 'scenes' })).toHaveProperty('items');
  expect(await session.inspect({ target: 'assets', fields: 'id,name' })).toMatchObject({ items: [{ id: 'large', name: 'large.bin' }] });
  expect(await session.inspect({ target: 'asset', id: 'large', fields: 'id,byteLength' })).toMatchObject({ asset: { id: 'large', byteLength: 3 * 1024 * 1024 } });
  expect(snapshot).not.toHaveBeenCalled();
});

it('inspects an assembly inventory without cloning its embedded media', () => {
  const handle = new HydeAssemblyHandle({ format: 'hyde-assembly', version: 1, name: 'Large assembly', elements: [],
    assets: [{ id: 'large', name: 'large.bin', mime: 'application/octet-stream', kind: 'image', dataUrl: `data:application/octet-stream;base64,${'A'.repeat(4 * 1024 * 1024)}` }] });
  const clone = vi.spyOn(globalThis, 'structuredClone');
  try {
    expect(handle.inspect()).toMatchObject({ name: 'Large assembly', assets: [{ id: 'large', name: 'large.bin' }] });
    expect(JSON.stringify(handle.inspect())).not.toContain('dataUrl');
    expect(clone.mock.calls.every(([value]) => !value || typeof value !== 'object' || !('assets' in value) && !('dataUrl' in value))).toBe(true);
  } finally { clone.mockRestore(); }
});
