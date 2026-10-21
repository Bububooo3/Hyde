import {expect,test} from '@playwright/test';

function toneWav(){
  const rate=8000,count=rate,buffer=Buffer.alloc(44+count*2);
  buffer.write('RIFF',0);buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);
  buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);
  buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);
  buffer.write('data',36);buffer.writeUInt32LE(count*2,40);
  for(let index=0;index<count;index++)buffer.writeInt16LE(Math.round(Math.sin(index*2*Math.PI*440/rate)*8000),44+index*2);
  return {name:'tail.wav',mimeType:'audio/wav',buffer};
}

test('the editor shows and plays the effect tail after the final frame',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('spinbutton',{name:'Duration s'}).fill('1');
  await page.getByRole('button',{name:'Done'}).click();
  await page.locator('input[type=file][accept="image/*,video/*,audio/*"]').setInputFiles(toneWav());
  await page.getByRole('combobox',{name:'Add audio effect'}).selectOption('reverb');
  const clip=page.locator('.audio-clip');
  const tail=page.locator('.effect-tail');
  await expect(tail).toHaveCount(1);
  const clipBox=await clip.boundingBox(),tailBox=await tail.boundingBox();
  expect(clipBox&&tailBox).toBeTruthy();
  expect(tailBox!.x).toBeCloseTo(clipBox!.x+clipBox!.width,0);
  expect(tailBox!.width).toBeGreaterThan(20);
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await expect(page.locator('.audio-tail-status')).toBeVisible({timeout:5000});
  await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Play',exact:true})).toBeVisible({timeout:5000});
  await expect(page.locator('.audio-tail-status')).toHaveCount(0);
});
