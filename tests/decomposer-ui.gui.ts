import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { decodeDecompositionDocument } from '../src/decomposer/codec';
import { encodePng } from '../src/decomposer/image';
import { DecompositionSession } from '../src/decomposer/session';
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
  await expect(page.locator('.canvas-card canvas').first()).toHaveJSProperty('width', width);
  await expect(page.locator('.canvas-card canvas').last()).toHaveJSProperty('width', width);
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
  await page.getByLabel('Open .hydecomp').setInputFiles({ name: 'reviewed.hydecomp', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await page.locator('.left-pane .scroll-list').first().locator('.row').first().click();
  await expect(page.getByLabel('Cross-reference identity').getByText('Confirmed manually', { exact: false })).toHaveCount(1);
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
