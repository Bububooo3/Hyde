import {expect,test} from '@playwright/test';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {unzipSync} from 'fflate';

test('media corner pin warps the stage image and persists through project and web export',async({page,context})=>{
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#f02540"/></svg>';
  await page.locator('input[type=file][accept="image/*,video/*,audio/*"]').setInputFiles({name:'pin-test.svg',mimeType:'image/svg+xml',buffer:Buffer.from(svg)});
  await page.getByRole('button',{name:'Enable four-corner pin'}).click();
  const overlay=page.locator('.pin-overlay');
  await expect(overlay).toBeVisible();
  const canvas=page.locator('.stage-frame canvas');
  const frame=()=>canvas.evaluate((element:HTMLCanvasElement)=>element.toDataURL());
  await expect.poll(async()=>{const first=await frame();await page.waitForTimeout(80);return first===await frame();}).toBe(true);
  const renderedBefore=await frame();
  const outlineBefore=await overlay.locator('path').getAttribute('d');
  const corner=overlay.locator('circle[aria-label="Move media corner 1"]');
  const box=await corner.boundingBox();expect(box).toBeTruthy();
  await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);
  await page.mouse.down();
  await page.mouse.move(box!.x+box!.width/2+35,box!.y+box!.height/2+18,{steps:5});
  await page.mouse.up();
  const outlineAfter=await overlay.locator('path').getAttribute('d');
  expect(outlineAfter).not.toBe(outlineBefore);
  await expect.poll(frame).not.toBe(renderedBefore);
  const renderedAfter=await frame();
  await page.keyboard.press('Control+z');
  await expect(overlay.locator('path')).toHaveAttribute('d',outlineBefore!);
  await expect.poll(frame).toBe(renderedBefore);
  await page.keyboard.press('Control+Shift+z');
  await expect(overlay.locator('path')).toHaveAttribute('d',outlineAfter!);
  await expect.poll(frame).toBe(renderedAfter);
  const downloaded=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await (await downloaded).path())!);
  await page.locator('.layer-name').filter({hasText:'pin-test'}).click();
  await expect(page.getByRole('button',{name:/editing corners|Edit media corners on stage/})).toBeVisible();
  if(await page.getByRole('button',{name:'Edit media corners on stage'}).isVisible())await page.getByRole('button',{name:'Edit media corners on stage'}).click();
  await expect(overlay.locator('path')).toHaveAttribute('d',outlineAfter!);
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const webDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:/Standalone web story/}).click();
  const zip=unzipSync(new Uint8Array(await readFile((await (await webDownload).path())!)));
  const directory=await mkdtemp(join(tmpdir(),'hyde-pin-'));
  try{
    const html=join(directory,'index.html');await writeFile(html,zip['index.html']);
    const viewer=await context.newPage(),errors:string[]=[];
    viewer.on('pageerror',error=>errors.push(error.message));
    await viewer.goto(pathToFileURL(html).href);
    const pin=await viewer.evaluate(()=>{
      const story=JSON.parse(document.querySelector('#hyde-story')!.textContent!);
      return story.elements.find((element:{name:string})=>element.name==='pin-test')?.mediaPin;
    });
    expect(pin).toHaveLength(4);
    const rendered=()=>viewer.locator('canvas').first().evaluate((element:HTMLCanvasElement)=>{
      const probe=document.createElement('canvas');probe.width=element.width;probe.height=element.height;
      const context=probe.getContext('2d')!;context.drawImage(element,0,0);
      return [...context.getImageData(480,270,1,1).data];
    });
    await expect.poll(async()=>{const [red,green,blue]=await rendered();return red>180&&green<100&&blue<120;}).toBe(true);
    expect(errors).toEqual([]);
    await viewer.close();
  }finally{
    const absolute=await realpath(directory);
    if(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('hyde-pin-'))await rm(absolute,{recursive:true,force:true});
  }
});
