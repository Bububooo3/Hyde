import { expect, test } from '@playwright/test';

test('bulk fields show mixed dimensions and apply one undoable edit', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Add rectangle' }).first().click();
  await page.getByLabel('Element name').fill('Small');
  await page.getByRole('spinbutton', { name: 'Width', exact: true }).fill('100');
  await page.getByRole('button', { name: 'Add rectangle' }).first().click();
  await page.getByLabel('Element name').fill('Large');
  const rows = page.locator('.scene-element-row');
  await rows.filter({ hasText: 'Small' }).click();
  await rows.filter({ hasText: 'Large' }).click({ modifiers: ['Control'] });
  const width = page.getByRole('spinbutton', { name: 'Bulk width' });
  await expect(width).toHaveAttribute('placeholder', 'Mixed');
  await expect(width).toHaveValue('');
  await width.fill('240'); await width.press('Enter');
  await expect(width).toHaveValue('240');
  await page.getByRole('button', { name: 'Undo (Ctrl Z)' }).click();
  await expect(width).toHaveValue('');
  await page.getByRole('combobox', { name: 'Bulk edit mode' }).selectOption('relative');
  await width.fill('20'); await width.press('Enter');
  await expect(width).toHaveValue('');
  await rows.filter({ hasText: 'Small' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('120');
  await rows.filter({ hasText: 'Large' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('200');
});
