import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAssemblyBytes, decodeProjectBytes, encodeProjectBytes, HydeSchemaUnsupportedError, validateDocument } from './archive';
import { HydeAuthoringSession } from './authoring';
import { BrowserHostError, probeBrowserHost, runBrowserTask } from './cliBrowserRunner';
import type { ExecuteRequest, HydeCommand, HydeDiagnostic, InspectRequest } from './authoring';
import { insertAssemblyAt } from './editing';
import { sceneIdAt } from './model';
import type { Assembly, Project } from './model';
import { atomicWrite } from './atomicFile';
export { atomicWrite } from './atomicFile';

type Output = { stdout: (text: string) => void; stderr: (text: string) => void };
type Flags = Record<string, string | true>;
type Parsed = { positionals: string[]; flags: Flags };
type ExitCode = 0 | 2 | 3 | 4 | 5 | 6 | 7;

export class CliFailure extends Error {
  constructor(readonly code: string, message: string, readonly exitCode: ExitCode,
    readonly transaction?: { revision: number; errors: HydeDiagnostic[]; warnings: HydeDiagnostic[] }) { super(message); }
}

function parse(args: string[]): Parsed {
  const positionals: string[] = [], flags: Flags = {};
  const booleanFlags = new Set(['json', 'dry-run', 'loop', 'no-audio']);
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    const key = token.slice(2);
    if (!key || Object.hasOwn(flags, key)) throw new CliFailure('INVALID_ARGUMENT', `Invalid or repeated --${key} option.`, 2);
    const next = args[i + 1];
    flags[key] = booleanFlags.has(key) ? true : next !== undefined && !next.startsWith('--') ? args[++i] : true;
  }
  return { positionals, flags };
}

function allowed(flags: Flags, names: string[]): void {
  const unknown = Object.keys(flags).find(key => !names.includes(key));
  if (unknown) throw new CliFailure('INVALID_ARGUMENT', `Unknown --${unknown} option.`, 2);
}
function option(flags: Flags, name: string, required = false): string | undefined {
  const value = flags[name];
  if (value === true || (required && !value)) throw new CliFailure('INVALID_ARGUMENT', `--${name} requires a value.`, 2);
  return value;
}
function numeric(flags: Flags, name: string, fallback?: number): number | undefined {
  const value = option(flags, name);
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new CliFailure('INVALID_ARGUMENT', `--${name} must be a finite number.`, 2);
  return number;
}
function input(positionals: string[], index: number, label: string): string {
  const value = positionals[index];
  if (!value) throw new CliFailure('INVALID_ARGUMENT', `${label} is required.`, 2);
  return value;
}
function noExtra(positionals: string[], expected: number): void {
  if (positionals.length !== expected) throw new CliFailure('INVALID_ARGUMENT', 'Unexpected positional arguments.', 2);
}
function publicName(path: string): string { return basename(path); }
async function readBytes(path: string): Promise<Uint8Array> {
  try { return await readFile(path); }
  catch (error) { throw new CliFailure('INVALID_ARGUMENT', `Could not read ${publicName(path)} (${(error as NodeJS.ErrnoException).code ?? 'I/O error'}).`, 2); }
}
async function projectFrom(path: string): Promise<Project> {
  try { return decodeProjectBytes(await readBytes(path)); }
  catch (error) {
    if (error instanceof CliFailure) throw error;
    if (error instanceof HydeSchemaUnsupportedError) throw new CliFailure(error.code, error.message, 3);
    throw new CliFailure('INVALID_PROJECT', error instanceof Error ? error.message : 'Invalid Hyde project.', 3);
  }
}
async function assemblyFrom(path: string): Promise<Assembly> {
  try { return decodeAssemblyBytes(await readBytes(path)); }
  catch (error) {
    if (error instanceof CliFailure) throw error;
    if (error instanceof HydeSchemaUnsupportedError) throw new CliFailure(error.code, error.message, 3);
    throw new CliFailure('INVALID_PROJECT', error instanceof Error ? error.message : 'Invalid Hyde assembly.', 3);
  }
}
function safeAsset(asset: Project['assets'][number]) {
  const { dataUrl, ...metadata } = asset;
  const comma = dataUrl.indexOf(',');
  const bytes = dataUrl.slice(0, comma).toLowerCase().endsWith(';base64')
    ? Buffer.from(dataUrl.slice(comma + 1), 'base64')
    : Buffer.from(decodeURIComponent(dataUrl.slice(comma + 1)), 'utf8');
  return { ...metadata, contentSha256: createHash('sha256').update(bytes).digest('hex') };
}
function entityMap(project: Project): Map<string, unknown> {
  return new Map<string, unknown>([
    ...project.sequences.map(value => [`scene:${value.id}`, value] as const),
    ...project.elements.map(value => [`element:${value.id}`, value] as const),
    ...project.assets.map(value => [`asset:${value.id}`, safeAsset(value)] as const),
    ...project.captions.map(value => [`caption:${value.id}`, value] as const),
    ...(project.folders ?? []).map(value => [`folder:${value.id}`, value] as const),
  ]);
}
function changedFields(before: unknown, after: unknown): string[] {
  const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key])).sort();
}
export function semanticDiff(before: Project, after: Project) {
  const old = entityMap(before), next = entityMap(after);
  return {
    projectFields: changedFields({ name: before.name, width: before.width, height: before.height, fps: before.fps, duration: before.duration, background: before.background, webPlayer: before.webPlayer }, { name: after.name, width: after.width, height: after.height, fps: after.fps, duration: after.duration, background: after.background, webPlayer: after.webPlayer }),
    added: [...next.keys()].filter(id => !old.has(id)).sort(),
    removed: [...old.keys()].filter(id => !next.has(id)).sort(),
    changed: [...next.keys()].filter(id => old.has(id) && JSON.stringify(old.get(id)) !== JSON.stringify(next.get(id))).sort().map(id => ({ id, fields: changedFields(old.get(id), next.get(id)) })),
  };
}

