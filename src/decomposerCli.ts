import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, readLimitedFile } from './atomicFile';
import { launchLocalChromium, runBrowserTask } from './cliBrowserRunner';
import { DecompositionSession } from './decomposer/session';
import { compareNativeRender } from './decomposer/quality';
import type { Box, DecompositionEdit, DecompositionMode, DiagnosticTileView, SourceInput, SourceRole } from './decomposer';

type Flags = Record<string, string | true>;
type IO = { stdout(text: string): void; stderr(text: string): void };
type Request = Record<string, unknown>;
const DOCUMENT_LIMIT = 256 * 1024 * 1024;
const IMAGE_LIMIT = 128 * 1024 * 1024;

class CliError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = 2) { super(message); }
}

function parse(argv: string[]): { command: string; args: string[]; flags: Flags } {
  const [command, ...rest] = argv, args: string[] = [], flags: Flags = {};
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (!token.startsWith('--')) { args.push(token); continue; }
    const name = token.slice(2);
    if (!name || Object.hasOwn(flags, name)) throw new CliError('INVALID_ARGUMENT', `Duplicate or invalid --${name}.`);
    if (['json', 'overwrite', 'dry-run', 'native', 'allow-hole-approximation'].includes(name)) flags[name] = true;
    else {
      const value = rest[++index];
      if (!value || value.startsWith('--')) throw new CliError('INVALID_ARGUMENT', `--${name} requires a value.`);
      flags[name] = value;
    }
  }
  return { command, args, flags };
}
function allow(flags: Flags, names: string[]): void {
  const unknown = Object.keys(flags).find(name => !names.includes(name));
  if (unknown) throw new CliError('INVALID_ARGUMENT', `Unknown --${unknown}.`);
}
function value(flags: Flags, name: string, required = false): string | undefined {
  const result = flags[name];
  if (result === true || required && !result) throw new CliError('INVALID_ARGUMENT', `--${name} requires a value.`);
  return result;
}
function positional(args: string[], count: number): string[] {
  if (args.length !== count) throw new CliError('INVALID_ARGUMENT', `Expected ${count} positional argument${count === 1 ? '' : 's'}.`);
  return args;
}
function mode(text: unknown): DecompositionMode | undefined {
  if (text === undefined) return undefined;
  if (text !== 'appearance' && text !== 'animation-ready') throw new CliError('INVALID_ARGUMENT', 'Mode must be appearance or animation-ready.');
  return text;
}
function tileBounds(text: string | undefined): Box | undefined {
  if (text === undefined) return undefined;
  if (!/^\d+,\d+,\d+,\d+$/.test(text)) throw new CliError('INVALID_ARGUMENT', '--bounds must be x,y,width,height in integer source pixels.');
  const [x, y, width, height] = text.split(',').map(Number);
  if (![x, y, width, height].every(Number.isSafeInteger)) throw new CliError('INVALID_ARGUMENT', '--bounds contains an unsafe integer.');
  return { x, y, width, height };
}
function extensionMime(path: string): SourceInput['mime'] {
  const ext = extname(path).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  throw new CliError('UNSUPPORTED_SOURCE', 'Source must be PNG, JPEG or WebP.');
}
async function jsonFile(path: string): Promise<Request> {
  const bytes = await readLimitedFile(path, 2 * 1024 * 1024);
  const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new CliError('INVALID_ARGUMENT', 'Request must be a JSON object.');
  return result as Request;
}
async function browserDecode(bytes: Uint8Array, mime: string): Promise<SourceInput['decoded']> {
  if (bytes.length > 32 * 1024 * 1024) throw new CliError('RESOURCE_LIMIT', 'JPEG/WebP source exceeds the 32 MiB browser decode limit.');
  let browser;
  try { browser = await launchLocalChromium(); }
  catch (error) { throw new CliError('CAPABILITY_UNAVAILABLE', error instanceof Error ? error.message : 'Local Chromium is unavailable.', 5); }
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(async ({ base64, type }) => {
      const binary = atob(base64), data = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
      const blob = new Blob([data], { type });
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image', colorSpaceConversion: 'default' });
      try {
        if (bitmap.width * bitmap.height > 4_000_000) throw new Error('IMAGE_TOO_LARGE');
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Canvas 2D is unavailable.');
        context.drawImage(bitmap, 0, 0);
        return { width: bitmap.width, height: bitmap.height, rgba: Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data) };
      } finally { bitmap.close(); }
    }, { base64: Buffer.from(bytes).toString('base64'), type: mime });
    return { width: result.width, height: result.height, rgba: Uint8Array.from(result.rgba) };
  } finally { await browser.close(); }
}
async function source(spec: { path: string; name?: string; role?: SourceRole }): Promise<SourceInput> {
  const bytes = await readLimitedFile(spec.path, IMAGE_LIMIT), mime = extensionMime(spec.path);
  return { bytes, mime, name: spec.name ?? basename(spec.path), role: spec.role, ...(mime !== 'image/png' ? { decoded: await browserDecode(bytes, mime) } : {}) };
}
async function openDocument(path: string): Promise<DecompositionSession> {
  try { return await DecompositionSession.openDocument(await readLimitedFile(path, DOCUMENT_LIMIT)); }
  catch (error) {
    const message = error instanceof Error && !('path' in error) ? error.message : 'Could not open the decomposition document.';
    throw new CliError('INVALID_DOCUMENT', message, 3);
  }
}
async function save(path: string, bytes: Uint8Array, flags: Flags) {
  return atomicWrite(path, bytes, flags.overwrite ? 'backup' : 'fail');
}
async function dispatch(argv: string[]): Promise<Record<string, unknown>> {
  const { command, args, flags } = parse(argv);
  if (command === 'import') {
    allow(flags, ['source', 'request', 'output', 'mode', 'name', 'overwrite', 'json']); positional(args, 0);
    if (Boolean(flags.source) === Boolean(flags.request)) throw new CliError('INVALID_ARGUMENT', 'Give one --source image or one --request manifest.');
    const request = flags.request ? await jsonFile(value(flags, 'request', true)!) : {};
    const specs = flags.source ? [{ path: value(flags, 'source', true)! }] : request.sources;
    if (!Array.isArray(specs) || !specs.length || specs.length > 32 || specs.some(item => !item || typeof item.path !== 'string')) throw new CliError('INVALID_ARGUMENT', 'Manifest sources must list 1 to 32 image paths.');
    const inputs = await Promise.all(specs.map(item => source(item)));
    const session = await DecompositionSession.importSources(inputs, { mode: mode(value(flags, 'mode') ?? request.mode), name: value(flags, 'name') ?? (typeof request.name === 'string' ? request.name : undefined) });
    try {
      const output = await save(value(flags, 'output', true)!, await session.saveDocument(), flags);
      return { command, revision: session.revision, summary: session.inspect({ target: 'summary' }), ...output };
    } finally { await session.close(); }
  }
  if (command === 'analyze') {
    allow(flags, ['output', 'mode', 'overwrite', 'json']);
    const [path] = positional(args, 1), session = await openDocument(path);
    try {
      const analysis = await session.analyze({ mode: mode(value(flags, 'mode')) });
      const output = await save(value(flags, 'output', true)!, await session.saveDocument(), flags);
      return { command, ...analysis, ...output };
    } finally { await session.close(); }
  }
  if (command === 'inspect') {
    allow(flags, ['target', 'id', 'limit', 'cursor', 'view', 'source', 'region', 'bounds', 'output', 'overwrite', 'json']);
    const [path] = positional(args, 1), session = await openDocument(path);
    try {
      const target = value(flags, 'target') ?? 'summary';
      if (target === 'tile') {
        if (flags.id || flags.limit || flags.cursor) throw new CliError('INVALID_ARGUMENT', 'Tile inspection uses --source, --region and --bounds.');
        const view = value(flags, 'view') ?? 'source';
        if (!['source', 'mask', 'evidence'].includes(view)) throw new CliError('INVALID_ARGUMENT', 'Tile view must be source, mask or evidence.');
        const tile = session.renderDiagnosticTile({ view: view as DiagnosticTileView,
          sourceId: value(flags, 'source'), regionId: value(flags, 'region'), bounds: tileBounds(value(flags, 'bounds')) });
        const { bytes, ...metadata } = tile;
        const output = await save(value(flags, 'output', true)!, bytes, flags);
        return { command, result: { ...metadata, byteLength: bytes.length }, ...output };
      }
      if (flags.view || flags.source || flags.region || flags.bounds || flags.output || flags.overwrite)
        throw new CliError('INVALID_ARGUMENT', 'Tile flags require --target tile.');
      if (!['summary', 'sources', 'regions', 'parts', 'region', 'part', 'diagnostics', 'correspondences'].includes(target)) throw new CliError('INVALID_ARGUMENT', 'Unknown inspection target.');
      if ((target === 'region' || target === 'part') && !value(flags, 'id')) throw new CliError('INVALID_ARGUMENT', `--id is required for ${target} inspection.`);
      const limit = value(flags, 'limit'), cursor = value(flags, 'cursor');
      const result = session.inspect({ target: target as Parameters<typeof session.inspect>[0]['target'], id: value(flags, 'id'), limit: limit ? Number(limit) : undefined, cursor: cursor ? Number(cursor) : undefined });
      if ('error' in result && result.error) throw new CliError(result.error.code, result.error.message);
      return { command, result };
    } finally { await session.close(); }
  }
  if (command === 'edit') {
    allow(flags, ['request', 'output', 'overwrite', 'dry-run', 'json']);
    const [path] = positional(args, 1), request = await jsonFile(value(flags, 'request', true)!);
    if (!Array.isArray(request.edits)) throw new CliError('INVALID_ARGUMENT', 'Request needs an edits array.');
    const session = await openDocument(path);
    try {
      const handles = new Map<string, string>();
      if (request.masks !== undefined) {
        if (!Array.isArray(request.masks)) throw new CliError('INVALID_ARGUMENT', 'Request masks must be an array.');
        for (const item of request.masks) {
          if (!item || typeof item.name !== 'string' || typeof item.path !== 'string' || !Number.isInteger(item.width) || !Number.isInteger(item.height) || item.alphaPath !== undefined && typeof item.alphaPath !== 'string') throw new CliError('INVALID_ARGUMENT', 'Each mask needs name, path, width and height; alphaPath is an optional 0–255 coverage file.');
          handles.set(item.name, session.stageMask({ width: item.width, height: item.height, bytes: await readLimitedFile(item.path, 4_000_000),
            ...(item.alphaPath ? { alpha: await readLimitedFile(item.alphaPath, 4_000_000) } : {}) }));
        }
      }
      const edits = (request.edits as DecompositionEdit[]).map(item => item.op === 'region.refineMask' && handles.has(item.handle) ? { ...item, handle: handles.get(item.handle)! } : item);
      const expectedRevision = request.expectedRevision;
      if (!Number.isInteger(expectedRevision)) throw new CliError('INVALID_ARGUMENT', 'Request needs integer expectedRevision.');
      const result = await session.execute({ expectedRevision: expectedRevision as number, edits, dryRun: Boolean(flags['dry-run']) });
      if (!result.ok) throw new CliError(result.error?.code ?? 'EDIT_FAILED', result.error?.message ?? 'Edit failed.', 4);
      if (flags['dry-run']) return { command, dryRun: true, ...result };
      const output = await save(value(flags, 'output', true)!, await session.saveDocument(), flags);
      return { command, ...result, ...output };
    } finally { await session.close(); }
  }
  if (command === 'compare') {
    allow(flags, ['json', 'native', 'overlay', 'allow-hole-approximation', 'overwrite']);
    const [path] = positional(args, 1), session = await openDocument(path);
    try {
      if (!flags.native) {
        if (flags.overlay || flags['allow-hole-approximation']) throw new CliError('INVALID_ARGUMENT', '--overlay and --allow-hole-approximation require --native.');
        return { command, result: session.compare() };
      }
      const document = session.snapshot(), primary = document.sources.find(source => source.role === 'primary');
      if (!primary) throw new CliError('INVALID_DOCUMENT', 'Primary source is missing.', 3);
      const native = await session.exportHyde({ format: 'hyde', allowHoleApproximation: Boolean(flags['allow-hole-approximation']) });
      const frame = await runBrowserTask(native.project, { kind: 'preview', options: { timeSeconds: 0, width: primary.width, height: primary.height, format: 'png' } });
      const { residualOverlayPng, ...result } = compareNativeRender(session.sourcePixelsFor(primary.id), frame.bytes, document);
      const overlay = flags.overlay ? await save(value(flags, 'overlay', true)!, residualOverlayPng, flags) : undefined;
      return { command, result, warnings: native.warnings, ...(overlay ? { overlay } : {}) };
    }
    finally { await session.close(); }
  }
  if (command === 'export') {
    allow(flags, ['format', 'output', 'name', 'allow-hole-approximation', 'overwrite', 'json']);
    const [path] = positional(args, 1), format = value(flags, 'format', true);
    if (format !== 'hyde' && format !== 'hyproj') throw new CliError('INVALID_ARGUMENT', 'Format must be hyde or hyproj.');
    const session = await openDocument(path);
    try {
      const result = await session.exportHyde({ format, name: value(flags, 'name'), allowHoleApproximation: Boolean(flags['allow-hole-approximation']) });
      const output = await save(value(flags, 'output', true)!, result.bytes, flags);
      return { command, format, warnings: result.warnings, mapping: result.mapping, ...output };
    } finally { await session.close(); }
  }
  throw new CliError('INVALID_ARGUMENT', 'Use import, analyze, inspect, edit, compare or export.');
}

export async function runDecomposerCli(argv: string[], io: IO = { stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) }): Promise<number> {
  try {
    const result = await dispatch(argv);
    io.stdout(`${JSON.stringify({ ok: true, ...result }, null, argv.includes('--json') ? 0 : 2)}\n`);
    return 0;
  } catch (error) {
    const fileError = error && typeof error === 'object' && 'path' in error;
    const code = fileError ? 'FILE_IO' : error instanceof CliError ? error.code : error instanceof Error && /^[A-Z_]+:/.test(error.message) ? error.message.split(':')[0] : 'DECOMPOSER_ERROR';
    const message = fileError ? 'Could not access the requested file.' : error instanceof Error ? error.message : 'Unknown decomposer failure.';
    io.stderr(`${JSON.stringify({ ok: false, errors: [{ code, severity: 'error', message }] })}\n`);
    return error instanceof CliError ? error.exitCode : 3;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void runDecomposerCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
