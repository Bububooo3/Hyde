import {expect,test} from '@playwright/test';

test('static hint keeps animated art live and survives project save',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add rectangle',exact:true}).click();
  const hint=page.getByRole('combobox',{name:'Render optimization'});
  await expect(hint).toHaveValue('auto');
  await expect(page.getByText('Auto chooses static for this object.')).toBeVisible();
  await hint.selectOption('static');
  await page.getByRole('combobox',{name:'New motion behavior'}).selectOption('oscillation');
  await page.getByRole('button',{name:'Add motion behavior'}).click();
  const frame=()=>page.locator('.stage-frame canvas').evaluate((canvas:HTMLCanvasElement)=>canvas.toDataURL());
  const first=await frame();
  const tick=await page.locator('.ruler > span').filter({hasText:'2s'}).first().boundingBox();
  expect(tick).toBeTruthy();
  await page.mouse.click(tick!.x+tick!.width/2,tick!.y+tick!.height/2);
  await expect.poll(frame).not.toBe(first);
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await (await download).path())!);
  await page.locator('.layer-name').filter({hasText:'Rectangle'}).click();
  await expect(page.getByRole('combobox',{name:'Render optimization'})).toHaveValue('static');
});
