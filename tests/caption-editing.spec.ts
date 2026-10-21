import {expect,test} from '@playwright/test';

test('viewer captions are authored, timed, saved, and restored through the timeline',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add caption'}).click();
  await page.getByRole('textbox',{name:'Caption text'}).fill('A quiet arrival');
  await page.getByRole('spinbutton',{name:'Caption end s'}).fill('5');
  await page.getByRole('spinbutton',{name:'Caption end s'}).press('Tab');
  await page.getByRole('spinbutton',{name:'Caption start s'}).fill('3');
  await page.getByRole('spinbutton',{name:'Caption start s'}).press('Tab');
  await expect(page.locator('.caption-block')).toContainText('A quiet arrival');
  await page.locator('.caption-block').click();
  await expect(page.locator('.stage-caption')).toHaveText('A quiet arrival');
  const downloaded=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await (await downloaded).path())!);
  await expect(page.locator('.caption-block')).toContainText('A quiet arrival');
  await page.locator('.caption-block').click();
  await page.getByRole('button',{name:'Delete caption'}).click();
  await expect(page.locator('.caption-block')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.caption-block')).toHaveCount(1);
});
