import { expect, test } from '@playwright/test';

test('layer menus reorder multiple selected siblings and show individual stage bounds', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  for (const name of ['A', 'B', 'C']) {
    await page.getByRole('button', { name: 'Add rectangle' }).first().click();
    await page.getByLabel('Element name').fill(name);
  }
  const rows = page.locator('.scene-element-row');
  await rows.filter({ hasText: 'A' }).click();
  await rows.filter({ hasText: 'C' }).click({ modifiers: ['Control'] });
  await expect(page.locator('.selection-overlay.primary')).toHaveCount(1);
  await expect(page.locator('.selection-overlay.secondary')).toHaveCount(1);
  const names = () => rows.locator('.layer-name').allTextContents();
  await rows.filter({ hasText: 'C' }).click({ button: 'right' });
  await page.locator('.scene-context-menu').getByRole('button', { name: 'Bring Forward' }).click();
  await expect.poll(names).toEqual(['C', 'A', 'B']);
  await page.locator('.stage-frame').click({ button: 'right', position: { x: 20, y: 20 } });
  await page.locator('.context-menu').getByRole('button', { name: 'Send Backward' }).click();
  await expect.poll(names).toEqual(['B', 'C', 'A']);
  await page.keyboard.press('Control+z');
  await expect.poll(names).toEqual(['C', 'A', 'B']);
});
