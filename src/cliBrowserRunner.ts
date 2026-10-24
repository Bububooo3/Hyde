import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import type { ExportProgress } from './mediaExport';
import type { Project } from './model';

export type CliBrowserTask =
  | { kind: 'preview'; options: { timeSeconds: number; width?: number; height?: number; format?: 'png' | 'jpeg' | 'webp'; quality?: number } }
  | { kind: 'render'; settings: { format: 'gif' | 'mp4' | 'webm'; start: number; end: number; width: number; height: number; fps: number; quality: 'low' | 'medium' | 'high'; loop: boolean; background: string; includeAudio: boolean } }
  | { kind: 'web' };

export interface BrowserTaskResult {
  bytes: Uint8Array;
  mime: string;
  width?: number;
  height?: number;
  frameCount?: number;
  duration?: number;
  includesAudio?: boolean;
  warnings?: { code: string; severity: string; message: string }[];
  progress?: ExportProgress;
}

export class BrowserHostError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Prefer an installed Chrome before Playwright's optional bundled Chromium. */
export async function launchLocalChromium(args: string[] = []): Promise<Browser> {
  let chromium: typeof import('playwright')['chromium'];
  try { ({ chromium } = await import('playwright')); }
  catch { throw new BrowserHostError('CAPABILITY_UNAVAILABLE', 'Playwright is required for local browser work. Install Hyde dependencies and a Chromium browser.'); }
  const launch = { headless: true, args };
  try { return await chromium.launch({ ...launch, channel: 'chrome' }); }
  catch {
    try { return await chromium.launch(launch); }
    catch { throw new BrowserHostError('CAPABILITY_UNAVAILABLE', 'Chromium is unavailable. Install Chrome or run npx playwright install chromium.'); }
  }
}

function runtimePath(): string {
  const folder = dirname(fileURLToPath(import.meta.url));
  if (basename(dirname(folder)) === 'dist') return resolve(folder, '../cli/hyde-browser.iife.js');
  return resolve(folder, '../dist/cli/hyde-browser.iife.js');
}

async function portableResources(): Promise<{ playerJs: string; playerCss: string; licenseText: string }> {
  const folder = resolve(dirname(runtimePath()), '../portable');
  try {
    const [playerJs, playerCss, licenseText] = await Promise.all([
      readFile(resolve(folder, 'player.js'), 'utf8'),
      readFile(resolve(folder, 'player.css'), 'utf8'),
      readFile(resolve(folder, 'licenses/JetBrains-Mono.txt'), 'utf8'),
    ]);
    return { playerJs, playerCss, licenseText };
  } catch {
    throw new BrowserHostError('CAPABILITY_UNAVAILABLE', 'Hyde portable player is missing. Run npm run cli:build to build the player and browser runtime.');
  }
}

async function browserPage(): Promise<{ page: Page; close: () => Promise<void> }> {
  const runtime = runtimePath();
  try { await stat(runtime); }
  catch { throw new BrowserHostError('CAPABILITY_UNAVAILABLE', 'Hyde browser runtime is missing. Run npm run cli:build to build the CLI and render host.'); }
  const browser = await launchLocalChromium(['--use-angle=swiftshader', '--enable-unsafe-swiftshader']);
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = route.request().url();
      return url.startsWith('blob:') || url.startsWith('data:') ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    await page.addScriptTag({ path: runtime });
    return { page, close: async () => { await browser.close(); } };
  } catch {
    await browser.close().catch(() => undefined);
    throw new BrowserHostError('CAPABILITY_UNAVAILABLE', 'Hyde browser runtime could not initialize in Chromium. Check local browser and WebGL support.');
  }
}

function responseError(response: { ok: boolean; code?: string; message?: string }): never {
  const code = response.code ?? 'EXPORT_FAILED';
  throw new BrowserHostError(code, (response.message ?? 'Browser rendering failed.').slice(0, 500));
}

