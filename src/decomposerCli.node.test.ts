// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runDecomposerCli } from './decomposerCli';
import { encodePng } from './decomposer/image';
import { DecompositionSession } from './decomposer/session';
import { decodeProjectBytes } from './archive';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

async function run(args: string[]) {
  const out: string[] = [], errors: string[] = [];
  const exit = await runDecomposerCli(args, { stdout: text => out.push(text), stderr: text => errors.push(text) });
  return { exit, result: out.length ? JSON.parse(out.join('')) : undefined, error: errors.length ? JSON.parse(errors.join('')) : undefined };
}

describe('hyde-decompose CLI', () => {
  it('imports, analyzes, inspects, edits, compares and exports without losing a recoverable document', async () => {
    const folder = await mkdtemp(join(process.cwd(), '.hyde-decompose-cli-')); folders.push(folder);
    const pixels = new Uint8Array(32 * 32 * 4);
    for (let y = 3; y < 14; y++) for (let x = 3; x < 14; x++) pixels.set([235, 66, 45, 255], (y * 32 + x) * 4);
    for (let y = 17; y < 28; y++) for (let x = 17; x < 28; x++) pixels.set([40, 100, 225, 255], (y * 32 + x) * 4);
    const source = join(folder, 'reference.png'), document = join(folder, 'drawing.hydecomp'), native = join(folder, 'drawing.hyde');
    await writeFile(source, encodePng({ width: 32, height: 32, rgba: pixels }));
    const imported = await run(['import', '--source', source, '--output', document, '--json']);
    expect(imported.exit, JSON.stringify(imported.error)).toBe(0);
    const analyzed = await run(['analyze', document, '--output', document, '--overwrite', '--json']);
    expect(analyzed.exit).toBe(0);
    expect(analyzed.result.regionCount).toBeGreaterThan(1);
    expect(analyzed.result.revision).toBe(1);
    const inspected = await run(['inspect', document, '--target', 'regions', '--json']);
    expect(inspected.result.result.items).toHaveLength(analyzed.result.regionCount);
    expect((await run(['compare', document, '--json'])).result.result.regionCount).toBe(analyzed.result.regionCount);

    const session = await DecompositionSession.openDocument(await readFile(document));
    expect(session.revision).toBe(1);
    const firstPart = session.snapshot().parts[0].id;
    await session.close();
    const request = join(folder, 'edit.json');
    await writeFile(request, JSON.stringify({ expectedRevision: 1, edits: [{ op: 'part.rename', partId: firstPart, name: 'Edited part' }] }));
    const unchanged = await readFile(document);
    const refused = await run(['edit', document, '--request', request, '--output', document, '--json']);
    expect(refused.exit).not.toBe(0);
    expect(refused.error.errors[0].code).toBe('OUTPUT_EXISTS');
    expect(await readFile(document)).toEqual(unchanged);
    const edited = await run(['edit', document, '--request', request, '--output', document, '--overwrite', '--json']);
    expect(edited.exit).toBe(0);
    expect(edited.result.revision).toBe(2);
    expect((await readdir(folder)).some(name => name.includes('.bak'))).toBe(true);
    const reopened = await DecompositionSession.openDocument(await readFile(document));
    expect(reopened.revision).toBe(2);
    expect(reopened.snapshot().parts.find(item => item.id === firstPart)?.name).toBe('Edited part');
    await reopened.close();

    const exported = await run(['export', document, '--format', 'hyde', '--output', native, '--json']);
    expect(exported.exit).toBe(0);
    const project = decodeProjectBytes(await readFile(native));
    expect(project.elements.filter(element => element.kind === 'polygon').length).toBeGreaterThan(1);
  });

  (process.env.HYDE_TEST_BROWSER ? it : it.skip)('compares an actual Hyde-rendered native frame and writes a residual overlay', async () => {
    const folder = await mkdtemp(join(process.cwd(), '.hyde-decompose-native-')); folders.push(folder);
    const rgba = new Uint8Array(24 * 24 * 4);
    for (let y = 4; y < 20; y++) for (let x = 4; x < 20; x++) rgba.set([220, 75, 50, 255], (y * 24 + x) * 4);
    const source = join(folder, 'source.png'), document = join(folder, 'drawing.hydecomp'), overlay = join(folder, 'residual.png');
    await writeFile(source, encodePng({ width: 24, height: 24, rgba }));
    expect((await run(['import', '--source', source, '--output', document, '--json'])).exit).toBe(0);
    expect((await run(['analyze', document, '--output', document, '--overwrite', '--json'])).exit).toBe(0);
    const comparison = await run(['compare', document, '--native', '--overlay', overlay, '--json']);
    expect(comparison.exit, JSON.stringify(comparison.error)).toBe(0);
    expect(comparison.result.result.silhouette.iou).toBeGreaterThan(.95);
    expect(comparison.result.result.complexity.activeRegionCount).toBe(1);
    expect(Array.from((await readFile(overlay)).subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(JSON.stringify(comparison.result)).not.toContain('residualOverlayPng');
  }, 60_000);
});
