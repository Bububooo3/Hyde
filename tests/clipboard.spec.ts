import { expect, test } from '@playwright/test';

test('copy and paste use the Edit menu, shortcuts, and undo across projects', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Add rectangle' }).first().click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: /Copy selection/ }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: /Paste at playhead/ }).click();
  await expect(page.locator('.scene-element-row')).toHaveCount(2);
  await page.keyboard.press('Control+v');
  await expect(page.locator('.scene-element-row')).toHaveCount(3);
  await page.getByRole('button', { name: 'Undo (Ctrl Z)' }).click();
  await expect(page.locator('.scene-element-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'hyde' }).click();
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.keyboard.press('Control+v');
  await expect(page.locator('.scene-element-row')).toHaveCount(1);
});
