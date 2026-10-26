import { expect, test } from '@playwright/test';

async function blankProject(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
}

test('polygon dimensions resize visible geometry and survive undo, redo, and archive reopen', async ({ page }) => {
  await blankProject(page);
  await page.getByRole('button', { name: 'Add polygon' }).first().click();
  const width = page.getByRole('spinbutton', { name: 'Width', exact: true });
  const height = page.getByRole('spinbutton', { name: 'Height', exact: true });
  await width.fill('360'); await width.press('Enter');
  await height.fill('210'); await height.press('Enter');
  await expect(width).toHaveValue('360');
  await expect(height).toHaveValue('210');
  await page.getByRole('button', { name: 'Edit path on stage' }).click();
  const path = page.locator('.path-overlay path').first();
  await expect(path).toHaveAttribute('d', /360/);
  const resized = await path.getAttribute('d');
  await page.keyboard.press('Control+z');
  await expect(height).toHaveValue('140');
  await page.keyboard.press('Control+y');
  await expect(path).toHaveAttribute('d', resized!);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('button', { name: 'Download project copy' }).click();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await (await download).path())!);
  await page.locator('.scene-element-row').first().click();
  await expect(width).toHaveValue('360');
  await expect(height).toHaveValue('210');
});

test('copy, paste, undo, and Ctrl+Y work with an unrelated selection', async ({ page }) => {
  await blankProject(page);
  await page.getByRole('button', { name: 'Add rectangle' }).first().click();
  await page.keyboard.press('Control+c');
  await page.getByRole('button', { name: 'Add ellipse' }).first().click();
  await page.locator('.scene-element-row').filter({ hasText: 'Ellipse' }).click();
  await page.keyboard.press('Control+v');
  await expect(page.locator('.scene-element-row')).toHaveCount(3);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.scene-element-row')).toHaveCount(2);
  await page.keyboard.press('Control+y');
  await expect(page.locator('.scene-element-row')).toHaveCount(3);
});

test('project background label and picker do not overlap in a compact window', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 660 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  const label = page.locator('.project-background-field>span');
  const picker = page.getByLabel('Project background');
  const a = await label.boundingBox(), b = await picker.boundingBox();
  expect(a && b).toBeTruthy();
  expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x);
  expect(a!.y + a!.height).toBeGreaterThan(b!.y);
  expect(await picker.isEnabled()).toBe(true);
});
