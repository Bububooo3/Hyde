import {expect,test} from '@playwright/test';

function toneWav(name:string,seconds=3){
  const rate=8000,count=rate*seconds,buffer=Buffer.alloc(44+count*2);
  buffer.write('RIFF',0);buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);
  buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);
  buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);
  buffer.write('data',36);buffer.writeUInt32LE(count*2,40);
  for(let index=0;index<count;index++)buffer.writeInt16LE(Math.round(Math.sin(index*2*Math.PI*(name==='first'?440:660)/rate)*8000),44+index*2);
  return {name:`${name}.wav`,mimeType:'audio/wav',buffer};
}

test('audio preview restores project playback and clears on seek or natural end',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.locator('input[type=file][accept="image/*,video/*,audio/*"]').setInputFiles([toneWav('first'),toneWav('second')]);
  await page.locator('.layer-name').filter({hasText:'first'}).click();
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Preview audio object'}).click();
  await expect(page.getByRole('button',{name:'Stop audio preview'}).first()).toBeVisible();
  await page.locator('.audio-preview-section').getByRole('button',{name:'Stop audio preview'}).click();
  await expect(page.locator('.audio-preview-section').getByRole('button',{name:'Preview audio object'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Preview audio object'}).click();
  await page.getByRole('button',{name:'Back to start'}).click();
  await expect(page.getByRole('button',{name:'Stop audio preview'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Play',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Preview audio object'}).click();
  await expect(page.locator('.audio-preview-section').getByRole('button',{name:'Preview audio object'})).toBeVisible({timeout:7000});
  await expect(page.getByRole('button',{name:'Play',exact:true})).toBeVisible();
});
