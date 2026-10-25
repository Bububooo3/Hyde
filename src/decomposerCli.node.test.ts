// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runDecomposerCli } from './decomposerCli';
import { decodePng, encodePng } from './decomposer/image';
import { DecompositionSession } from './decomposer/session';
import { decodeAssemblyBytes, decodeProjectBytes } from './archive';
import { launchLocalChromium } from './cliBrowserRunner';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

async function run(args: string[]) {
  const out: string[] = [], errors: string[] = [];
  const exit = await runDecomposerCli(args, { stdout: text => out.push(text), stderr: text => errors.push(text) });
  return { exit, result: out.length ? JSON.parse(out.join('')) : undefined, error: errors.length ? JSON.parse(errors.join('')) : undefined };
}

describe('hyde-decompose CLI', () => {
  it('reviews and replaces only the selected existing assembly with an exact fingerprint', async () => {
    const folder = await mkdtemp(join(process.cwd(), '.hyde-decompose-replace-')); folders.push(folder);
    const rgba = new Uint8Array(24 * 24 * 4);
    for (let y = 4; y < 20; y++) for (let x = 4; x < 20; x++) rgba.set([185, 68, 42, 255], (y * 24 + x) * 4);
    const source = join(folder, 'icon.png'), document = join(folder, 'icon.hydecomp'), target = join(folder, 'icon.hyproj');
    await writeFile(source, encodePng({ width: 24, height: 24, rgba }));
    expect((await run(['import', '--source', source, '--output', document])).exit).toBe(0);
    expect((await run(['analyze', document, '--output', document, '--overwrite'])).exit).toBe(0);
    expect((await run(['export', document, '--format', 'hyproj', '--output', target])).exit).toBe(0);
    const original = await readFile(target);
    const session = await DecompositionSession.openDocument(await readFile(document));
    const part = session.snapshot().parts[0];
    expect((await session.execute({ expectedRevision: session.revision, edits: [
      { op: 'part.rename', partId: part.id, name: 'Revised section' },
    ] })).ok).toBe(true);
    await writeFile(document, await session.saveDocument()); await session.close();
    const planned = await run(['export', document, '--format', 'hyproj', '--target', target, '--dry-run', '--json']);
    expect(planned.exit, JSON.stringify(planned.error)).toBe(0);
    expect(planned.result.replacementImpact.replacedIds).toContain(`hc_${part.id}`);
    const fingerprint = planned.result.replacementImpact.targetFingerprint as string;
    const refused = await run(['export', document, '--format', 'hyproj', '--target', target, '--output', target, '--overwrite']);
    expect(refused.error.errors[0].code).toBe('REPLACEMENT_REQUIRES_CONFIRMATION');
    const changed = await run(['export', document, '--format', 'hyproj', '--target', target, '--output', target,
      '--overwrite', '--replace-existing', '--expected-target', '0'.repeat(64)]);
    expect(changed.error.errors[0].code).toBe('TARGET_CHANGED');
    expect(await readFile(target)).toEqual(original);
    const applied = await run(['export', document, '--format', 'hyproj', '--target', target, '--output', target,
      '--overwrite', '--replace-existing', '--expected-target', fingerprint, '--json']);
    expect(applied.exit, JSON.stringify(applied.error)).toBe(0);
    expect(applied.result.replacementImpact.targetFingerprint).toBe(fingerprint);
    expect(decodeAssemblyBytes(await readFile(target)).elements.find(item => item.id === `hc_${part.id}`)?.name).toBe('Revised section');
    expect((await readdir(folder)).some(name => name.includes('.bak'))).toBe(true);
  });
  it('accepts a soft coverage file alongside an editable binary mask', async () => {
    const folder = await mkdtemp(join(process.cwd(), '.hyde-decompose-soft-')); folders.push(folder);
    const rgba = new Uint8Array(16 * 16 * 4);
    for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) rgba.set([180, 75, 55, 255], (y * 16 + x) * 4);
    const source = join(folder, 'source.png'), document = join(folder, 'source.hydecomp');
    await writeFile(source, encodePng({ width: 16, height: 16, rgba }));
    expect((await run(['import', '--source', source, '--output', document, '--json'])).exit).toBe(0);
    expect((await run(['analyze', document, '--output', document, '--overwrite', '--json'])).exit).toBe(0);
    const initial = await DecompositionSession.openDocument(await readFile(document));
    const region = initial.snapshot().regions[0], mask = initial.maskFor(region.maskId), revision = initial.revision;
    await initial.close();
    const alpha = Uint8Array.from(mask.bytes, value => value ? 255 : 0);
    const softPixel = Math.floor(mask.height / 2) * mask.width + Math.floor(mask.width / 2);
    alpha[softPixel] = 112;
    const path = join(folder, 'binary.raw'), alphaPath = join(folder, 'coverage.raw'), request = join(folder, 'edit.json');
    await writeFile(path, mask.bytes); await writeFile(alphaPath, alpha);
    await writeFile(request, JSON.stringify({ expectedRevision: revision, masks: [{ name: 'soft', path, alphaPath, width: mask.width, height: mask.height }],
      edits: [{ op: 'region.refineMask', regionId: region.id, handle: 'soft' }] }));
    const edited = await run(['edit', document, '--request', request, '--output', document, '--overwrite', '--json']);
    expect(edited.exit, JSON.stringify(edited.error)).toBe(0);
    const reopened = await DecompositionSession.openDocument(await readFile(document));
    const current = reopened.snapshot().regions.find(item => item.id === region.id)!;
    expect(reopened.maskFor(current.maskId).alpha?.[softPixel]).toBe(112);
    await reopened.close();
  });

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
    const regionId = inspected.result.result.items[0].id;
    const evidencePath = join(folder, 'evidence.png');
    const tile = await run(['inspect', document, '--target', 'tile', '--view', 'evidence', '--region', regionId,
      '--bounds', '0,0,16,16', '--output', evidencePath, '--json']);
    expect(tile.exit, JSON.stringify(tile.error)).toBe(0);
    expect(tile.result.result).toMatchObject({ regionId, mime: 'image/png', bounds: { x: 0, y: 0, width: 16, height: 16 } });
    expect(JSON.stringify(tile.result)).not.toContain('bytes');
    expect(decodePng(await readFile(evidencePath)).width).toBe(16);
    expect((await run(['inspect', document, '--target', 'region', '--id', 'missing', '--json'])).error.errors[0].code).toBe('TARGET_NOT_FOUND');
    expect((await run(['inspect', document, '--target', 'regions', '--limit', 'bad', '--json'])).error.errors[0].code).toBe('INVALID_ARGUMENT');
    expect((await run(['inspect', document, '--target', 'tile', '--view', 'mask', '--region', regionId,
      '--bounds', '0,0,513,1', '--output', join(folder, 'too-large.png'), '--json'])).error.errors[0].code).toBe('RESOURCE_LIMIT');
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

  (process.env.HYDE_TEST_BROWSER ? it : it.skip)('imports JPEG and WebP through local browser decode and reopens canonical pixels', async () => {
    const browser = await launchLocalChromium();
    let encoded: { jpeg: string; webp: string };
    try {
      const page = await browser.newPage();
      encoded = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 20;
        const context = canvas.getContext('2d')!;
        context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#d43b27'; context.fillRect(4, 3, 13, 14);
        return { jpeg: canvas.toDataURL('image/jpeg', .96), webp: canvas.toDataURL('image/webp', .96) };
      });
    } finally { await browser.close(); }
    const folder = await mkdtemp(join(process.cwd(), '.hyde-decompose-decode-')); folders.push(folder);
    for (const [kind, extension, mime] of [['jpeg', 'jpg', 'image/jpeg'], ['webp', 'webp', 'image/webp']] as const) {
      expect(encoded[kind].startsWith(`data:${mime};base64,`)).toBe(true);
      const sourceBytes = Buffer.from(encoded[kind].split(',')[1], 'base64');
      const source = join(folder, `source.${extension}`), document = join(folder, `source-${kind}.hydecomp`);
      await writeFile(source, sourceBytes);
      const imported = await run(['import', '--source', source, '--output', document, '--json']);
      expect(imported.exit, JSON.stringify(imported.error)).toBe(0);
      const first = await DecompositionSession.openDocument(await readFile(document));
      const sourceId = first.snapshot().sources[0].id, pixels = first.sourcePixelsFor(sourceId);
      expect(first.sourceBytesFor(sourceId)).toEqual(Uint8Array.from(sourceBytes));
      expect(pixels).toMatchObject({ width: 24, height: 20 });
      await first.close();
      expect((await run(['analyze', document, '--output', document, '--overwrite', '--json'])).exit).toBe(0);
      const reopened = await DecompositionSession.openDocument(await readFile(document));
      expect(reopened.sourcePixelsFor(sourceId).rgba).toEqual(pixels.rgba);
      expect(reopened.snapshot().regions.length).toBeGreaterThan(0);
      await reopened.close();
    }
  }, 90_000);
});