function bounded(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 4000 ? { truncated: true, length: value.length, prefix: value.slice(0, 4000) } : value;
  if (depth >= 12) return { truncated: true, reason: 'depth' };
  if (Array.isArray(value)) return value.length > 100 ? { items: value.slice(0, 100).map(item => bounded(item, depth + 1)), truncated: true, total: value.length } : value.map(item => bounded(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bounded(entry, depth + 1)]));
  return value;
}
function inspectInteger(flags: Flags, name: string, minimum: number, maximum: number): number | undefined {
  const value = numeric(flags, name);
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum))
    throw new CliFailure('INVALID_ARGUMENT', `--${name} must be an integer between ${minimum} and ${maximum}.`, 2);
  return value;
}
function projectSummary(project: Project) {
  return { format: project.format, version: project.version, id: project.id, name: project.name, width: project.width, height: project.height, fps: project.fps, duration: project.duration, scenes: project.sequences.length, elements: project.elements.length, assets: project.assets.length, captions: project.captions.length };
}
function assemblySummary(assembly: Assembly) {
  return { format: assembly.format, version: assembly.version, name: assembly.name, elements: assembly.elements.length, assets: assembly.assets.length };
}
function failExecution(result: Awaited<ReturnType<HydeAuthoringSession['execute']>>): never {
  if (result.ok) throw new Error('Expected a failed transaction.');
  const first = result.errors[0];
  const exit: ExitCode = first?.code === 'REVISION_CONFLICT' ? 4 : first?.code === 'SCHEMA_UNSUPPORTED' ? 3 : 2;
  throw new CliFailure(first?.code ?? 'INVALID_ARGUMENT', first?.message ?? 'Command batch failed.', exit,
    { revision: result.revision, errors: result.errors, warnings: result.warnings });
}
async function commandsFrom(path: string, session: HydeAuthoringSession): Promise<ExecuteRequest> {
  let document: unknown;
  try { document = JSON.parse((await readFile(path)).toString('utf8')); }
  catch { throw new CliFailure('INVALID_ARGUMENT', `Could not parse ${publicName(path)} as JSON.`, 2); }
  const wrapper = Array.isArray(document) ? { commands: document } : document;
  if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)) throw new CliFailure('INVALID_ARGUMENT', 'Command file must contain a command array or request object.', 2);
  const payload = wrapper as Record<string, unknown>;
  if (!Array.isArray(payload.commands)) throw new CliFailure('INVALID_ARGUMENT', 'Command file requires commands array.', 2);
  const commands = structuredClone(payload.commands) as HydeCommand[];
  if (payload.stagedAssets !== undefined) {
    if (!Array.isArray(payload.stagedAssets) || payload.stagedAssets.length > 100) throw new CliFailure('RESOURCE_LIMIT', 'stagedAssets must contain at most 100 files.', 2);
    const handles = new Map<string, string>();
    for (const entry of payload.stagedAssets) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new CliFailure('INVALID_ARGUMENT', 'Invalid staged asset entry.', 2);
      const item = entry as Record<string, unknown>;
      if (typeof item.handle !== 'string' || typeof item.path !== 'string' || typeof item.mime !== 'string' || !['image', 'audio', 'video', 'font'].includes(String(item.kind)) || handles.has(item.handle)) throw new CliFailure('INVALID_ARGUMENT', 'Invalid or duplicate staged asset declaration.', 2);
      let staged: string;
      try { staged = session.stageAsset(await readBytes(item.path), item.mime, item.kind as Project['assets'][number]['kind']); }
      catch (error) { if (error instanceof CliFailure) throw error; throw new CliFailure('INVALID_ASSET', error instanceof Error ? error.message : 'Invalid asset.', 2); }
      handles.set(item.handle, staged);
    }
    for (const command of commands) if (command.op === 'asset.add') {
      const declared = command.args.handle;
      if (handles.has(declared)) command.args.handle = handles.get(declared)!;
    }
  }
  return { protocolVersion: payload.protocolVersion === undefined ? 1 : payload.protocolVersion as 1, expectedRevision: payload.expectedRevision === undefined ? session.revision : payload.expectedRevision as number, commands, dryRun: Boolean(payload.dryRun), correlationId: typeof payload.correlationId === 'string' ? payload.correlationId : undefined };
}

