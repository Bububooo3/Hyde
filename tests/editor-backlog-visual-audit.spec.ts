import { expect, test, type Page } from '@playwright/test';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {strFromU8,unzipSync} from 'fflate';

async function pixel(page:Page,x:number,y:number):Promise<number[]> {
  return page.locator('.stage-frame canvas').evaluate(async (element:HTMLCanvasElement,{x,y})=>{
    const bitmap=await createImageBitmap(await (await fetch(element.toDataURL())).blob());
    const copy=document.createElement('canvas');copy.width=bitmap.width;copy.height=bitmap.height;
    const context=copy.getContext('2d')!;context.drawImage(bitmap,0,0);
    return [...context.getImageData(x,y,1,1).data].slice(0,3);
  },{x,y});
}

async function newProject(page:Page){
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done',exact:true}).click();
}

test('Union creates one visible editable object covering both different sources',async({page})=>{
  await newProject(page);
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.getByLabel('Element name').fill('Left');
  await page.getByRole('spinbutton',{name:'X',exact:true}).fill('900');
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.getByLabel('Element name').fill('Right');
  await page.getByRole('spinbutton',{name:'X',exact:true}).fill('1020');
  await page.getByLabel('Fill color hex').fill('#ff0000');
  await page.getByLabel('Fill color hex').press('Enter');
  await expect.poll(async()=>{const [red,green,blue]=await pixel(page,1290,780);return red>200&&green<80&&blue<80;}).toBe(true);
  const beforeRight=await pixel(page,1290,780);
  const rows=page.locator('.scene-element-row');
  await rows.filter({has:page.getByRole('button',{name:'Select Left'})}).click();
  await rows.filter({has:page.getByRole('button',{name:'Select Right'})}).click({modifiers:['Control']});
  const order=await page.locator('.inspector-scroll h3').allTextContents();
  expect(order.indexOf('Transform')).toBeLessThan(order.indexOf('Boolean shapes'));
  expect(order.indexOf('Transform')).toBeLessThan(order.indexOf('Object mask'));
  await page.getByRole('button',{name:'Union',exact:true}).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({has:page.getByRole('button',{name:/Select Union Left/})})).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Edit path on stage'})).toBeVisible();
  await expect.poll(()=>pixel(page,1290,780)).not.toEqual(beforeRight);
  expect(await pixel(page,1290,780)).toEqual(await pixel(page,1140,780));
  await page.keyboard.press('Control+z');
  await expect(rows).toHaveCount(2);
  await page.keyboard.press('Control+y');
  await expect(rows).toHaveCount(3);
});

test('Union of separated shapes remains one visible, editable, persistent object',async({page})=>{
  await newProject(page);
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.getByLabel('Element name').fill('Left');
  await page.getByRole('spinbutton',{name:'X',exact:true}).fill('700');
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.getByLabel('Element name').fill('Right');
  await page.getByRole('spinbutton',{name:'X',exact:true}).fill('1200');
  const rows=page.locator('.scene-element-row');
  await rows.filter({has:page.getByRole('button',{name:'Select Left'})}).click();
  await rows.filter({has:page.getByRole('button',{name:'Select Right'})}).click({modifiers:['Control']});
  await page.getByRole('button',{name:'Union',exact:true}).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({has:page.getByRole('button',{name:/Select Union Left/})})).toHaveCount(1);
  const background=await pixel(page,1200,780);
  await expect.poll(()=>pixel(page,940,780)).not.toEqual(background);
  await expect.poll(()=>pixel(page,1440,780)).not.toEqual(background);
  await page.getByRole('button',{name:'Edit path on stage'}).click();
  const contours=page.getByRole('combobox',{name:'Editable contour'});
  await expect(contours).toBeVisible();
  await contours.selectOption({label:'Island 2'});
  await expect(page.getByRole('spinbutton',{name:'Point X (local px)'})).toBeVisible();
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await (await download).path())!);
  await expect(rows).toHaveCount(3);
  await rows.filter({has:page.getByRole('button',{name:/Select Union Left/})}).click();
  if(await page.getByRole('button',{name:'Edit path on stage'}).isVisible())await page.getByRole('button',{name:'Edit path on stage'}).click();
  await expect(page.getByRole('combobox',{name:'Editable contour'})).toContainText('Island 2');
  await expect.poll(()=>pixel(page,940,780)).not.toEqual(background);
  await expect.poll(()=>pixel(page,1440,780)).not.toEqual(background);
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const webDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:/Standalone web story/}).click();
  const zip=unzipSync(new Uint8Array(await readFile((await (await webDownload).path())!)));
  const story=JSON.parse(strFromU8(zip['story.json']));
  expect(story.elements.filter((element:{name:string})=>element.name.startsWith('Union Left'))).toHaveLength(1);
  expect(story.elements.find((element:{name:string})=>element.name.startsWith('Union Left')).shapePath.islands).toHaveLength(1);
});

