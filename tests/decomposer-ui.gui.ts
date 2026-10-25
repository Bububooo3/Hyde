import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { decodeDecompositionDocument } from '../src/decomposer/codec';
import { encodePng } from '../src/decomposer/image';
import { DecompositionSession } from '../src/decomposer/session';
import { decodeAssemblyBytes } from '../src/archive';
import { makeRepeatedMultiviewFixture, makeSyntheticFixture } from './decomposerSyntheticFixtures';

function fixture(): Buffer {
  const width = 40, height = 32, rgba = new Uint8Array(width * height * 4);
  for (let y = 9; y < 23; y++) for (let x = 4; x < 20; x++) rgba.set([181, 54, 39, 255], (y * width + x) * 4);
  for (let y = 4; y < 27; y++) for (let x = 20; x < 33; x++) rgba.set([30, 111, 188, 255], (y * width + x) * 4);
  return Buffer.from(encodePng({ width, height, rgba }));
}

function opaqueFixture(): Buffer {
  const width = 24, height = 24, rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    rgba.set(x >= 8 && x < 16 && y >= 8 && y < 16 ? [184, 50, 38, 255] : [255, 255, 255, 255], (y * width + x) * 4);
  return Buffer.from(encodePng({ width, height, rgba }));
}

function occlusionStill(withFront: boolean): Uint8Array {
  const width = 48, height = 40, rgba = new Uint8Array(width * height * 4);
  for (let y = 6; y < 34; y++) for (let x = 6; x < 38; x++) rgba.set([186, 62, 39, 255], (y * width + x) * 4);
  if (withFront) for (let y = 6; y < 23; y++) for (let x = 19; x < 25; x++) rgba.set([33, 103, 182, 255], (y * width + x) * 4);
  return encodePng({ width, height, rgba });
}

test('reviews an earlier assembly before downloading a native replacement', async ({ page }) => {
  await page.goto('/decomposer.html');
  await page.getByLabel('Import images').setInputFiles({ name: 'replace.png', mimeType: 'image/png', buffer: fixture() });
  await expect(page.getByRole('status')).toContainText('Automatic first pass found 2 editable regions.');
  const firstDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const first = await firstDownload, firstBytes = await readFile(await first.path());
  const firstAssembly = decodeAssemblyBytes(firstBytes);
  await page.locator('.left-pane .scroll-list').first().locator('.row').first().click();
  const name = page.getByLabel('Part name');
  await name.fill('Revised arm'); await name.blur();
  await expect(page.getByRole('status')).toContainText('part.rename saved');
  await page.getByLabel('Review existing .hyproj').setInputFiles({ name: first.suggestedFilename(), mimeType: 'application/zip', buffer: firstBytes });
  const impact = page.getByLabel('Assembly replacement impact');
  await expect(impact).toContainText('Elements:');
  await expect(impact).toContainText('SHA-256:');
  const replacementDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download replacement .hyproj' }).click();
  const replacement = await replacementDownload;
  expect(replacement.suggestedFilename()).toBe(first.suggestedFilename());
  const updated = decodeAssemblyBytes(await readFile(await replacement.path()));
  expect(updated.elements.find(item => item.name === 'Revised arm')).toBeDefined();
  expect(firstAssembly.elements.some(item => item.id === updated.elements.find(element => element.name === 'Revised arm')?.id)).toBe(true);
  expect(firstAssembly.elements.some(item => item.name === 'Revised arm')).toBe(false);
  await expect(page.getByRole('status')).toContainText('selected source file remains available for recovery');
});

