import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function openSmallExport(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Add rectangle' }).first().click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Video and GIF export' });
  await panel.getByRole('combobox', { name: 'Export range' }).selectOption('selected');
  await panel.getByRole('spinbutton', { name: 'Export to seconds' }).fill('0.3');
  await panel.getByRole('spinbutton', { name: 'Export width' }).fill('64');
  return panel;
}

test('GIF export downloads a valid small animation through the editor', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const panel = await openSmallExport(page);
  await panel.getByRole('button', { name: 'GIF', exact: true }).click();
  await panel.getByRole('combobox', { name: 'Export frame rate' }).selectOption('6');
  const download = page.waitForEvent('download', { timeout: 30000 });
  await panel.getByRole('button', { name: 'Export GIF' }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toMatch(/\.gif$/);
  const bytes = await readFile((await saved.path())!);
  expect(bytes.subarray(0, 6).toString('ascii')).toMatch(/^GIF8[79]a$/);
  expect(bytes.readUInt16LE(6)).toBe(64);
  expect(bytes.length).toBeGreaterThan(100);
  await expect(panel.getByRole('status')).toContainText('Downloaded');
  expect(errors).toEqual([]);
});

test('video export offers probed formats and renders a supported format', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const panel = await openSmallExport(page);
  await panel.getByRole('combobox', { name: 'Export frame rate' }).selectOption('12');
  const format = panel.getByRole('combobox', { name: 'Video format' });
  await expect(format).toBeEnabled({ timeout: 30000 });
  await expect(format.locator('option')).toHaveCount(2);
  const button = panel.getByRole('button', { name: /Export (MP4|WEBM)/ });
  if (await button.isEnabled()) {
    const selected = await format.inputValue();
    console.log(`Video export capability: ${selected} supported; exercising download.`);
    const download = page.waitForEvent('download', { timeout: 30000 });
    await button.click();
    const saved = await download;
    expect(saved.suggestedFilename()).toMatch(new RegExp(`\\.${selected}$`));
    const bytes = await readFile((await saved.path())!);
    expect(bytes.length).toBeGreaterThan(100);
    if (selected === 'mp4') expect(bytes.subarray(4, 8).toString('ascii')).toBe('ftyp');
    else expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    await expect(panel.getByRole('status')).toContainText('Downloaded');
  } else {
    console.log('Video export capability: no supported format in this browser.');
    await expect(panel.getByText(/cannot encode this video format/i).first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});