/** Run Hyde's real browser renderer in a private, offline page. No local server is opened. */
export async function runBrowserTask(project: Project, task: CliBrowserTask, options: { signal?: AbortSignal; timeoutMs?: number; onProgress?: (progress: ExportProgress) => void } = {}): Promise<BrowserTaskResult> {
  if (options.signal?.aborted) throw new BrowserHostError('CANCELED', 'Browser job canceled.');
  const request = task.kind === 'web' ? { kind: 'web' as const, resources: await portableResources() } : task;
  const session = await browserPage();
  const { page } = session;
  let latestProgress: ExportProgress | undefined;
  const controller = new AbortController();
  const upstreamAbort = () => controller.abort();
  options.signal?.addEventListener('abort', upstreamAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? (task.kind === 'preview' ? 120_000 : 1_800_000));
  let abortListener: (() => void) | undefined;
  try {
    await page.exposeBinding('__hydeCliProgress', (_source, progress: ExportProgress) => {
      latestProgress = progress;
      options.onProgress?.(progress);
    });
    const run = page.evaluate(async ({ source, request }) => {
      try { return { ok: true, result: await window.__hydeCliRuntime.run(source, request) }; }
      catch (error) {
        const failure = error as Error & { code?: string };
        return { ok: false, code: failure.code ?? (failure.name === 'AbortError' ? 'CANCELED' : 'EXPORT_FAILED'), message: failure.message };
      }
    }, { source: project, request });
    const canceled = new Promise<never>((_, reject) => {
      abortListener = () => {
        void page.evaluate(() => window.__hydeCliRuntime.cancel()).catch(() => undefined);
        setTimeout(() => reject(new BrowserHostError('CANCELED', 'Browser job canceled or timed out.')), 750);
      };
      controller.signal.addEventListener('abort', abortListener, { once: true });
      if (controller.signal.aborted) abortListener();
    });
    const response = await Promise.race([run, canceled]);
    if (!response.ok || !response.result) responseError(response);
    const result = response.result;
    if (!Number.isSafeInteger(result.bytes) || result.bytes < 1 || result.bytes > 536_870_912) throw new BrowserHostError('RESOURCE_LIMIT', 'The browser artifact exceeds the 512 MiB CLI transfer limit.');
    const bytes = Buffer.alloc(result.bytes);
    for (let offset = 0; offset < result.bytes; offset += 1_048_576) {
      const length = Math.min(1_048_576, result.bytes - offset);
      const chunk = await Promise.race([page.evaluate(({ start, size }) => window.__hydeCliRuntime.chunk(start, size), { start: offset, size: length }), canceled]);
      if (chunk.length !== length) throw new BrowserHostError('EXPORT_FAILED', 'Hyde browser artifact transfer was incomplete.');
      Buffer.from(chunk).copy(bytes, offset);
    }
    return { bytes, mime: result.mime, width: result.width, height: result.height, frameCount: result.frameCount, duration: result.duration, includesAudio: result.includesAudio, warnings: result.warnings, progress: latestProgress };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', upstreamAbort);
    if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    await page.evaluate(() => window.__hydeCliRuntime.cleanup()).catch(() => undefined);
    await session.close().catch(() => undefined);
  }
}

export async function probeBrowserHost(project: Project): Promise<{ available: boolean; capabilities?: unknown; problem?: string }> {
  let session: Awaited<ReturnType<typeof browserPage>>;
  try { session = await browserPage(); }
  catch (error) { return { available: false, problem: error instanceof Error ? error.message : 'Chromium unavailable.' }; }
  try {
    const response = await session.page.evaluate(async source => {
      try { return { ok: true, result: await window.__hydeCliRuntime.doctor(source) }; }
      catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'Browser host failed.' }; }
    }, project);
    return response.ok ? { available: true, capabilities: response.result } : { available: false, problem: response.message };
  } finally { await session.close().catch(() => undefined); }
}