test('object mask mode can be chosen before adding a source',async({page})=>{
  await newProject(page);
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.getByLabel('Element name').fill('Target');
  await page.getByRole('button',{name:'Add ellipse'}).first().click();
  await page.getByLabel('Element name').fill('Source');
  await page.locator('.scene-element-row').filter({has:page.getByRole('button',{name:'Select Target'})}).click();
  const mode=page.getByRole('combobox',{name:'Object mask mode'});
  await expect(mode).toBeEnabled();
  await mode.selectOption('exclude');
  await expect(mode).toHaveValue('exclude');
  await page.getByRole('combobox',{name:'Add mask object'}).selectOption({label:'Source'});
  await page.locator('.object-mask-panel').getByRole('button',{name:'Add',exact:true}).click();
  await expect(mode).toHaveValue('exclude');
  await expect(page.locator('.mask-object-list')).toContainText('Source');
});

test('editing an image path clips the image pixels, not only its backing shape',async({page})=>{
  await newProject(page);
  const image='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#ff0000"/></svg>';
  await page.locator('input[type=file][accept="image/*,video/*,audio/*"]').setInputFiles({name:'red.svg',mimeType:'image/svg+xml',buffer:Buffer.from(image)});
  await expect(page.getByLabel('Element name')).toHaveValue('red');
  await expect(page.getByRole('spinbutton',{name:'Width',exact:true})).toHaveValue('200');
  const background=await pixel(page,500,500);
  await expect.poll(()=>pixel(page,1270,850)).not.toEqual(background);
  const shown=await pixel(page,1270,850);
  await page.getByRole('button',{name:'Convert to editable path'}).click();
  const originalPath=await page.locator('.path-overlay path').first().getAttribute('d');
  await page.getByRole('button',{name:'Select path point 3'}).click();
  await expect(page.getByRole('spinbutton',{name:'Point X (local px)'})).toHaveValue('200');
  await page.getByRole('spinbutton',{name:'Point X (local px)'}).fill('50');
  await page.getByRole('spinbutton',{name:'Point X (local px)'}).press('Enter');
  await expect(page.getByRole('spinbutton',{name:'Point X (local px)'})).toHaveValue('50');
  expect(await page.locator('.path-overlay path').first().getAttribute('d')).not.toBe(originalPath);
  await expect.poll(()=>pixel(page,1270,850)).toEqual(background);
  await page.keyboard.press('Control+z');
  await expect.poll(()=>pixel(page,1270,850)).toEqual(shown);
  const frame=await page.locator('.stage-frame').boundingBox();
  const handle=await page.locator('.path-overlay circle[aria-label="Move path point 3"]').boundingBox();
  expect(frame).toBeTruthy();expect(handle).toBeTruthy();
  const start={x:handle!.x+handle!.width/2,y:handle!.y+handle!.height/2};
  await page.mouse.move(start.x,start.y);await page.mouse.down();
  await page.mouse.move(start.x-150*frame!.width/1920,start.y,{steps:6});await page.mouse.up();
  await expect.poll(()=>pixel(page,1270,850)).toEqual(background);
});

