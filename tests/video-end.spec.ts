import {expect,test} from '@playwright/test';
import {videoFixture} from './video-fixture';

test('a video texture can hold its final frame or reveal the underlying shape',async({page})=>{
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add rectangle'}).click();
  const video=await videoFixture(page,440,'#e64242');
  await page.locator('input[type=file][accept="image/*,video/*,audio/*"]').setInputFiles({name:`red.${video.extension}`,mimeType:video.mime,buffer:video.bytes});
  await expect(page.locator('.layer-name').filter({hasText:'red'})).toBeVisible();
  await page.locator('.layer-name').filter({hasText:'red'}).click();
  await page.keyboard.press('Delete');
  await page.locator('.layer-name').filter({hasText:'Rectangle'}).click();
  await page.getByRole('combobox',{name:'Texture asset'}).selectOption({label:`red.${video.extension}`});
  const canvas=page.locator('.stage-frame canvas');
  const pixel=()=>canvas.evaluate((element:HTMLCanvasElement)=>{
    const scratch=document.createElement('canvas');scratch.width=element.width;scratch.height=element.height;
    const context=scratch.getContext('2d')!;context.drawImage(element,0,0);
    return Array.from(context.getImageData(1200,780,1,1).data).slice(0,3);
  });
  const ruler=await page.locator('.ruler > span').filter({hasText:'2s'}).first().boundingBox();expect(ruler).toBeTruthy();
  await page.mouse.click(ruler!.x+ruler!.width/2,ruler!.y+ruler!.height/2);
  await expect(page.getByRole('combobox',{name:'Video end behavior'})).toHaveValue('hold');
  await expect.poll(async()=>{const [r,g,b]=await pixel();return r>g*1.5&&r>b*1.5;}).toBe(true);
  await page.getByRole('combobox',{name:'Video end behavior'}).selectOption('hide');
  await expect.poll(async()=>{const [r,g,b]=await pixel();return r>180&&g>130&&b<150;}).toBe(true);
  await page.getByRole('combobox',{name:'Video end behavior'}).selectOption('hold');
  await expect.poll(async()=>{const [r,g,b]=await pixel();return r>g*1.5&&r>b*1.5;}).toBe(true);
});
