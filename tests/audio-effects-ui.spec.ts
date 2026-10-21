import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

function toneWav(): Buffer {
  const rate=8000, samples=rate;
  const wav=Buffer.alloc(44+samples*2);
  wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
  wav.write('data',36);wav.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/rate)*8000),44+i*2);
  return wav;
}

test('audio effect order, bypass, reset, and project round trip',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');await page.getByRole('button',{name:'New project'}).click();await page.getByRole('button',{name:'Done'}).click();
  await page.locator('input[type=file][accept="image/*,video/*,audio/*"]').setInputFiles({name:'tone.wav',mimeType:'application/octet-stream',buffer:toneWav()});
  await expect(page.locator('.layer-name').filter({hasText:'tone'})).toHaveCount(1);
  await page.getByRole('combobox',{name:'Add audio effect'}).selectOption('echo');
  await page.getByRole('spinbutton',{name:'Echo Delay s'}).fill('0.5');
  await page.getByRole('checkbox',{name:'Enable Echo effect'}).uncheck();
  await page.getByRole('combobox',{name:'Add audio effect'}).selectOption('reverb');
  await page.getByRole('button',{name:'Move Reverb effect earlier'}).click();
  await expect(page.locator('.audio-effect-card strong')).toHaveText(['Reverb','Echo']);
  await page.getByRole('button',{name:'Reset Echo effect'}).click();
  await expect(page.getByRole('spinbutton',{name:'Echo Delay s'})).toHaveValue('0.28');
  await page.getByRole('button',{name:'Remove Reverb effect'}).click();
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();await page.getByRole('button',{name:'Download project copy'}).click();
  const saved=await download;await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await saved.path())!);
  await page.locator('.layer-name').filter({hasText:'tone'}).click();
  await expect(page.locator('.audio-effect-card strong')).toHaveText(['Echo']);
  await expect(page.getByRole('checkbox',{name:'Enable Echo effect'})).not.toBeChecked();
  await expect(page.getByRole('spinbutton',{name:'Echo Delay s'})).toHaveValue('0.28');
  expect((await readFile((await saved.path())!)).length).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
});