test('source diagnostics focus the relevant image for guided correction', async ({ page }) => {
  await page.goto('/decomposer.html');
  await page.getByLabel('Import images').setInputFiles({ name: 'small-character.png', mimeType: 'image/png', buffer: fixture() });
  await expect(page.getByRole('status')).toContainText('Automatic first pass found');
  await page.getByLabel('Reconstruction mode').selectOption('animation-ready');
  await expect(page.getByLabel('Regeneration impact preview')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm regeneration' }).click();
  await expect(page.getByRole('status')).toContainText('Switch to animation-ready applied');
  await page.getByRole('button', { name: 'Original', exact: true }).click();
  const warning = page.locator('.diagnostic.navigable').filter({ hasText: 'LOW_SOURCE_RESOLUTION' });
  await expect(warning).toBeVisible();
  await warning.click();
  await expect(page.getByLabel('Canvas zoom')).toHaveValue('2');
  await expect(page.getByRole('button', { name: 'Side by side' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status')).toContainText('Focused LOW_SOURCE_RESOLUTION on small-character.png');
});

test('region diagnostics switch references and select the affected editable region', async ({ page }) => {
  const width = 32, height = 32, rgba = new Uint8Array(width * height * 4);
  for (let y = 6; y < 26; y++) for (let x = 6; x < 26; x++)
    rgba.set([190, 60, 42, x === 6 || x === 25 || y === 6 || y === 25 ? 160 : 255], (y * width + x) * 4);
  const bytes = encodePng({ width, height, rgba });
  const session = await DecompositionSession.importSources([
    { name: 'front.png', mime: 'image/png', bytes }, { name: 'side.png', mime: 'image/png', bytes, role: 'alternate-view' },
  ], { settings: { preserveTexture: false } });
  await session.analyze();
  const document = session.snapshot();
  const side = document.sources.find(item => item.name === 'side.png')!;
  const target = document.diagnostics.find(item => item.code === 'TEXTURE_APPROXIMATION' && item.sourceId === side.id && item.regionId);
  expect(target?.regionId).toBeTruthy();
  const saved = await session.saveDocument(); await session.close();
  await page.goto('/decomposer.html');
  await page.getByLabel('Open .hydecomp').setInputFiles({ name: 'diagnostics.hydecomp', mimeType: 'application/zip', buffer: Buffer.from(saved) });
  await expect(page.getByRole('status')).toContainText('Opened diagnostics.hydecomp');
  const diagnostics = page.locator('.diagnostic.navigable');
  const index = document.diagnostics.indexOf(target!);
  await diagnostics.nth(index).click();
  await expect(page.getByRole('status')).toContainText('Focused TEXTURE_APPROXIMATION on side.png');
  await expect(page.locator('.left-pane .stack .row.selected')).toContainText('side.png');
  await expect(page.locator('.left-pane .scroll-list').first().locator('.row.selected')).toHaveCount(1);
});

test('1× reconstruction blends overlapping soft region masks', async ({ page }) => {
  const session = await DecompositionSession.importSources([{ name: 'soft-overlap.png', mime: 'image/png', bytes: fixture() }]);
  await session.analyze();
  const doc = session.snapshot();
  expect(doc.regions).toHaveLength(2);
  const lower = doc.regions[0], upper = doc.regions[1], lowerMask = session.maskFor(lower.maskId), upperMask = session.maskFor(upper.maskId);
  const local = lowerMask.bytes.findIndex((value, index) => {
    if (!value) return false;
    const px = lower.bounds.x + index % lowerMask.width, py = lower.bounds.y + Math.floor(index / lowerMask.width);
    return [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]].some(([nx, ny]) =>
      nx >= upper.bounds.x && ny >= upper.bounds.y && nx < upper.bounds.x + upperMask.width && ny < upper.bounds.y + upperMask.height &&
      upperMask.bytes[(ny - upper.bounds.y) * upperMask.width + nx - upper.bounds.x]);
  });
  expect(local).toBeGreaterThanOrEqual(0);
  const x = lower.bounds.x + local % lowerMask.width, y = lower.bounds.y + Math.floor(local / lowerMask.width);
  const width = doc.sources[0].width, height = doc.sources[0].height;
  const bytes = new Uint8Array(width * height), alpha = new Uint8Array(width * height);
  for (let row = 0; row < upperMask.height; row++) for (let column = 0; column < upperMask.width; column++) {
    const old = row * upperMask.width + column, at = (upper.bounds.y + row) * width + upper.bounds.x + column;
    bytes[at] = upperMask.bytes[old]; alpha[at] = upperMask.bytes[old] ? 255 : 0;
  }
  bytes[y * width + x] = 1; alpha[y * width + x] = 128;
  const handle = session.stageMask({ width, height, bytes, alpha });
  const edited = await session.execute({ expectedRevision: session.revision, edits: [
    { op: 'region.refineMask', regionId: upper.id, handle, bounds: { x: 0, y: 0, width, height } },
  ] });
  expect(edited.ok, JSON.stringify(edited)).toBe(true);
  const saved = await session.saveDocument(); await session.close();
  await page.goto('/decomposer.html');
  await page.getByLabel('Open .hydecomp').setInputFiles({ name: 'soft-overlap.hydecomp', mimeType: 'application/zip', buffer: Buffer.from(saved) });
  await expect(page.getByRole('status')).toContainText('Opened soft-overlap.hydecomp');
  await page.getByRole('button', { name: 'Reconstruction', exact: true }).click();
  await page.getByLabel('Canvas zoom').selectOption('1');
  const pixel = await page.locator('canvas.interactive-canvas').evaluate((canvas, position) =>
    [...(canvas as HTMLCanvasElement).getContext('2d')!.getImageData(position.x, position.y, 1, 1).data], { x, y });
  const bottom = [1, 3, 5].map(at => parseInt(lower.color.slice(at, at + 2), 16));
  const top = [1, 3, 5].map(at => parseInt(upper.color.slice(at, at + 2), 16));
  for (let channel = 0; channel < 3; channel++) expect(pixel[channel]).toBeCloseTo((bottom[channel] * 127 + top[channel] * 128) / 255, 0);
  expect(pixel[3]).toBe(255);
});

test('JPEG and WebP import in the analysis worker and reopen with canonical pixels', async ({ page }) => {
  await page.goto('/decomposer.html');
  const png = [...fixture()];
  for (const [mime, extension] of [['image/jpeg', 'jpg'], ['image/webp', 'webp']] as const) {
    const encoded = await page.evaluate(async ({ png, mime }) => {
      const image = await createImageBitmap(new Blob([new Uint8Array(png)], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      canvas.getContext('2d')!.drawImage(image, 0, 0); image.close();
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Encoding failed')), mime, 1));
      if (blob.type !== mime) throw new Error(`${mime} encoding is unavailable in this browser.`);
      return [...new Uint8Array(await blob.arrayBuffer())];
    }, { png, mime });
    await page.getByLabel('Import images').setInputFiles({ name: `two-piece.${extension}`, mimeType: mime, buffer: Buffer.from(encoded) });
    await expect(page.getByRole('status')).toContainText('Automatic first pass found', { timeout: 30_000 });
    await expect(page.locator('.left-pane .scroll-list').first().locator('.row')).not.toHaveCount(0);
    const saving = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save source' }).click();
    const saved = await decodeDecompositionDocument(new Uint8Array(await readFile(await (await saving).path())));
    expect(saved.document.sources[0]).toMatchObject({ mime, width: 40, height: 32 });
    expect(saved.sourceBytes.get(saved.document.sources[0].id)).toEqual(new Uint8Array(encoded));
    const pixels = saved.pixels.get(saved.document.sources[0].id)!;
    expect(pixels.length).toBe(40 * 32 * 4);
    await page.getByRole('button', { name: 'Original', exact: true }).click();
    const displayed = await page.locator('.canvas-card canvas').first().evaluate(canvas =>
      [...(canvas as HTMLCanvasElement).getContext('2d')!.getImageData(10, 12, 1, 1).data]);
    expect(displayed).toEqual([...pixels.subarray((12 * 40 + 10) * 4, (12 * 40 + 10) * 4 + 4)]);
    await page.getByLabel('Open .hydecomp').setInputFiles({ name: `two-piece.${extension}.hydecomp`, mimeType: 'application/zip', buffer: Buffer.from(await readFile(await (await saving).path())) });
    await expect(page.locator('.left-pane .scroll-list').first().locator('.row')).not.toHaveCount(0);
    const reopening = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save source' }).click();
    const reopened = await decodeDecompositionDocument(new Uint8Array(await readFile(await (await reopening).path())));
    expect(reopened.pixels.get(reopened.document.sources[0].id)).toEqual(pixels);
  }
});

test('EXIF-rotated JPEG stores oriented canonical pixels and untouched original bytes', async ({ page }) => {
  await page.goto('/decomposer.html');
  const jpeg = Uint8Array.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 16;
    const context = canvas.getContext('2d')!;
    for (const [x, y, fill] of [[0, 0, '#ff0000'], [12, 0, '#00ff00'], [0, 8, '#0000ff'], [12, 8, '#ffff00']] as const) {
      context.fillStyle = fill; context.fillRect(x, y, 12, 8);
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('JPEG encoding failed')), 'image/jpeg', 1));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }));
  const exif = Uint8Array.from([0xff, 0xe1, 0, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0,
    0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
  const oriented = Uint8Array.from([...jpeg.subarray(0, 2), ...exif, ...jpeg.subarray(2)]);
  await page.getByLabel('Import images').setInputFiles({ name: 'rotated.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(oriented) });
  await expect(page.getByRole('status')).toContainText('Automatic first pass found', { timeout: 30_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save source' }).click();
  const documentBytes = new Uint8Array(await readFile(await (await download).path()));
  const saved = await decodeDecompositionDocument(documentBytes);
  const source = saved.document.sources[0], rgba = saved.pixels.get(source.id)!;
  expect([source.width, source.height]).toEqual([16, 24]);
  expect(saved.sourceBytes.get(source.id)).toEqual(oriented);
  const sample = (x: number, y: number) => [...rgba.subarray((y * source.width + x) * 4, (y * source.width + x) * 4 + 3)];
  expect(sample(3, 3)[2]).toBeGreaterThan(180); // original bottom-left blue rotates to top-left
  expect(sample(12, 3)[0]).toBeGreaterThan(180); // original top-left red rotates to top-right
  expect(sample(3, 20)[0]).toBeGreaterThan(180); // original bottom-right yellow rotates to bottom-left
  expect(sample(12, 20)[1]).toBeGreaterThan(180); // original top-right green rotates to bottom-right
  const reopened = await DecompositionSession.openDocument(documentBytes);
  const native = await reopened.exportHyde({ format: 'hyde' });
  expect([native.project.width, native.project.height]).toEqual([16, 24]);
  expect(native.project.elements.filter(item => item.shapePath).length).toBeGreaterThan(1);
  await reopened.close();
});

test('inspector shifts a whole contour in source pixels and undoes the pinned edit', async ({ page }) => {
  await page.goto('/decomposer.html');
  await page.getByLabel('Import images').setInputFiles({ name: 'prop.png', mimeType: 'image/png', buffer: fixture() });
  await expect(page.getByRole('status')).toContainText('Automatic first pass found');
  const beforeDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save source' }).click();
  const before = await decodeDecompositionDocument(new Uint8Array(await readFile(await (await beforeDownload).path())));
  const region = before.document.regions[0];
  await page.locator('.left-pane .scroll-list').first().locator('.row').first().click();
  await page.getByLabel('Contour shift X').fill('2');
  await page.getByLabel('Contour shift Y').fill('-1');
  await page.getByRole('button', { name: 'Shift and pin contour' }).click();
  await expect(page.getByRole('status')).toContainText('region.offsetPath saved');
  const afterDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save source' }).click();
  const after = await decodeDecompositionDocument(new Uint8Array(await readFile(await (await afterDownload).path())));
  const shifted = after.document.regions.find(item => item.id === region.id)!;
  expect(shifted.geometry.manualPath).toBeDefined();
  expect(shifted.geometry.manualPath!.points[0].x - region.geometry.generatedPath.points[0].x).toBeCloseTo(2 / region.bounds.width);
  expect(shifted.geometry.manualPath!.points[0].y - region.geometry.generatedPath.points[0].y).toBeCloseTo(-1 / region.bounds.height);
  expect(after.masks.get(shifted.maskId)).toEqual(before.masks.get(region.maskId));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Undo applied');
  const undoDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save source' }).click();
  const undone = await decodeDecompositionDocument(new Uint8Array(await readFile(await (await undoDownload).path())));
  expect(undone.document.regions.find(item => item.id === region.id)?.geometry.manualPath).toBeUndefined();
});

test('cancel during file read cannot import into the restarted worker', async ({ page }) => {
  await page.goto('/decomposer.html');
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name !== 'slow.png') return read.call(this);
      return new Promise<ArrayBuffer>(resolve => {
        (window as Window & { releaseSlowRead?: () => Promise<void> }).releaseSlowRead = async () => resolve(await read.call(this));
      });
    };
  });
  await page.getByLabel('Import images').setInputFiles({ name: 'slow.png', mimeType: 'image/png', buffer: fixture() });
  await expect(page.getByRole('status')).toContainText('Importing original references');
  await page.getByRole('button', { name: 'Cancel and restore' }).click();
  await expect(page.getByRole('status')).toContainText('last complete document has been restored');
  await page.evaluate(async () => { await (window as Window & { releaseSlowRead: () => Promise<void> }).releaseSlowRead(); });
  await expect(page.getByRole('heading', { name: 'Turn illustrations into editable Hyde art' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save source' })).toBeDisabled();
  await page.getByLabel('Import images').setInputFiles({ name: 'prop.png', mimeType: 'image/png', buffer: fixture() });
  await expect(page.getByRole('status')).toContainText('Automatic first pass found');
  await expect(page.locator('.left-pane .scroll-list').first().locator('.row')).toHaveCount(2);
  await page.getByLabel('Import images').setInputFiles({ name: 'slow.png', mimeType: 'image/png', buffer: opaqueFixture() });
  await expect(page.getByRole('status')).toContainText('Importing original references');
  await page.getByRole('button', { name: 'Cancel and restore' }).click();
  await expect(page.getByRole('status')).toContainText('last complete document has been restored');
  await page.evaluate(async () => { await (window as Window & { releaseSlowRead: () => Promise<void> }).releaseSlowRead(); });
  await expect(page.locator('.left-pane .scroll-list').first().locator('.row')).toHaveCount(2);
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save source' }).click();
  const reopened = await decodeDecompositionDocument(new Uint8Array(await readFile(await (await saved).path())));
  expect(reopened.document.sources[0].name).toBe('prop.png');
  expect(reopened.document.regions.filter(item => item.generationStatus !== 'historical')).toHaveLength(2);
});

test('a hidden region can use explicitly matched alternate pixels and undo that choice', async ({ page }) => {
  const session = await DecompositionSession.importSources([
    { bytes: occlusionStill(true), name: 'primary.png', mime: 'image/png', role: 'primary' },
    { bytes: occlusionStill(false), name: 'alternate.png', mime: 'image/png', role: 'alternate-pose' },
  ], { mode: 'animation-ready' });
  await session.analyze();
  const original = session.snapshot(), primary = original.sources[0], alternate = original.sources[1];
  const back = original.regions.find(item => item.sourceId === primary.id && item.color === '#ba3e27')!;
  const other = original.regions.find(item => item.sourceId === alternate.id && item.color === '#ba3e27')!;
  expect((await session.execute({ expectedRevision: session.revision, edits: [
    { op: 'reference.correspond', correspondence: { id: 'owner-match', sourceIds: [primary.id, alternate.id], regionIds: [back.id, other.id], kind: 'same-part', origin: 'manual', accepted: true, evidence: ['owner matched the red part'] } },
    { op: 'reference.setTransform', sourceId: alternate.id, transformToPrimary: [1, 0, 0, 1, 0, 0] },
  ] })).ok).toBe(true);
  await session.analyze();
  const bytes = await session.saveDocument();
  await session.close();
  await page.goto('/decomposer.html');
  await page.getByLabel('Open .hydecomp').setInputFiles({ name: 'matched.hydecomp', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await expect(page.locator('.left-pane .inferred-row')).toHaveCount(1);
  await page.locator('.left-pane .inferred-row').click();
  const choice = page.getByRole('button', { name: 'Use pixels from alternate.png' });
  await expect(choice).toBeEnabled();
  await choice.click();
  await expect(page.getByRole('status')).toContainText('region.setAlignedTexture saved');
  await expect(page.getByText('Using alternate.png with alignment saved at selection time.')).toBeVisible();
  await expect(page.getByAltText('Isolated uncertain hidden texture crop')).toHaveJSProperty('naturalWidth', 2);
  await page.getByRole('button', { name: 'Preview in Hyde' }).click();
  await expect(page.getByAltText('Native Hyde render of current export')).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(choice).toBeEnabled();
  await expect(page.getByText('Using alternate.png with alignment saved at selection time.')).toHaveCount(0);
});

test('large import shows a bounded provisional pyramid preview before committing source-resolution regions', async ({ page }) => {
  const width = 1536, height = 1024, rgba = new Uint8Array(width * height * 4);
  for (let y = 128; y < 896; y++) for (let x = 160; x < 1376; x++) rgba.set([180, 55, 38, 255], (y * width + x) * 4);
  await page.goto('/decomposer.html');
  await page.evaluate(() => {
    (window as Window & { sawCoarsePreview?: boolean }).sawCoarsePreview = false;
    new MutationObserver(() => { if (document.querySelector('.coarse-preview-banner'))
      (window as Window & { sawCoarsePreview?: boolean }).sawCoarsePreview = true; })
      .observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.getByLabel('Import images').setInputFiles({ name: 'large-flat.png', mimeType: 'image/png', buffer: Buffer.from(encodePng({ width, height, rgba })) });
  await expect(page.getByRole('status')).toContainText('Automatic first pass found 1 editable regions.', { timeout: 60_000 });
  expect(await page.evaluate(() => (window as Window & { sawCoarsePreview?: boolean }).sawCoarsePreview)).toBe(true);
  await expect(page.getByRole('note')).toHaveCount(0);
  await expect(page.locator('.left-pane .scroll-list').first().locator('.row')).toHaveCount(1);
  await expect(page.locator('.canvas-card canvas').first()).toHaveJSProperty('width', 768);
  await expect(page.locator('.canvas-card canvas').last()).toHaveJSProperty('width', 768);
  await page.getByLabel('Canvas zoom').selectOption('1');
  await expect(page.locator('.canvas-card canvas').first()).toHaveJSProperty('width', 1024);
  await expect(page.locator('.canvas-card canvas').last()).toHaveJSProperty('width', 1024);
  await page.locator('.canvas-card').last().evaluate(card => { card.scrollLeft = 1150; });
  await expect(page.locator('.canvas-card canvas').last()).toHaveAttribute('data-tile-x', '1024');
  await expect(page.locator('.canvas-card canvas').last()).toHaveJSProperty('width', 512);
  const rightTilePixels = await page.locator('.canvas-card canvas').last().evaluate(canvas => {
    const context = (canvas as HTMLCanvasElement).getContext('2d')!;
    return { foreground: [...context.getImageData(1300 - 1024, 500, 1, 1).data],
      background: [...context.getImageData(1500 - 1024, 500, 1, 1).data] };
  });
  expect(rightTilePixels.foreground).toEqual([180, 55, 38, 255]);
  expect(rightTilePixels.background[3]).toBe(0);
  await page.locator('.canvas-card').last().evaluate(card => { card.scrollTop = 300; });
  await expect(page.locator('.canvas-card canvas').last()).toHaveAttribute('data-tile-y', '256');
  await page.locator('.canvas-card canvas').last().evaluate(canvas => {
    const context = (canvas as HTMLCanvasElement).getContext('2d')!;
    const create = context.createImageData.bind(context);
    (window as Window & { rasterAllocations?: number }).rasterAllocations = 0;
    context.createImageData = ((width: number, height: number) => {
      (window as Window & { rasterAllocations: number }).rasterAllocations++;
      return create(width, height);
    }) as typeof context.createImageData;
  });
  await page.locator('.canvas-card').last().evaluate(card => { card.scrollTop = 0; });
  await expect(page.locator('.canvas-card canvas').last()).toHaveAttribute('data-tile-y', '0');
  await page.locator('.canvas-card').last().evaluate(card => { card.scrollTop = 300; });
  await expect(page.locator('.canvas-card canvas').last()).toHaveAttribute('data-tile-y', '256');
  expect(await page.evaluate(() => (window as Window & { rasterAllocations?: number }).rasterAllocations)).toBe(0);
  const tileBox = await page.locator('.canvas-card canvas').last().boundingBox();
  expect(tileBox).toBeTruthy();
  await page.mouse.click(tileBox!.x + 1500 - 1024, tileBox!.y + 500 - 256);
  await expect(page.locator('.left-pane .scroll-list').first().locator('.row.selected')).toHaveCount(0);
  await page.mouse.click(tileBox!.x + 1300 - 1024, tileBox!.y + 500 - 256);
  await expect(page.locator('.left-pane .scroll-list').first().locator('.row.selected')).toHaveCount(1);
  expect(await page.evaluate(() => (window as Window & { rasterAllocations?: number }).rasterAllocations)).toBe(0);
  await page.getByLabel('Isolate').check();
  expect(await page.evaluate(() => (window as Window & { rasterAllocations?: number }).rasterAllocations)).toBeGreaterThan(0);
  await page.getByLabel('Canvas zoom').selectOption('fit');
  await expect(page.locator('.canvas-card canvas').last()).toHaveJSProperty('width', 768);
  await page.evaluate(() => { (window as Window & { sawCoarsePreview?: boolean }).sawCoarsePreview = false; });
  await page.getByRole('button', { name: 'Regenerate first pass' }).click();
  await expect(page.getByLabel('Regeneration impact preview')).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(() => (window as Window & { sawCoarsePreview?: boolean }).sawCoarsePreview)).toBe(true);
  await expect(page.getByRole('note')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel preview' }).click();
});

test('opaque background correction is previewed and saved per reference', async ({ page }) => {
  await page.goto('/decomposer.html');
  await page.getByLabel('Import images').setInputFiles({ name: 'opaque.png', mimeType: 'image/png', buffer: opaqueFixture() });
  await expect(page.getByRole('status')).toContainText('Automatic first pass found 1 editable regions.');
  const correction = page.getByLabel('Opaque background correction');
  await expect(correction).toContainText('Automatic border estimate');
  await correction.getByRole('button', { name: 'Keep all opaque pixels' }).click();
  await expect(page.getByRole('status')).toContainText('reference.setBackground saved');
  await correction.getByRole('button', { name: 'Preview background impact' }).click();
  await expect(page.getByLabel('Regeneration impact preview')).toContainText('1 current → 2 proposed active regions');
  await page.getByRole('button', { name: 'Confirm regeneration' }).click();
  await expect(page.getByRole('status')).toContainText('Apply background correction applied');
  await page.getByRole('button', { name: 'Original', exact: true }).click();
  await page.getByLabel('Canvas tool').selectOption('background');
  const box = await page.locator('canvas.interactive-canvas').boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box!.x + box!.width * .1, box!.y + box!.height * .1);
  await expect(page.getByRole('status')).toContainText('reference.setBackground saved');
  await expect(correction).toContainText('Chosen border color #ffffff');
  await correction.getByRole('button', { name: 'Preview background impact' }).click();
  await expect(page.getByLabel('Regeneration impact preview')).toContainText('2 current → 1 proposed active regions');
  await page.getByRole('button', { name: 'Confirm regeneration' }).click();
  const saving = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save source' }).click();
  const saved = await decodeDecompositionDocument(new Uint8Array(await readFile(await (await saving).path())));
  expect(saved.document.sources[0].backgroundColor).toBe('#ffffff');
  await page.getByLabel('Open .hydecomp').setInputFiles({ name: 'corrected.hydecomp', mimeType: 'application/zip', buffer: Buffer.from(await readFile(await (await saving).path())) });
  await expect(page.getByRole('status')).toContainText('Opened corrected.hydecomp');
  await expect(correction).toContainText('Chosen border color #ffffff');
});

test('import, edit, save/reopen and export native editable assembly', async ({ page }, testInfo) => {
  await page.goto('/decomposer.html');
  await expect(page.getByText('Turn illustrations into editable Hyde art')).toBeVisible();
  await page.getByLabel('Import images').setInputFiles({ name: 'two-piece-prop.png', mimeType: 'image/png', buffer: fixture() });
  await expect(page.getByRole('status')).toContainText('Automatic first pass found 2 editable regions.');
  await expect(page.locator('.left-pane .scroll-list').first().locator('.row')).toHaveCount(2);
  await page.locator('.left-pane .scroll-list').first().locator('.row').first().click();
  await expect(page.getByRole('heading', { name: 'Selected region' })).toBeVisible();
  const name = page.getByLabel('Part name');
  await name.fill('Handle'); await name.blur();
  await expect(page.getByRole('status')).toContainText('part.rename saved');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status')).toContainText('Undo applied.');
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(page.getByRole('status')).toContainText('Redo applied.');
  const savePromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save source' }).click();
  const saved = await savePromise;
  expect(saved.suggestedFilename()).toMatch(/\.hydecomp$/);
  const sourceBytes = await readFile(await saved.path());
  expect(sourceBytes.subarray(0, 2).toString()).toBe('PK');
  const exportPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const exported = await exportPromise;
  expect(exported.suggestedFilename()).toMatch(/\.hyproj$/);
  expect((await readFile(await exported.path())).subarray(0, 2).toString()).toBe('PK');
  const mappedSave = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save source' }).click();
  const mappedBytes = new Uint8Array(await readFile(await (await mappedSave).path()));
  const mapped = await decodeDecompositionDocument(mappedBytes);
  expect(mapped.document.exportMapping).toMatchObject({ format: 'hyproj', sdkVersion: '0.1.0' });
  expect(Object.keys(mapped.document.exportMapping!.regionIds)).toHaveLength(2);
  await page.getByRole('button', { name: 'Preview in Hyde' }).click();
  await expect(page.getByAltText('Native Hyde render of current export')).toBeVisible();
  const metrics = page.getByLabel('Native quality metrics');
  await expect(metrics).toBeVisible();
  await expect(metrics).toContainText('Silhouette IoU');
  await expect(metrics).toContainText('Color error');
  await expect(metrics).toContainText('Coverage missing');
  await expect(metrics).toContainText('Complexity');
  await page.getByLabel('Show residual overlay').check();
  const residual = page.getByAltText('Native residual overlay');
  await expect(residual).toBeVisible();
  expect(await residual.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([40, 32]);
  await page.getByLabel('Show residual overlay').uncheck();
  await expect(residual).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('decomposer-ui.png'), fullPage: true });
  await page.getByLabel('Open .hydecomp').setInputFiles({ name: 'restored.hydecomp', mimeType: 'application/zip', buffer: Buffer.from(mappedBytes) });
  await expect(page.getByRole('status')).toContainText('Opened restored.hydecomp');
  await expect(page.locator('.left-pane .scroll-list').first().locator('.row')).toHaveCount(2);
  await expect(page.getByText('Handle', { exact: true }).first()).toBeVisible();
});

test('guided mask brush, path drag and pivot edits commit through worker revisions', async ({ page }) => {
  await page.goto('/decomposer.html');
  await page.getByLabel('Import images').setInputFiles({ name: 'two-piece-prop.png', mimeType: 'image/png', buffer: fixture() });
  await expect(page.getByRole('status')).toContainText('Automatic first pass found 2 editable regions.');
  await page.locator('.left-pane .scroll-list').first().locator('.row').first().click();
  const canvas = page.locator('canvas.interactive-canvas');
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();
  if (!box) return;
  const imagePoint = (x: number, y: number) => ({ x: box.x + x / 40 * box.width, y: box.y + y / 32 * box.height });
  await page.getByLabel('Canvas tool').selectOption('paint-erase');
  await page.getByLabel('Brush radius').fill('1');
  await page.getByLabel('Brush hardness').fill('0.4');
  const erase = imagePoint(23, 5);
  await page.mouse.move(erase.x, erase.y); await page.mouse.down(); await page.mouse.up();
  await expect(page.getByRole('status')).toContainText('region.refineMask saved');
  await page.getByLabel('Canvas tool').selectOption('path');
  const anchor = imagePoint(20, 4), destination = imagePoint(21, 4);
  await page.mouse.move(anchor.x, anchor.y); await page.mouse.down(); await page.mouse.move(destination.x, destination.y); await page.mouse.up();
  await expect(page.getByRole('status')).toContainText('region.setPath saved');
  await page.getByLabel('Canvas tool').selectOption('pivot');
  const pivot = imagePoint(26, 15);
  await page.mouse.click(pivot.x, pivot.y);
  await expect(page.getByRole('status')).toContainText('part.setPivot saved');
  expect(Number(await page.getByLabel('Pivot X').inputValue())).toBeCloseTo(26, 1);
});

test('flat region color correction is reversible, survives regeneration and source reopen', async ({ page }) => {
  await page.goto('/decomposer.html');
  await page.getByLabel('Import images').setInputFiles({ name: 'two-piece-prop.png', mimeType: 'image/png', buffer: fixture() });
  await expect(page.getByRole('status')).toContainText('Automatic first pass found 2 editable regions.');
  await page.locator('.left-pane .scroll-list').first().locator('.row').first().click();
  const fill = page.getByLabel('Flat fill color');
  const generated = await fill.inputValue();
  await fill.fill('wrong'); await fill.blur();
  await expect(page.getByRole('status')).toContainText('six-digit hex');
  await expect(fill).toHaveValue(generated);
  await fill.fill('#a1b2c3'); await fill.blur();
  await expect(page.getByRole('status')).toContainText('region.setColor saved');
  await expect(fill).toHaveValue('#a1b2c3');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(fill).toHaveValue(generated);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(fill).toHaveValue('#a1b2c3');
  await page.getByRole('button', { name: 'Regenerate first pass' }).click();
  await expect(page.getByLabel('Regeneration impact preview')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm regeneration' }).click();
  await expect(page.getByRole('status')).toContainText('Regenerate first pass applied');
  await expect(fill).toHaveValue('#a1b2c3');
  const savePromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save source' }).click();
  const saved = await savePromise;
  const bytes = new Uint8Array(await readFile(await saved.path()));
  const decoded = await decodeDecompositionDocument(bytes);
  const corrected = decoded.document.regions.find(region => region.authoredColor === '#a1b2c3' && region.generatedColor === generated);
  expect(corrected).toBeTruthy();
  await page.getByRole('button', { name: 'Preview in Hyde' }).click();
  const native = page.getByAltText('Native Hyde render of current export');
  await expect(native).toBeVisible();
  expect(await native.evaluate(image => getComputedStyle(image).imageRendering)).toBe('auto');
  const nativeColor = await native.evaluate((image: HTMLImageElement, point: { x: number; y: number }) => {
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    return [...context.getImageData(point.x, point.y, 1, 1).data];
  }, { x: Math.floor(corrected!.bounds.x + corrected!.bounds.width / 2), y: Math.floor(corrected!.bounds.y + corrected!.bounds.height / 2) });
  expect(nativeColor.slice(0, 3)).toEqual([161, 178, 195]);
  await page.getByLabel('Open .hydecomp').setInputFiles({ name: 'recolored.hydecomp', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await expect(page.getByRole('status')).toContainText('Opened recolored.hydecomp');
  await page.locator('.left-pane .scroll-list').first().locator('.row').first().click();
  await expect(fill).toHaveValue('#a1b2c3');
  await page.getByRole('button', { name: 'Reset generated color' }).click();
  await expect(fill).toHaveValue(generated);
});

test('add brush extends the selected source mask beyond its automatic rectangle', async ({ page }) => {
  await page.goto('/decomposer.html');
  await page.getByLabel('Import images').setInputFiles({ name: 'two-piece-prop.png', mimeType: 'image/png', buffer: fixture() });
  await expect(page.getByRole('status')).toContainText('Automatic first pass found 2 editable regions.');
  await page.locator('.left-pane .scroll-list').first().locator('.row').first().click();
  await page.getByLabel('Canvas tool').selectOption('paint-add');
  await page.getByLabel('Brush radius').fill('2');
  const canvas = page.locator('canvas.interactive-canvas'), box = await canvas.boundingBox();
  expect(box).toBeTruthy();
  const point = { x: box!.x + 34 / 40 * box!.width, y: box!.y + 12 / 32 * box!.height };
  await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.up();
  await expect(page.getByRole('status')).toContainText('region.refineMask saved');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save source' }).click();
  const archive = await downloadPromise;
  const saved = await decodeDecompositionDocument(new Uint8Array(await readFile(await archive.path())));
  const blue = saved.document.regions.find(region => region.color === '#1e6fbc' && region.generationStatus !== 'historical')!;
  expect(blue.bounds.x + blue.bounds.width).toBeGreaterThan(34);
  const mask = saved.masks.get(blue.maskId)!;
  expect(mask.bytes[(12 - blue.bounds.y) * mask.width + 34 - blue.bounds.x]).toBe(1);
});

test('animation-ready attachment proposal can be reviewed and accepted in the editor', async ({ page }) => {
  const art = makeSyntheticFixture('articulated-character');
  await page.goto('/decomposer.html');
  await page.getByLabel('Import images').setInputFiles({ name: 'articulated-character.png', mimeType: 'image/png', buffer: Buffer.from(art.bytes) });
  await expect(page.getByRole('status')).toContainText('Automatic first pass');
  const beforePreview = await page.locator('canvas.interactive-canvas').evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
  await page.getByLabel('Reconstruction mode').selectOption('animation-ready');
  const review = page.getByLabel('Regeneration impact preview');
  await expect(review).toBeVisible();
  await expect(review).toContainText(/Canvas contours:.*[1-9]\d* shown/);
  const proposedPreview = await page.locator('canvas.interactive-canvas').evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
  expect(proposedPreview).not.toBe(beforePreview);
  await page.getByRole('button', { name: 'Cancel preview' }).click();
  expect(await page.locator('canvas.interactive-canvas').evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL())).toBe(beforePreview);
  await page.getByLabel('Reconstruction mode').selectOption('animation-ready');
  await expect(review).toBeVisible();
  await page.getByRole('button', { name: 'Confirm regeneration' }).click();
  await expect(page.getByRole('status')).toContainText('Switch to animation-ready applied');
  const suggested = page.locator('.left-pane .scroll-list').nth(1).locator('.row').filter({ hasText: 'hinge proposed' }).first();
  await expect(suggested).toBeVisible();
  const partName = await suggested.locator('span').textContent();
  await suggested.click();
  await expect(page.getByText('Suggested hinge attachment · unapproved')).toBeVisible();
  await expect(page.getByLabel('Parent part')).toHaveValue('');
  await page.getByRole('button', { name: 'Accept attachment proposal' }).click();
  await expect(page.getByRole('status')).toContainText('part.acceptAttachmentProposal saved');
  await expect(page.getByText('Suggested hinge attachment · unapproved')).toHaveCount(0);
  await expect(page.getByLabel('Attachment type')).toHaveValue('hinge');
  await expect(page.getByLabel('Parent part')).not.toHaveValue('');
  await page.getByLabel('Lock attachment').click();
  await expect(page.getByLabel('Lock attachment')).toBeChecked();
  await expect(page.getByLabel('Parent part')).toBeDisabled();
  await expect(page.getByLabel('Attachment type')).toBeDisabled();
  await page.getByLabel('Temporary joint offset').fill('25');
  await page.getByRole('button', { name: 'Preview temporary pose in Hyde' }).click();
  await expect(page.getByAltText('Temporary Hyde joint pose')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('No motion or pose was saved.');
  const savePromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save source' }).click();
  const saved = await savePromise;
  await page.getByLabel('Open .hydecomp').setInputFiles({ name: 'articulated.hydecomp', mimeType: 'application/zip', buffer: await readFile(await saved.path()) });
  await expect(page.getByRole('status')).toContainText('Opened articulated.hydecomp');
  await page.locator('.left-pane .scroll-list').nth(1).locator('.row').filter({ hasText: partName! }).click();
  await expect(page.getByLabel('Attachment type')).toHaveValue('hinge');
  await expect(page.getByLabel('Lock attachment')).toBeChecked();
});

test('outward feather correction persists in the editable source document', async ({ page }) => {
  const art = makeSyntheticFixture('simple-icon');
  await page.goto('/decomposer.html');
  await page.getByLabel('Import images').setInputFiles({ name: 'simple-icon.png', mimeType: 'image/png', buffer: Buffer.from(art.bytes) });
  await expect(page.getByRole('status')).toContainText('Automatic first pass');
  await page.locator('.left-pane .scroll-list').first().locator('.row').first().click();
  await page.getByLabel('Outward feather radius').fill('2');
  await page.getByRole('button', { name: 'Apply outward feather' }).click();
  await expect(page.getByRole('status')).toContainText('region.featherOutside saved');
  await expect(page.getByText('user-authored outward soft feather')).toBeVisible();
  const savePromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save source' }).click();
  const saved = await savePromise;
  await page.getByLabel('Open .hydecomp').setInputFiles({ name: 'soft-outward.hydecomp', mimeType: 'application/zip', buffer: await readFile(await saved.path()) });
  await expect(page.getByRole('status')).toContainText('Opened soft-outward.hydecomp');
  await page.locator('.left-pane .scroll-list').first().locator('.row').first().click();
  await expect(page.getByText('user-authored outward soft feather')).toBeVisible();
});

test('guided seed and path controls preserve editable history', async ({ page }) => {
  await page.goto('/decomposer.html');
  await page.getByLabel('Import images').setInputFiles({ name: 'two-piece-prop.png', mimeType: 'image/png', buffer: fixture() });
  await expect(page.getByRole('status')).toContainText('Automatic first pass found 2 editable regions.');
  const region = page.locator('.left-pane .scroll-list').first().locator('.row').first();
  await region.click();
  const before = await region.locator('small').textContent();
  const canvas = page.locator('canvas.interactive-canvas');
  const imagePoint = async (x: number, y: number) => {
    const box = await canvas.boundingBox();
    if (!box) throw new Error('The reconstruction canvas is missing.');
    return { x: box.x + x / 40 * box.width, y: box.y + y / 32 * box.height };
  };
  await page.getByLabel('Canvas tool').selectOption('seed-erase');
  await page.getByLabel('Seed tolerance').fill('0');
  await page.getByLabel('Seed reach').fill('3');
  const seed = await imagePoint(25, 15);
  await page.mouse.click(seed.x, seed.y);
  await expect(page.getByRole('status')).toContainText('region.seedMask saved');
  await expect(region.locator('small')).not.toHaveText(before ?? '');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status')).toContainText('Undo applied.');
  await expect(region.locator('small')).toHaveText(before ?? '');

  await page.getByLabel('Canvas tool').selectOption('path');
  await page.getByLabel('Snap path to source edges').check();
  const anchor = await imagePoint(20, 4);
  await page.mouse.click(anchor.x, anchor.y);
  await expect(page.getByRole('button', { name: 'Add path anchor' })).toBeEnabled();
  await page.getByRole('button', { name: 'Add path anchor' }).click();
  await expect(page.getByRole('status')).toContainText('region.setPath saved');
  await page.getByRole('button', { name: 'Add outgoing handle' }).click();
  await expect(page.getByRole('button', { name: 'Remove outgoing handle' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove path anchor' }).click();
  await expect(page.getByRole('status')).toContainText('region.setPath saved');
  await page.getByRole('checkbox', { name: 'Lock path' }).click();
  await expect(page.getByRole('checkbox', { name: 'Lock path' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Use generated contour' }).click();
  await expect(page.getByRole('status')).toContainText('region.clearManualPath saved');
  await expect(page.getByRole('button', { name: 'Use generated contour' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply outward feather' })).toBeEnabled();
});

test('manual cross-reference landmarks and affine alignment survive source reopen', async ({ page }, testInfo) => {
  await page.goto('/decomposer.html');
  await page.getByLabel('Import images').setInputFiles([
    { name: 'primary.png', mimeType: 'image/png', buffer: fixture() },
    { name: 'alternate.png', mimeType: 'image/png', buffer: fixture() },
  ]);
  await expect(page.getByRole('status')).toContainText('Automatic first pass');
  await page.getByRole('button', { name: 'Original', exact: true }).click();
  await page.getByLabel('Canvas zoom').selectOption('4');
  await page.getByLabel('Canvas tool').selectOption('landmark');
  await expect.poll(async () => (await page.locator('canvas.interactive-canvas').boundingBox())?.width).toBe(160);
  const referenceRows = page.locator('.left-pane .stack .row');
  const pointOnOriginal = async (x: number, y: number) => {
    const box = await page.locator('canvas.interactive-canvas').boundingBox();
    if (!box) throw new Error('The interactive source canvas is missing.');
    return { x: box.x + x / 40 * box.width, y: box.y + y / 32 * box.height };
  };
  const first = await pointOnOriginal(10, 11);
  await page.mouse.click(first.x, first.y);
  await expect(page.getByText('Pending landmark')).toBeVisible();
  await referenceRows.nth(1).click();
  await expect(page.locator('.canvas-label')).toContainText('alternate.png');
  const comparison = page.getByLabel('Compare references');
  await expect(comparison).toContainText('The primary image defines the editable Hyde construction pose.');
  await expect(comparison).toContainText('No motion is generated.');
  await expect(comparison.getByAltText('Primary construction pose')).toHaveJSProperty('naturalWidth', 40);
  await expect(comparison.getByAltText('Additional reference')).toHaveJSProperty('naturalWidth', 40);
  await page.screenshot({ path: testInfo.outputPath('reference-comparison.png'), fullPage: true });
  const second = await pointOnOriginal(12, 11);
  await page.mouse.click(second.x, second.y);
  await expect(page.getByRole('status')).toContainText('reference.correspond saved');
  await expect(page.getByText('Paired landmarks', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Align from paired landmarks' }).click();
  await expect(page.getByRole('status')).toContainText('reference.alignFromLandmarks saved');
  await expect(page.getByLabel('Alignment tx')).toHaveValue('-2');
  const tx = page.getByLabel('Alignment tx');
  await tx.fill('2'); await tx.blur();
  await expect(page.getByRole('status')).toContainText('reference.setTransform saved');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save source' }).click();
  const saved = await downloadPromise;
  const bytes = await readFile(await saved.path());
  await page.getByLabel('Open .hydecomp').setInputFiles({ name: 'landmarks.hydecomp', mimeType: 'application/zip', buffer: bytes });
  await expect(page.getByRole('status')).toContainText('Opened landmarks.hydecomp');
  await expect(page.getByText('Paired landmarks', { exact: true })).toBeVisible();
  await referenceRows.nth(1).click();
  await expect(page.getByLabel('Alignment tx')).toHaveValue('2');
});

test('ambiguous repeated shapes present readable candidates and persist a manual identity decision', async ({ page }) => {
  const pair = makeRepeatedMultiviewFixture();
  await page.goto('/decomposer.html');
  await page.getByLabel('Import images').setInputFiles([
    { name: 'primary-circles.png', mimeType: 'image/png', buffer: Buffer.from(pair.primary.input.bytes) },
    { name: 'alternate-circles.png', mimeType: 'image/png', buffer: Buffer.from(pair.alternate.input.bytes) },
  ]);
  await expect(page.getByRole('status')).toContainText('Automatic first pass');
  await page.locator('.left-pane .scroll-list').first().locator('.row').first().click();
  const identity = page.getByLabel('Cross-reference identity');
  await expect(identity).toContainText('References are separate views, not animation frames.');
  await expect(identity.getByText('Unresolved candidate', { exact: false })).toHaveCount(2);
  await expect(identity.locator('.match-candidate').first()).toContainText('Evidence: normalized contour distance');
  await expect(page.locator('.diagnostic').filter({ hasText: 'CORRESPONDENCE_AMBIGUOUS' }).first()).toContainText('Heuristic evidence: best combined heuristic distance');
  await identity.getByRole('button', { name: 'Reject candidate' }).first().click();
  await expect(page.getByRole('status')).toContainText('reference.correspond saved');
  await expect(identity.getByText('Rejected manually', { exact: false })).toHaveCount(1);
  await expect(identity.getByText('Unresolved candidate', { exact: false })).toHaveCount(1);
  const select = page.getByLabel('Alternate match');
  await expect(select.locator('option')).toHaveCount(3);
  await expect(select.locator('option').nth(2)).toContainText('alternate-circles.png · (');
  await select.selectOption({ index: 2 });
  await page.getByRole('button', { name: 'Confirm same part' }).click();
  await expect(page.getByRole('status')).toContainText('reference.correspond saved');
  await expect(identity.getByText('Confirmed manually', { exact: false })).toHaveCount(1);
  const saving = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save source' }).click();
  const bytes = new Uint8Array(await readFile(await (await saving).path()));
  const source = await decodeDecompositionDocument(bytes);
  expect(source.document.correspondences.some(item => item.origin === 'manual' && item.kind === 'same-part' && item.accepted)).toBe(true);
  expect(source.document.correspondences.some(item => item.origin === 'manual' && item.accepted === false)).toBe(true);
  await page.getByLabel('Open .hydecomp').setInputFiles({ name: 'reviewed.hydecomp', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await page.locator('.left-pane .scroll-list').first().locator('.row').first().click();
  await expect(page.getByLabel('Cross-reference identity').getByText('Confirmed manually', { exact: false })).toHaveCount(1);
  await expect(page.getByLabel('Cross-reference identity').getByText('Rejected manually', { exact: false })).toHaveCount(1);
});

test('hidden proposals can be inspected, disabled and pinned without losing the manual contour', async ({ page }) => {
  const art = makeSyntheticFixture('occlusion');
  await page.goto('/decomposer.html');
  await page.getByLabel('Import images').setInputFiles({ name: 'occlusion.png', mimeType: 'image/png', buffer: Buffer.from(art.bytes) });
  await expect(page.getByRole('status')).toContainText('Automatic first pass');
  const inference = page.getByLabel('Infer hidden continuations');
  await expect(inference).toBeDisabled();
  await page.getByLabel('Reconstruction mode').selectOption('animation-ready');
  const impact = page.getByLabel('Regeneration impact preview');
  await expect(impact).toContainText('New candidates');
  await expect(page.locator('.left-pane .inferred-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel preview' }).click();
  await expect(page.getByLabel('Reconstruction mode')).toHaveValue('appearance');
  await page.getByLabel('Reconstruction mode').selectOption('animation-ready');
  await expect(impact).toBeVisible();
  await page.getByRole('button', { name: 'Confirm regeneration' }).click();
  await expect(page.getByRole('status')).toContainText('Switch to animation-ready applied');
  await expect(inference).toBeChecked();
  const inferredRow = page.locator('.left-pane .inferred-row');
  await expect(inferredRow).toHaveCount(1);
  await expect(inferredRow).toContainText('unseen and uncertain');
  await inferredRow.click();
  await expect(page.getByText('Unseen continuation · uncertain')).toBeVisible();
  await expect(page.getByText('no source pixel reveals')).toBeVisible();
  await expect(page.getByLabel('Show inferred overlay')).toBeChecked();
  await page.getByLabel('Show inferred overlay').uncheck();
  await expect(page.getByLabel('Show inferred overlay')).not.toBeChecked();

  await inference.uncheck();
  await expect(impact).toContainText('At-risk unlocked');
  await expect(impact).toContainText('will be removed');
  await expect(inferredRow).toHaveCount(1);
  await page.getByRole('button', { name: 'Cancel preview' }).click();
  await expect(inference).toBeChecked();
  await expect(inferredRow).toHaveCount(1);
  await inference.uncheck();
  await page.getByRole('button', { name: 'Confirm regeneration' }).click();
  await expect(page.getByRole('status')).toContainText('Disable hidden continuations applied');
  await expect(inferredRow).toHaveCount(0);
  await inference.check();
  await expect(impact).toBeVisible();
  await page.getByRole('button', { name: 'Confirm regeneration' }).click();
  await expect(inferredRow).toHaveCount(1);
  await inferredRow.click();
  await page.getByRole('button', { name: 'Pin current hidden contour' }).click();
  await expect(page.getByRole('status')).toContainText('region.setPath saved');
  await expect(page.getByRole('button', { name: 'Contour pinned as manual edit' })).toBeDisabled();
  await inference.uncheck();
  await expect(impact).toContainText('User-edited or locked regions retained · 1');
  await page.getByRole('button', { name: 'Confirm regeneration' }).click();
  await expect(page.getByRole('status')).toContainText('Disable hidden continuations applied');
  await expect(inferredRow).toHaveCount(1);
  await expect(page.getByText('Unseen continuation · uncertain')).toBeVisible();
  await page.getByRole('button', { name: 'Suppress inferred region' }).click();
  await expect(inferredRow).toHaveCount(0);
  const suppressedRow = page.locator('.left-pane .suppressed-row');
  await expect(suppressedRow).toHaveCount(1);
  await suppressedRow.click();
  await page.getByRole('button', { name: 'Restore inferred region' }).click();
  await expect(inferredRow).toHaveCount(1);
});

test('reviewed layer evidence can be rejected and stays rejected in the source document', async ({ page }) => {
  const art = makeSyntheticFixture('occlusion');
  await page.goto('/decomposer.html');
  await page.getByLabel('Import images').setInputFiles({ name: 'occlusion.png', mimeType: 'image/png', buffer: Buffer.from(art.bytes) });
  await expect(page.getByRole('status')).toContainText('Automatic first pass');
  await page.getByLabel('Reconstruction mode').selectOption('animation-ready');
  await page.getByRole('button', { name: 'Confirm regeneration' }).click();
  await page.locator('.left-pane .inferred-row').click();
  const proposal = page.getByLabel('Layer proposal');
  await expect(proposal).toBeVisible();
  await expect(proposal).toContainText('Evidence:');
  await proposal.getByRole('button', { name: 'Reject layer proposal' }).click();
  await expect(page.getByRole('status')).toContainText('layer.rejectProposal saved');
  await expect(proposal).toHaveCount(0);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save source' }).click();
  const download = await downloadPromise;
  const bytes = new Uint8Array(await readFile(await download.path()));
  const saved = await decodeDecompositionDocument(bytes);
  expect(saved.document.layers.some(item => item.status === 'rejected' && item.origin === 'manual')).toBe(true);
  await page.getByLabel('Open .hydecomp').setInputFiles({ name: 'rejected.hydecomp', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await expect(page.getByRole('status')).toContainText('Opened rejected.hydecomp');
  await page.locator('.left-pane .inferred-row').click();
  await expect(proposal).toHaveCount(0);
});

test('settings and selected-path regeneration require review and preserve undo and source round trips', async ({ page }) => {
  await page.goto('/decomposer.html');
  await page.getByLabel('Import images').setInputFiles({ name: 'two-piece-prop.png', mimeType: 'image/png', buffer: fixture() });
  await expect(page.getByRole('status')).toContainText('Automatic first pass found 2 editable regions.');
  const tolerance = page.getByLabel('Path tolerance');
  const originalTolerance = await tolerance.inputValue();
  const featureSize = page.getByLabel('Minimum feature size');
  const originalFeatureSize = await featureSize.inputValue();
  const edgeSensitivity = page.getByLabel('Edge sensitivity');
  const originalEdgeSensitivity = await edgeSensitivity.inputValue();
  const thinLines = page.getByLabel('Preserve thin lines');
  await expect(thinLines).toBeChecked();
  await tolerance.fill('2');
  await featureSize.fill('12');
  await edgeSensitivity.fill('0.5');
  await thinLines.uncheck();
  await page.getByRole('button', { name: 'Preview settings impact' }).click();
  const impact = page.getByLabel('Regeneration impact preview');
  await expect(impact).toContainText('path tolerance 2');
  await expect(impact).toContainText('minimum feature 12 px');
  await expect(impact).toContainText('edge sensitivity 0.50');
  await expect(impact).toContainText('thin lines mergeable');
  await expect(impact).toContainText('Retained unlocked');
  await expect(impact).toContainText('At-risk unlocked');
  await page.getByRole('button', { name: 'Cancel preview' }).click();
  await expect(impact).toHaveCount(0);
  await expect(tolerance).toHaveValue('2');
  await expect(featureSize).toHaveValue('12');
  await expect(edgeSensitivity).toHaveValue('0.5');
  await expect(thinLines).not.toBeChecked();
  await page.getByRole('button', { name: 'Preview settings impact' }).click();
  await page.getByRole('button', { name: 'Confirm regeneration' }).click();
  await expect(page.getByRole('status')).toContainText('Apply settings applied');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status')).toContainText('Undo applied.');
  await expect(tolerance).toHaveValue(originalTolerance);
  await expect(featureSize).toHaveValue(originalFeatureSize);
  await expect(edgeSensitivity).toHaveValue(originalEdgeSensitivity);
  await expect(thinLines).toBeChecked();
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(page.getByRole('status')).toContainText('Redo applied.');
  await expect(tolerance).toHaveValue('2');
  await expect(featureSize).toHaveValue('12');
  await expect(edgeSensitivity).toHaveValue('0.5');
  await expect(thinLines).not.toBeChecked();
  const savePromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save source' }).click();
  const saved = await savePromise;
  await page.getByLabel('Open .hydecomp').setInputFiles({ name: 'reviewed.hydecomp', mimeType: 'application/zip', buffer: await readFile(await saved.path()) });
  await expect(page.getByRole('status')).toContainText('Opened reviewed.hydecomp');
  await expect(tolerance).toHaveValue('2');
  await expect(featureSize).toHaveValue('12');
  await expect(edgeSensitivity).toHaveValue('0.5');
  await expect(thinLines).not.toBeChecked();
  await page.locator('.left-pane .scroll-list').first().locator('.row').first().click();
  await page.getByRole('button', { name: 'Regenerate selected path' }).click();
  await expect(impact).toContainText('Regenerate selected path · proposed');
  await expect(page.getByRole('status')).toContainText('Current document is unchanged.');
  await page.getByRole('button', { name: 'Confirm regeneration' }).click();
  await expect(page.getByRole('status')).toContainText('Regenerate selected path applied');
});
