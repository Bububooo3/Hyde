// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HydeAuthoringSession } from './authoring';
import { decodeProjectBytes } from './archive';
import { runCli } from './cli';
import { runBrowserTask } from './cliBrowserRunner';
import { HydeSDK } from './sdk';

let folder: string;
beforeAll(async () => {
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.cli-browser.config.ts'], { stdio: 'ignore' });
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.portable.config.ts'], { stdio: 'ignore' });
  await mkdir(resolve('tmp'), { recursive: true });
  folder = await mkdtemp(resolve('tmp', 'hyde-browser-cli-'));
}, 30_000);
afterAll(async () => { if (folder) await rm(folder, { recursive: true, force: true }); });

async function cli(...args: string[]) {
  let stdout = '', stderr = '';
  const code = await runCli([...args, '--json'], { stdout: part => { stdout += part; }, stderr: part => { stderr += part; } });
  return { code, stdout: stdout ? JSON.parse(stdout) : undefined, stderr: stderr ? JSON.parse(stderr) : undefined };
}

describe('CLI Hyde browser host', () => {
  it('previews actual authored pixels and exports a real animated GIF', async () => {
    const session = HydeAuthoringSession.create('Red stage');
    const created = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'element.create', args: { kind: 'rectangle', properties: { name: 'Visible fill', x: 960, y: 540, width: 1920, height: 1080, fill: '#ff0000' } } },
    ] });
    expect(created.ok).toBe(true);
    const source = join(folder, 'story.hyde'), framePath = join(folder, 'frame.png'), gifPath = join(folder, 'story.gif');
    await writeFile(source, session.exportProject());

    const preview = await cli('project', 'preview', source, '--time', '0', '--width', '64', '--height', '64', '--output', framePath);
    expect(preview.code, JSON.stringify(preview)).toBe(0);
    expect(preview.stdout.result.mime).toBe('image/png');
    const png = await readFile(framePath);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await browser.newPage();
      const pixel = await page.evaluate(async base64 => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return Array.from(context.getImageData(32, 32, 1, 1).data);
      }, png.toString('base64'));
      expect(pixel[0]).toBeGreaterThan(230);
      expect(pixel[1]).toBeLessThan(40);
      expect(pixel[2]).toBeLessThan(40);
    } finally { await browser.close(); }

    const render = await cli('project', 'render', source, '--format', 'gif', '--start', '0', '--end', '0.4', '--fps', '5', '--width', '64', '--height', '64', '--output', gifPath);
    expect(render.code, JSON.stringify(render)).toBe(0);
    expect(render.stdout.result.frameCount).toBe(2);
    expect(render.stdout.result.progress.phase).toBe('finalizing');
    const gif = await readFile(gifPath);
    expect(gif.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    expect(gif.at(-1)).toBe(0x3b);
  }, 90_000);

  it('reports invalid preview arguments without creating output', async () => {
    const source = join(folder, 'story.hyde'), output = join(folder, 'bad.png');
    const result = await cli('project', 'preview', source, '--time', '-1', '--output', output);
    expect(result.code).toBe(2);
    expect(result.stderr.errors[0].code).toBe('INVALID_ARGUMENT');
  });

  it('cancels an active browser export after progress without leaving an artifact', async () => {
    const project = HydeAuthoringSession.create('Cancelable').snapshot();
    const controller = new AbortController();
    await expect(runBrowserTask(project, { kind: 'render', settings: {
      format: 'gif', start: 0, end: 4, width: 64, height: 64, fps: 10,
      quality: 'medium', loop: false, background: '#ffffff', includeAudio: false,
    } }, {
      signal: controller.signal,
      onProgress: progress => { if (progress.phase === 'rendering') controller.abort(); },
    })).rejects.toMatchObject({ code: 'CANCELED' });
  }, 30_000);

  it('packages an SDK story for isolated file playback with its original native source', async () => {
    const sdk = new HydeSDK();
    const session = await sdk.createProject({ name: 'SDK standalone story' });
    const texture = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64'));
    const handle = session.stageAsset(texture, 'image/png', 'image');
    const created = await session.execute({ protocolVersion: 1, expectedRevision: 0, commands: [
      { op: 'asset.add', args: { alias: '$texture', handle, name: 'spot.png' } },
      { op: 'element.create', args: { kind: 'rectangle', properties: { name: 'Red stage', x: 960, y: 540, width: 1920, height: 1080, fill: '#ff0000' } } },
      { op: 'element.create', args: { kind: 'image', properties: { name: 'Editable spot', x: 100, y: 100, width: 64, height: 64, assetId: '$texture' } } },
    ] });
    expect(created.ok).toBe(true);
    const source = join(folder, 'sdk-story.hyde'), output = join(folder, 'sdk-story-web.zip');
    const native = await session.exportProject();
    await writeFile(source, native);
    const result = await cli('project', 'export', source, '--format', 'web', '--output', output);
    expect(result.code, JSON.stringify(result)).toBe(0);
    expect(result.stdout.result.mime).toBe('application/zip');
    const packageFiles = unzipSync(new Uint8Array(await readFile(output)));
    expect(packageFiles['index.html']).toBeTruthy();
    expect(packageFiles['source.hyde']).toBeTruthy();
    expect(packageFiles['licenses/JetBrains-Mono.txt']).toBeTruthy();
    const original = decodeProjectBytes(native);
    expect(decodeProjectBytes(packageFiles['source.hyde'])).toEqual(original);
    expect(packageFiles['media/0.png']).toEqual(texture);
    const reopened = await sdk.openProject(packageFiles['source.hyde']);
    expect(reopened.snapshot().elements[0].id).toBe(original.elements[0].id);
    expect(await readFile(source)).toEqual(Buffer.from(native));
    const packedStory = JSON.parse(strFromU8(packageFiles['story.json']));
    expect(packedStory.elements[0].id).toBe(original.elements[0].id);
    expect(packedStory.assets[0].dataUrl).toBe('./media/0.png');

    const html = join(folder, 'standalone.html');
    await writeFile(html, packageFiles['index.html']);
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    try {
      const page = await browser.newPage();
      const failures: string[] = [], requests: string[] = [];
      page.on('pageerror', error => failures.push(error.message));
      page.on('request', request => requests.push(request.url()));
      await page.goto(pathToFileURL(html).href);
      await page.locator('.player-screen canvas').waitFor();
      const pixel = await page.locator('.player-screen canvas').evaluate((canvas: HTMLCanvasElement) => {
        const copy = document.createElement('canvas');
        copy.width = canvas.width; copy.height = canvas.height;
        const context = copy.getContext('2d')!;
        context.drawImage(canvas, 0, 0);
        return Array.from(context.getImageData(960, 540, 1, 1).data);
      });
      expect(pixel[0]).toBeGreaterThan(230);
      expect(pixel[1]).toBeLessThan(40);
      expect(pixel[2]).toBeLessThan(40);
      expect(requests.every(url => url.startsWith('file:') || url.startsWith('data:'))).toBe(true);
      expect(failures).toEqual([]);
    } finally { await browser.close(); }
  }, 90_000);
});
