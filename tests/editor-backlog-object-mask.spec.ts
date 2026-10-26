import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';

test('object mask Include/Exclude follows refs and persists through undo, archive, and web export', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Add rectangle' }).first().click();
  await page.getByLabel('Element name').fill('Mask target');
  await page.getByRole('button', { name: 'Add ellipse' }).first().click();
  await page.getByLabel('Element name').fill('Mask source');
  await page.getByRole('spinbutton', { name: 'Width', exact: true }).fill('80');
  await page.getByRole('spinbutton', { name: 'Height', exact: true }).fill('80');
  const rows = page.locator('.scene-element-row');
  await rows.filter({ has: page.getByRole('button', { name: 'Hide Mask source' }) }).getByRole('button', { name: 'Hide Mask source' }).click();
  const canvas = page.locator('.stage-frame canvas');
  const pixels = () => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  const sample = () => canvas.evaluate(async (element: HTMLCanvasElement) => {
    const bitmap = await createImageBitmap(await (await fetch(element.toDataURL())).blob());
    const copy = document.createElement('canvas'); copy.width = bitmap.width; copy.height = bitmap.height;
    const context = copy.getContext('2d')!; context.drawImage(bitmap, 0, 0);
    const at = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
    return { center: at(1200, 780), rim: at(1270, 780), background: at(500, 500) };
  });
  const unmasked = await pixels();
  const unmaskedColors=await sample();
  expect(unmaskedColors.center).toEqual(unmaskedColors.rim);
  expect(unmaskedColors.center).not.toEqual(unmaskedColors.background);
  await rows.filter({ has: page.getByRole('button', { name: 'Select Mask target' }) }).click();
  await rows.filter({ has: page.getByRole('button', { name: 'Select Mask source' }) }).click({ modifiers: ['Control'] });
  await rows.filter({ has: page.getByRole('button', { name: 'Select Mask target' }) }).click({ button: 'right' });
  await page.locator('.scene-context-menu').getByRole('button', { name: 'Mask Object' }).click();
  await expect(page.locator('.mask-object-list')).toContainText('Mask source');
  await expect.poll(pixels).not.toBe(unmasked);
  await expect.poll(async () => { const colors = await sample(); return JSON.stringify(colors.rim) === JSON.stringify(colors.background); }).toBe(true);
  expect((await sample()).center).toEqual(unmaskedColors.center);
  const included = await pixels();
  await page.getByRole('combobox', { name: 'Object mask mode' }).selectOption('exclude');
  await expect.poll(pixels).not.toBe(included);
  await expect.poll(async () => { const colors = await sample(); return JSON.stringify(colors.center) === JSON.stringify(colors.background); }).toBe(true);
  expect((await sample()).rim).toEqual(unmaskedColors.rim);
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('combobox', { name: 'Object mask mode' })).toHaveValue('include');
  await page.keyboard.press('Control+y');
  await expect(page.getByRole('combobox', { name: 'Object mask mode' })).toHaveValue('exclude');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('button', { name: 'Download project copy' }).click();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await (await download).path())!);
  await expect(page.getByRole('combobox', { name: 'Object mask mode' })).toHaveValue('exclude');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const webDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: /Standalone web story/ }).click();
  const zip = unzipSync(new Uint8Array(await readFile((await (await webDownload).path())!)));
  const story = JSON.parse(strFromU8(zip['story.json']));
  const target = story.elements.find((element: { name: string }) => element.name === 'Mask target');
  const source = story.elements.find((element: { name: string }) => element.name === 'Mask source');
  expect(target.objectMask).toEqual({ mode: 'exclude', objectIds: [source.id] });
  const directory=await mkdtemp(join(tmpdir(),'hyde-object-mask-'));
  try{
    const html=join(directory,'index.html');await writeFile(html,zip['index.html']);
    const viewer=await page.context().newPage();
    try{
      await viewer.goto(pathToFileURL(html).href);
      const player=viewer.locator('.player-screen canvas');
      await expect(player).toHaveCount(1);
      const colors=await player.evaluate((canvas:HTMLCanvasElement)=>{
        const copy=document.createElement('canvas');copy.width=canvas.width;copy.height=canvas.height;
        const context=copy.getContext('2d')!;context.drawImage(canvas,0,0);
        const at=(x:number,y:number)=>[...context.getImageData(x,y,1,1).data].slice(0,3);
        return {center:at(960,540),rim:at(1030,540),background:at(400,300)};
      });
      expect(colors.center).toEqual(colors.background);
      expect(colors.rim).not.toEqual(colors.background);
    }finally{await viewer.close();}
  }finally{
    const absolute=await realpath(directory);
    if(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('hyde-object-mask-'))await rm(absolute,{recursive:true,force:true});
  }
  const panel=page.getByRole('region',{name:'Video and GIF export'});
  await panel.getByRole('combobox',{name:'Export range'}).selectOption('selected');
  await panel.getByRole('spinbutton',{name:'Export to seconds'}).fill('0.3');
  await panel.getByRole('spinbutton',{name:'Export width'}).fill('320');
  await panel.getByRole('button',{name:'GIF',exact:true}).click();
  await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption('6');
  const gifDownload=page.waitForEvent('download',{timeout:60000});
  await panel.getByRole('button',{name:'Export GIF'}).click();
  const gif=new Uint8Array(await readFile((await (await gifDownload).path())!));
  const gifColors=await page.evaluate(async bytes=>{
    const decoder=new (globalThis as any).ImageDecoder({data:new Uint8Array(bytes),type:'image/gif'});
    const {image}=await decoder.decode({frameIndex:0});
    const canvas=document.createElement('canvas');canvas.width=image.displayWidth;canvas.height=image.displayHeight;
    const context=canvas.getContext('2d')!;context.drawImage(image,0,0);
    const at=(x:number,y:number)=>[...context.getImageData(x,y,1,1).data].slice(0,3);
    const result={center:at(160,90),rim:at(171,90),background:at(80,40)};
    image.close();decoder.close();return result;
  },Array.from(gif));
  expect(gifColors.center).toEqual(gifColors.background);
  expect(gifColors.rim).not.toEqual(gifColors.background);
  await panel.getByRole('button',{name:'Video',exact:true}).click();
  await panel.getByRole('spinbutton',{name:'Export to seconds'}).fill('1');
  await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption('12');
  await panel.getByRole('combobox',{name:'Video format'}).selectOption('mp4');
  await expect(panel.getByRole('button',{name:'Export MP4'})).toBeEnabled({timeout:30000});
  const videoDownload=page.waitForEvent('download',{timeout:60000});
  await panel.getByRole('button',{name:'Export MP4'}).click();
  const video=new Uint8Array(await readFile((await (await videoDownload).path())!));
  const videoColors=await page.evaluate(async bytes=>{
    const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'video/mp4'}));
    const video=document.createElement('video');video.muted=true;video.src=url;document.body.append(video);
    try{
      await new Promise<void>((resolve,reject)=>{video.onloadedmetadata=()=>resolve();video.onerror=()=>reject(new Error('Mask video did not load.'));});
      await new Promise<void>((resolve,reject)=>{video.onseeked=()=>resolve();video.onerror=()=>reject(new Error('Mask video seek failed.'));video.currentTime=.5;});
      await video.play();
      await new Promise<void>(resolve=>video.requestVideoFrameCallback(()=>resolve()));
      video.pause();
      const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
      const context=canvas.getContext('2d')!;context.drawImage(video,0,0);
      const at=(x:number,y:number)=>[...context.getImageData(x,y,1,1).data].slice(0,3);
      return {center:at(160,90),rim:at(171,90),background:at(80,40)};
    }finally{video.pause();video.removeAttribute('src');video.load();video.remove();URL.revokeObjectURL(url);}
  },Array.from(video));
  const difference=(a:number[],b:number[])=>Math.max(...a.map((value,index)=>Math.abs(value-b[index])));
  expect(difference(videoColors.center,videoColors.background)).toBeLessThan(8);
  expect(difference(videoColors.rim,videoColors.background)).toBeGreaterThan(40);
});
