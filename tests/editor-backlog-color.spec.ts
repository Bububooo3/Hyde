import { expect, test } from '@playwright/test';

test('typed hex stays in sync with the picker and rejects invalid input', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Add rectangle' }).first().click();
  const picker = page.getByLabel('Fill color', { exact: true });
  const hex = page.getByLabel('Fill color hex');
  await hex.fill('#12ab34'); await hex.press('Enter');
  await expect(picker).toHaveValue('#12ab34');
  await hex.fill('#wrong'); await hex.press('Enter');
  await expect(picker).toHaveValue('#12ab34');
  await expect(hex).toHaveValue('#12ab34');
  await picker.fill('#aabbcc');
  await expect(hex).toHaveValue('#aabbcc');
  await expect(page.getByRole('button', { name: 'Fill color eyedropper' })).toBeVisible();
  await page.getByRole('button', { name: 'Add ellipse' }).first().click();
  const rows = page.locator('.scene-element-row');
  await rows.filter({ hasText: 'Rectangle' }).click();
  await rows.filter({ hasText: 'Ellipse' }).click({ modifiers: ['Control'] });
  const bulkHex = page.getByLabel('Bulk fill color hex');
  await expect(bulkHex).toHaveAttribute('placeholder', 'Mixed');
  await bulkHex.fill('#334455'); await bulkHex.press('Enter');
  await expect(page.getByLabel('Bulk fill color', { exact: true })).toHaveValue('#334455');
  await expect(bulkHex).toHaveValue('#334455');
  await page.keyboard.press('Control+z');
  await expect(bulkHex).toHaveValue('');
});
