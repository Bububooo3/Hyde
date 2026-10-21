import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { createElement, createProject } from '../src/model';

test('portable classic player runs directly from file without sibling files', async ({ context }) => {
  const project = createProject('Offline test');
  project.elements = [createElement('rectangle', { name: 'Shape', x: 480, y: 270, width: 250, height: 200 })];
  const [js, css] = await Promise.all([
    readFile(join(process.cwd(), 'dist/portable/player.js'), 'utf8'),
    readFile(join(process.cwd(), 'dist/portable/player.css'), 'utf8'),
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'hyde-portable-runtime-'));
  try {
    const htmlPath = join(directory, 'index.html');
    await writeFile(htmlPath, `<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script id="hyde-story" type="application/json">${JSON.stringify(project)}</script><script>${js}</script></body></html>`);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(htmlPath).href);
    await expect(page.locator('.player-screen canvas')).toHaveCount(1);
    expect(await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height])).toEqual([960, 540]);
    const screen = await page.locator('.player-screen').boundingBox();
    const canvas = await page.locator('canvas').boundingBox();
    expect(screen).toBeTruthy();expect(canvas).toBeTruthy();
    expect(canvas!.width).toBeCloseTo(screen!.width, 0);
    expect(canvas!.height).toBeCloseTo(screen!.height, 0);
    expect(errors).toEqual([]);
    await page.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('exported player opens as one local HTML file and fullscreens only its stage', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open example' }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: /Standalone web story/ }).click();
  const zip = unzipSync(new Uint8Array(await readFile((await (await downloaded).path())!)));
  expect(zip['index.html']).toBeTruthy();
  const directory = await mkdtemp(join(tmpdir(), 'hyde-offline-player-'));
  try {
    const htmlPath = join(directory, 'index.html');
    await writeFile(htmlPath, zip['index.html']);
    const viewer = await context.newPage();
    const errors: string[] = [];
    const requests: string[] = [];
    viewer.on('pageerror', error => errors.push(error.message));
    viewer.on('request', request => requests.push(request.url()));
    await viewer.goto(pathToFileURL(htmlPath).href);
    await expect(viewer.locator('.player-screen canvas')).toHaveCount(1);
    await expect(viewer.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    expect(await viewer.evaluate(() => document.fonts.check('400 40px "JetBrains Mono"'))).toBeTruthy();
    expect(requests.every(url => url.startsWith('file:') || url.startsWith('data:'))).toBeTruthy();
    await viewer.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(viewer.locator('.player-frame').getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
    const geometry = await viewer.evaluate(() => {
      const frame = document.querySelector('.player-frame')!.getBoundingClientRect();
      const screen = document.querySelector('.player-screen')!.getBoundingClientRect();
      return { fullscreenClass: document.fullscreenElement?.className, frame: [frame.width, frame.height], screen: [screen.width, screen.height] };
    });
    expect(geometry.fullscreenClass).toBe('player-frame');
    expect(geometry.frame[1]).toBeGreaterThan(geometry.screen[1]);
    expect(geometry.screen[0] / geometry.screen[1]).toBeCloseTo(960 / 540, 2);
    expect(errors).toEqual([]);
    await viewer.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
