import { expect, test } from '@playwright/test';

test('path point pixel coordinates and grid snap preserve geometry through undo and archive reopen', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Add polygon' }).first().click();
  await page.getByRole('button', { name: 'Convert to editable path' }).click();
  const x = page.getByRole('spinbutton', { name: 'Point X (local px)' });
  const y = page.getByRole('spinbutton', { name: 'Point Y (local px)' });
  await expect(x).toHaveValue('90');
  await expect(y).toHaveValue('0');
  const outline = page.locator('.path-overlay path').first();
  const before = await outline.getAttribute('d');
  await x.fill('75'); await x.press('Enter');
  await expect(x).toHaveValue('75');
  const after = await outline.getAttribute('d');
  expect(after).not.toBe(before);
  await page.keyboard.press('Control+z');
  await expect(x).toHaveValue('90');
  await page.keyboard.press('Control+y');
  await expect(outline).toHaveAttribute('d', after!);
  await page.getByRole('checkbox', { name: 'Snap selected point to grid' }).check();
  await x.fill('83'); await x.press('Enter');
  await expect(x).toHaveValue('80');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('button', { name: 'Download project copy' }).click();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await (await download).path())!);
  await page.locator('.scene-element-row').first().click();
  if (await page.getByRole('button', { name: 'Edit path on stage' }).isVisible())
    await page.getByRole('button', { name: 'Edit path on stage' }).click();
  await expect(x).toHaveValue('80');
});
