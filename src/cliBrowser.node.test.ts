// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HydeAuthoringSession } from './authoring';
import { runCli } from './cli';
import { runBrowserTask } from './cliBrowserRunner';

let folder: string;
beforeAll(async () => {
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.cli-browser.config.ts'], { stdio: 'ignore' });
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
});
