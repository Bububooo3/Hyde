import {expect,test} from '@playwright/test';

const svg=(color:string)=>Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${color}"/></svg>`);

test('texture keys switch assets, expose the switch point, and survive reopening',async({page})=>{
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add rectangle'}).click();
  await page.locator('input[type=file][accept="image/*,video/*,audio/*"]').setInputFiles([
    {name:'red.svg',mimeType:'image/svg+xml',buffer:svg('#e64242')},
    {name:'blue.svg',mimeType:'image/svg+xml',buffer:svg('#2369dc')},
  ]);
  await expect(page.getByRole('combobox',{name:'Texture asset'})).toContainText('blue.svg');
  for(const name of ['blue','red']){
    await page.locator('.layer-name').filter({hasText:name}).click();
    await page.keyboard.press('Delete');
  }
  await page.locator('.layer-name').filter({hasText:'Rectangle'}).click();
  const texture=page.getByRole('combobox',{name:'Texture asset'});
  await texture.selectOption({label:'red.svg'});
  await page.getByRole('button',{name:'Keyframe texture'}).click();
  const canvas=page.locator('.stage-frame canvas');
  const frame=()=>canvas.evaluate((element:HTMLCanvasElement)=>element.toDataURL());
  await expect.poll(async()=>{const before=await frame();await page.waitForTimeout(60);return before===await frame();}).toBe(true);
  const red=await frame();
  const second=await page.locator('.ruler > span').filter({hasText:'2s'}).first().boundingBox();expect(second).toBeTruthy();
  await page.mouse.click(second!.x+second!.width/2,second!.y+second!.height/2);
  await page.getByRole('button',{name:'Auto key'}).click();
  await texture.selectOption({label:'blue.svg'});
  await expect(page.locator('.property-assetId .key-dot')).toHaveCount(2);
  await expect.poll(frame).not.toBe(red);
  await page.locator('.property-assetId .key-dot').first().click();
  await expect(page.getByRole('combobox',{name:'Texture key value'})).toHaveValue(/.+/);
  await page.getByRole('spinbutton',{name:'Texture key switch point percent'}).fill('75');
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await (await download).path())!);
  await page.locator('.layer-name').filter({hasText:'Rectangle'}).click();
  await expect(page.locator('.property-assetId .key-dot')).toHaveCount(2);
  await page.locator('.property-assetId .key-dot').first().click();
  await expect(page.getByRole('spinbutton',{name:'Texture key switch point percent'})).toHaveValue('75');
});