function browserJobSignal(): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  return { signal: controller.signal, close: () => { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); } };
}

async function dispatch(args: string[], io: Output): Promise<{ command: string; result: unknown }> {
  const { positionals, flags } = parse(args);
  const family = input(positionals, 0, 'Command'), action = positionals[1];
  const key = `${family} ${action ?? ''}`.trim();
  switch (key) {
    case 'project new': {
      allowed(flags, ['name', 'output', 'json']); noExtra(positionals, 2);
      const session = HydeAuthoringSession.create(option(flags, 'name') ?? 'Untitled story');
      const output = await atomicWrite(option(flags, 'output', true)!, session.exportProject());
      return { command: key, result: { ...projectSummary(session.snapshot()), ...output } };
    }
    case 'project validate': {
      allowed(flags, ['json']); noExtra(positionals, 3);
      const project = await projectFrom(input(positionals, 2, 'Project archive'));
      return { command: key, result: projectSummary(project) };
    }
    case 'project inspect': {
      allowed(flags, ['target', 'id', 'scene', 'scene-id', 'limit', 'cursor', 'depth', 'fields', 'time-start', 'time-end', 'since-revision', 'json']); noExtra(positionals, 3);
      const session = new HydeAuthoringSession(await projectFrom(input(positionals, 2, 'Project archive')));
      const target = (option(flags, 'target') ?? 'project') as Parameters<typeof session.inspect>[0]['target'];
      if (!['project', 'scenes', 'scene', 'elements', 'element', 'assets', 'asset', 'changes', 'tree', 'timeline', 'assembly'].includes(target)) throw new CliFailure('INVALID_ARGUMENT', 'Unknown inspection target.', 2);
      const scene = option(flags, 'scene'), sceneId = option(flags, 'scene-id');
      if (scene && sceneId) throw new CliFailure('INVALID_ARGUMENT', 'Use only one of --scene and --scene-id.', 2);
      const fields = option(flags, 'fields');
      if (fields !== undefined) {
        const selected = fields.split(',').map(value => value.trim());
        if (selected.length > 40 || selected.some(value => !value || value.length > 100)) throw new CliFailure('INVALID_ARGUMENT', '--fields must list 1 to 40 field names.', 2);
      }
      const start = numeric(flags, 'time-start'), end = numeric(flags, 'time-end');
      if ((start !== undefined && start < 0) || (end !== undefined && end < 0) || (start !== undefined && end !== undefined && end < start))
        throw new CliFailure('INVALID_ARGUMENT', 'Inspection time range is invalid.', 2);
      const query: InspectRequest = {
        target, id: option(flags, 'id'), sceneId: scene ?? sceneId, fields,
        limit: inspectInteger(flags, 'limit', 1, 100), cursor: inspectInteger(flags, 'cursor', 0, Number.MAX_SAFE_INTEGER),
        depth: inspectInteger(flags, 'depth', 0, 8), sinceRevision: inspectInteger(flags, 'since-revision', 0, Number.MAX_SAFE_INTEGER),
        timeStart: start, timeEnd: end,
      };
      if (['scene', 'element', 'asset', 'assembly'].includes(target) && !query.id) throw new CliFailure('INVALID_ARGUMENT', `--id is required for ${target} inspection.`, 2);
      let result: ReturnType<typeof session.inspect>;
      try { result = session.inspect(query); }
      catch (error) { throw new CliFailure('TARGET_NOT_FOUND', error instanceof Error ? error.message : 'Inspection target not found.', 2); }
      if ('error' in result && result.error) throw new CliFailure(result.error.code, result.error.message, 2);
      return { command: key, result: bounded(result) };
    }
    case 'project apply': {
      allowed(flags, ['commands', 'output', 'dry-run', 'json']); noExtra(positionals, 3);
      const session = new HydeAuthoringSession(await projectFrom(input(positionals, 2, 'Project archive')));
      const request = await commandsFrom(option(flags, 'commands', true)!, session);
      if (flags['dry-run']) request.dryRun = true;
      const result = await session.execute(request);
      if (!result.ok) failExecution(result);
      if (request.dryRun) return { command: key, result: { ...result, dryRun: true } };
      const output = await atomicWrite(option(flags, 'output', true)!, session.exportProject());
      return { command: key, result: { ...result, ...output } };
    }
    case 'project diff': {
      allowed(flags, ['json']); noExtra(positionals, 4);
      const before = await projectFrom(input(positionals, 2, 'Before archive'));
      const after = await projectFrom(input(positionals, 3, 'After archive'));
      return { command: key, result: semanticDiff(before, after) };
    }
    case 'assembly inspect': {
      allowed(flags, ['json', 'limit', 'cursor']); noExtra(positionals, 3);
      const assembly = await assemblyFrom(input(positionals, 2, 'Assembly archive'));
      const limit = Math.min(100, Math.max(1, numeric(flags, 'limit', 25)!));
      const cursor = Math.max(0, Math.floor(numeric(flags, 'cursor', 0)!));
      const elements = [...assembly.elements].sort((a, b) => a.id.localeCompare(b.id));
      return { command: key, result: bounded({ ...assemblySummary(assembly), items: elements.slice(cursor, cursor + limit).map(({ tracks, assemblyClips, clipInstances, motionBehaviors, shapePath, ...item }) => ({ ...item, trackCount: tracks.length, clipCount: assemblyClips?.length ?? 0, instanceCount: clipInstances?.length ?? 0, motionCount: motionBehaviors?.length ?? 0, pathPointCount: shapePath?.points.length ?? 0 })), nextCursor: cursor + limit < elements.length ? cursor + limit : undefined, assetInventory: assembly.assets.map(({ dataUrl: _data, ...asset }) => asset) }) };
    }
    case 'assembly validate': {
      allowed(flags, ['json']); noExtra(positionals, 3);
      return { command: key, result: assemblySummary(await assemblyFrom(input(positionals, 2, 'Assembly archive'))) };
    }
    case 'assembly export': {
      allowed(flags, ['root', 'time', 'output', 'json']); noExtra(positionals, 3);
      const session = new HydeAuthoringSession(await projectFrom(input(positionals, 2, 'Project archive')));
      let bytes: Uint8Array;
      try { bytes = session.exportAssembly(option(flags, 'root', true)!, numeric(flags, 'time')); }
      catch (error) { throw new CliFailure('INVALID_ARGUMENT', error instanceof Error ? error.message : 'Assembly export failed.', 2); }
      const output = await atomicWrite(option(flags, 'output', true)!, bytes);
      return { command: key, result: { ...assemblySummary(decodeAssemblyBytes(bytes)), ...output } };
    }
    case 'assembly import': {
      allowed(flags, ['time', 'output', 'json']); noExtra(positionals, 4);
      const source = await projectFrom(input(positionals, 2, 'Project archive'));
      const assembly = await assemblyFrom(input(positionals, 3, 'Assembly archive'));
      const time = numeric(flags, 'time', 0)!;
      const previous = new Set(source.elements.map(item => item.id));
      let project: Project;
      try { project = insertAssemblyAt(source, assembly, time); }
      catch (error) { throw new CliFailure('INVALID_ARGUMENT', error instanceof Error ? error.message : 'Assembly import failed.', 2); }
      const sceneId = sceneIdAt(project, time);
      for (const element of project.elements) if (!previous.has(element.id)) element.sceneId = sceneId;
      validateDocument(project, false);
      const output = await atomicWrite(option(flags, 'output', true)!, encodeProjectBytes(project));
      return { command: key, result: { ...projectSummary(project), importedElements: project.elements.length - source.elements.length, ...output } };
    }
    case 'project preview': {
      allowed(flags, ['time', 'width', 'height', 'format', 'quality', 'timeout', 'output', 'json']); noExtra(positionals, 3);
      const project = await projectFrom(input(positionals, 2, 'Project archive'));
      const destination = option(flags, 'output', true)!;
      const format = option(flags, 'format') ?? 'png';
      if (!['png', 'jpeg', 'webp'].includes(format)) throw new CliFailure('INVALID_ARGUMENT', 'Preview format must be png, jpeg, or webp.', 2);
      const time = numeric(flags, 'time', 0)!, width = numeric(flags, 'width', project.width)!, height = numeric(flags, 'height', project.height)!, quality = numeric(flags, 'quality');
      if (time < 0 || time > project.duration || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 8_294_400 || (quality !== undefined && (quality < 0 || quality > 1))) throw new CliFailure('INVALID_ARGUMENT', 'Preview time, size, or quality is outside Hyde limits.', 2);
      const timeout = numeric(flags, 'timeout', 120)!;
      if (timeout < 1 || timeout > 3600) throw new CliFailure('INVALID_ARGUMENT', '--timeout must be between 1 and 3600 seconds.', 2);
      const job = browserJobSignal();
      try {
        const frame = await runBrowserTask(project, { kind: 'preview', options: { timeSeconds: time, width, height, format: format as 'png' | 'jpeg' | 'webp', quality } }, { signal: job.signal, timeoutMs: timeout * 1000 });
        const output = await atomicWrite(destination, frame.bytes);
        return { command: key, result: { mime: frame.mime, width: frame.width, height: frame.height, bytes: frame.bytes.byteLength, warnings: frame.warnings, ...output } };
      } finally { job.close(); }
    }
    case 'project render': {
      allowed(flags, ['format', 'start', 'end', 'width', 'height', 'fps', 'quality', 'loop', 'background', 'no-audio', 'timeout', 'output', 'json']); noExtra(positionals, 3);
      const project = await projectFrom(input(positionals, 2, 'Project archive'));
      const destination = option(flags, 'output', true)!;
      const format = option(flags, 'format') ?? 'mp4';
      if (!['gif', 'mp4', 'webm'].includes(format)) throw new CliFailure('INVALID_ARGUMENT', 'Render format must be gif, mp4, or webm.', 2);
      const quality = option(flags, 'quality') ?? 'medium';
      if (!['low', 'medium', 'high'].includes(quality)) throw new CliFailure('INVALID_ARGUMENT', 'Quality must be low, medium, or high.', 2);
      const start = numeric(flags, 'start', 0)!, end = numeric(flags, 'end', project.duration)!;
      const width = numeric(flags, 'width', project.width)!, height = numeric(flags, 'height', project.height)!, fps = numeric(flags, 'fps', project.fps)!;
      const background = option(flags, 'background') ?? project.background;
      if (start < 0 || end > project.duration || end <= start || !Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > 4096 || height > 4096 || width * height > 8_294_400 || !Number.isInteger(fps) || fps < 1 || fps > (format === 'gif' ? 50 : 60) || !/^#[0-9a-f]{6}$/i.test(background)) throw new CliFailure('INVALID_ARGUMENT', 'Render time, size, frame rate, or background is outside Hyde limits.', 2);
      const timeout = numeric(flags, 'timeout', 1800)!;
      if (timeout < 1 || timeout > 3600) throw new CliFailure('INVALID_ARGUMENT', '--timeout must be between 1 and 3600 seconds.', 2);
      const job = browserJobSignal();
      let lastProgress = -1;
      try {
        const media = await runBrowserTask(project, { kind: 'render', settings: { format: format as 'gif' | 'mp4' | 'webm', start, end, width, height, fps, quality: quality as 'low' | 'medium' | 'high', loop: !!flags['loop'], background, includeAudio: !flags['no-audio'] } }, { signal: job.signal, timeoutMs: timeout * 1000, onProgress: progress => {
          if (flags.json) return;
          const fraction = progress.total ? Math.floor(10 * progress.completed / progress.total) : 0;
          if (fraction !== lastProgress || progress.phase === 'finalizing') { lastProgress = fraction; io.stderr(`${progress.phase}: ${progress.completed}/${progress.total}\n`); }
        } });
        const output = await atomicWrite(destination, media.bytes);
        return { command: key, result: { mime: media.mime, bytes: media.bytes.byteLength, frameCount: media.frameCount, duration: media.duration, includesAudio: media.includesAudio, progress: media.progress, ...output } };
      } finally { job.close(); }
    }
    case 'project export':
    case 'project web': {
      allowed(flags, ['format', 'timeout', 'output', 'json']); noExtra(positionals, 3);
      const format = option(flags, 'format') ?? 'web';
      if (format !== 'web') throw new CliFailure('INVALID_ARGUMENT', 'Use --format web for a standalone Hyde web package.', 2);
      const project = await projectFrom(input(positionals, 2, 'Project archive'));
      const destination = option(flags, 'output', true)!;
      const timeout = numeric(flags, 'timeout', 1800)!;
      if (timeout < 1 || timeout > 3600) throw new CliFailure('INVALID_ARGUMENT', '--timeout must be between 1 and 3600 seconds.', 2);
      const job = browserJobSignal();
      try {
        const packageResult = await runBrowserTask(project, { kind: 'web' }, { signal: job.signal, timeoutMs: timeout * 1000 });
        const output = await atomicWrite(destination, packageResult.bytes);
        return { command: key, result: { mime: packageResult.mime, bytes: packageResult.bytes.byteLength, nativeSource: 'source.hyde', ...output } };
      } finally { job.close(); }
    }
    case 'doctor': {
      allowed(flags, ['json']); noExtra(positionals, 1);
      const session = HydeAuthoringSession.create();
      const capabilities = session.capabilities('node');
      return { command: key, result: { node: process.version, capabilities, browserHost: await probeBrowserHost(session.snapshot()) } };
    }
    default: throw new CliFailure('OPERATION_UNSUPPORTED', 'Unknown command. Use project new/validate/inspect/apply/diff/preview/render/export, assembly inspect/validate/export/import, or doctor.', 2);
  }
}

function cleanError(error: unknown): { code: string; message: string; exitCode: ExitCode; transaction?: CliFailure['transaction'] } {
  if (error instanceof CliFailure) return { code: error.code, message: error.message, exitCode: error.exitCode, transaction: error.transaction };
  if (error instanceof BrowserHostError) return { code: error.code, message: error.message, exitCode: error.code === 'CANCELED' ? 7 : error.code === 'CAPABILITY_UNAVAILABLE' ? 5 : error.code === 'INVALID_ARGUMENT' ? 2 : 6 };
  if (error instanceof Error && (error as NodeJS.ErrnoException).code) return { code: 'INVALID_ARGUMENT', message: `Filesystem operation failed (${(error as NodeJS.ErrnoException).code}).`, exitCode: 2 };
  return { code: 'INTERNAL_ERROR', message: 'Unexpected CLI failure.', exitCode: 6 };
}
export async function runCli(args: string[], io: Output = { stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) }): Promise<ExitCode> {
  const json = args.includes('--json');
  try {
    const response = await dispatch(args, io);
    const text = json ? JSON.stringify({ ok: true, ...response }) : JSON.stringify(response.result, null, 2);
    io.stdout(`${text}\n`);
    return 0;
  } catch (error) {
    const failure = cleanError(error);
    const text = json ? JSON.stringify({ ok: false,
      ...(failure.transaction ? { revision: failure.transaction.revision } : {}),
      errors: failure.transaction?.errors ?? [{ code: failure.code, severity: 'error', message: failure.message }],
      warnings: failure.transaction?.warnings ?? [],
    }) : `${failure.code}: ${failure.message}`;
    io.stderr(`${text}\n`);
    return failure.exitCode;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void runCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
