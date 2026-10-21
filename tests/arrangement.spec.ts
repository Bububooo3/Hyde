import { expect, test } from '@playwright/test';

test('selected objects can be aligned and the action can be undone', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.getByRole('textbox',{name:'Element name'}).fill('Left shape');
  await page.getByRole('spinbutton',{name:'X',exact:true}).fill('200');
  await page.getByRole('button',{name:'Add ellipse'}).click();
  await page.getByRole('textbox',{name:'Element name'}).fill('Right shape');
  await page.getByRole('spinbutton',{name:'X',exact:true}).fill('600');
  await page.locator('.layer-name').getByText('Left shape',{exact:true}).click({modifiers:['Control']});
  await expect(page.getByRole('heading',{name:'Arrange 2 objects'})).toBeVisible();
  await page.getByRole('button',{name:'Left',exact:true}).click();
  await page.locator('.layer-name').getByText('Right shape',{exact:true}).click();
  expect(Number(await page.getByRole('spinbutton',{name:'X',exact:true}).inputValue())).toBeLessThan(300);
  await page.getByRole('button',{name:'Undo (Ctrl Z)'}).click();
  await expect(page.getByRole('spinbutton',{name:'X',exact:true})).toHaveValue('600');
});