test('four-corner shape path deforms image pixels inside the visible image',async({page})=>{
  await newProject(page);
  const image='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="100" height="200" fill="#ff0000"/><rect x="100" width="100" height="200" fill="#0000ff"/></svg>';
  await page.locator('input[type=file][accept="image/*,video/*,audio/*"]').setInputFiles({name:'stripes.svg',mimeType:'image/svg+xml',buffer:Buffer.from(image)});
  await expect(page.getByRole('spinbutton',{name:'Width',exact:true})).toHaveValue('200');
  await expect.poll(async()=>{const [red,,blue]=await pixel(page,1160,800);return red>150&&blue<100;}).toBe(true);
  await page.getByRole('button',{name:'Convert to editable path'}).click();
  await page.getByRole('button',{name:'Select path point 3'}).click();
  await expect(page.getByRole('spinbutton',{name:'Point X (local px)'})).toHaveValue('200');
  await page.getByRole('spinbutton',{name:'Point X (local px)'}).fill('50');
  await page.getByRole('spinbutton',{name:'Point X (local px)'}).press('Enter');
  await expect.poll(async()=>{const [red,,blue]=await pixel(page,1160,800);return red<100&&blue>150;}).toBe(true);
  await page.keyboard.press('Control+z');
  await expect.poll(async()=>{const [red,,blue]=await pixel(page,1160,800);return red>150&&blue<100;}).toBe(true);
  await page.keyboard.press('Control+y');
  await expect.poll(async()=>{const [red,,blue]=await pixel(page,1160,800);return red<100&&blue>150;}).toBe(true);
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await (await download).path())!);
  await expect.poll(async()=>{const [red,,blue]=await pixel(page,1160,800);return red<100&&blue>150;}).toBe(true);
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const webDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:/Standalone web story/}).click();
  const zip=unzipSync(new Uint8Array(await readFile((await (await webDownload).path())!)));
  const directory=await mkdtemp(join(tmpdir(),'hyde-path-warp-'));
  try{
    const html=join(directory,'index.html');await writeFile(html,zip['index.html']);
    const viewer=await page.context().newPage();
    try{
      await viewer.goto(pathToFileURL(html).href);
      await expect.poll(()=>viewer.locator('.player-screen canvas').evaluate((canvas:HTMLCanvasElement)=>{
        const copy=document.createElement('canvas');copy.width=canvas.width;copy.height=canvas.height;
        const context=copy.getContext('2d')!;context.drawImage(canvas,0,0);
        const [red,,blue]=context.getImageData(920,560,1,1).data;
        return red<100&&blue>150;
      })).toBe(true);
    }finally{await viewer.close();}
  }finally{
    const absolute=await realpath(directory);
    if(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('hyde-path-warp-'))await rm(absolute,{recursive:true,force:true});
  }
});

test('four-corner shape path also deforms image texture on a shape',async({page})=>{
  await newProject(page);
  const image='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="100" height="200" fill="#ff0000"/><rect x="100" width="100" height="200" fill="#0000ff"/></svg>';
  await page.locator('input[type=file][accept="image/*,video/*,audio/*"]').setInputFiles({name:'texture-stripes.svg',mimeType:'image/svg+xml',buffer:Buffer.from(image)});
  await page.locator('.scene-element-row').getByRole('button',{name:'Hide texture-stripes'}).click();
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.getByRole('spinbutton',{name:'Width',exact:true}).fill('200');
  await page.getByRole('spinbutton',{name:'Height',exact:true}).fill('200');
  await page.getByRole('combobox',{name:'Texture asset'}).selectOption({label:'texture-stripes.svg'});
  await expect.poll(async()=>{const [red,,blue]=await pixel(page,1160,800);return red>150&&blue<100;}).toBe(true);
  await page.getByRole('button',{name:'Convert to editable path'}).click();
  await page.getByRole('button',{name:'Select path point 3'}).click();
  await expect(page.getByRole('spinbutton',{name:'Point X (local px)'})).toHaveValue('200');
  await page.getByRole('spinbutton',{name:'Point X (local px)'}).fill('50');
  await page.getByRole('spinbutton',{name:'Point X (local px)'}).press('Enter');
  await expect.poll(async()=>{const [red,,blue]=await pixel(page,1160,800);return red<100&&blue>150;}).toBe(true);
});
