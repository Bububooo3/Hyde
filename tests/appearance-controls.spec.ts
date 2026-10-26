import { expect, test } from '@playwright/test';
import { createElement, createProject } from '../src/model';
import { saveProjectBlob } from '../src/storage';

test('stage size presets report the selected choice and clear it for custom dimensions', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('button', { name: 'Landscape' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Portrait' }).click();
  await expect(page.getByRole('button', { name: 'Portrait' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Landscape' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('spinbutton', { name: 'Width' })).toHaveValue('1080');
  await expect(page.getByRole('spinbutton', { name: 'Height' })).toHaveValue('1920');
  await page.getByRole('button', { name: 'Square' }).click();
  await expect(page.getByRole('button', { name: 'Square' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('spinbutton', { name: 'Width' }).fill('1000');
  await expect(page.locator('.preset-buttons button[aria-pressed="true"]')).toHaveCount(0);
});

test('fill picker and displayed value follow the visible animated fill', async ({ page }) => {
  const project = createProject('Fill feedback');
  project.elements.push(createElement('rectangle', {
    id: 'color-shape', name: 'Color shape', x: project.width / 2, y: project.height / 2,
    width: 400, height: 300, fill: '#ff0000', duration: project.duration,
    sceneId: project.sequences[0].id,
    tracks: [{ property: 'fill', keyframes: [
      { id: 'red', time: 0, value: '#ff0000', easing: 'linear', direction: 'inOut', mode: 'smooth' },
      { id: 'blue', time: 4, value: '#0000ff', easing: 'linear', direction: 'inOut', mode: 'smooth' },
    ] }],
  }));
  const bytes = Buffer.from(await (await saveProjectBlob(project)).arrayBuffer());
  await page.goto('/');
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles({ name: 'fill.hyde', mimeType: 'application/octet-stream', buffer: bytes });
  await page.locator('.layer-name').filter({ hasText: 'Color shape' }).click();
  const ruler = await page.locator('.ruler').boundingBox();
  expect(ruler).toBeTruthy();
  await page.mouse.click(ruler!.x + ruler!.width * 4 / project.duration, ruler!.y + ruler!.height / 2);
  await expect(page.getByLabel('Fill color', { exact: true })).toHaveValue('#0000ff');
  await page.getByLabel('Fill color', { exact: true }).fill('#27b56a');
  await expect(page.getByLabel('Fill color', { exact: true })).toHaveValue('#27b56a');
  await expect(page.getByLabel('Fill color hex')).toHaveValue('#27b56a');
  await page.getByRole('button', { name: 'Undo (Ctrl Z)' }).click();
  await expect(page.getByLabel('Fill color', { exact: true })).toHaveValue('#0000ff');
});
