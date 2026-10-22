import {expect,test} from '@playwright/test';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {unzipSync} from 'fflate';

test('word animation plays through editor and standalone renderer and survives reopening',async({page,context})=>{
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add text'}).click();
  await page.getByRole('textbox',{name:'Text content'}).fill('A bright new idea');
  await page.getByRole('checkbox',{name:'Animate text',exact:true}).check();
  await page.getByRole('combobox',{name:'Text animation effect'}).selectOption('scatter');
  await page.getByRole('combobox',{name:'Text animation unit'}).selectOption('word');
  const canvas=page.locator('.stage-frame canvas');
  const image=()=>canvas.evaluate((element:HTMLCanvasElement)=>element.toDataURL());
  const seekTwoSeconds=async()=>{const box=await page.locator('.ruler > span').filter({hasText:'2s'}).first().boundingBox();expect(box).toBeTruthy();await page.mouse.click(box!.x+box!.width/2,box!.y+box!.height/2);};
  await expect.poll(async()=>{const first=await image();await page.waitForTimeout(80);return first===await image();}).toBe(true);
  const atStart=await image();
  await seekTwoSeconds();
  await expect.poll(image).not.toBe(atStart);
  const completed=await image();
  const downloaded=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await (await downloaded).path())!);
  await page.locator('.layer-name').filter({hasText:'Text'}).click();
  await expect(page.getByRole('checkbox',{name:'Animate text',exact:true})).toBeChecked();
  await expect(page.getByRole('combobox',{name:'Text animation effect'})).toHaveValue('scatter');
  await seekTwoSeconds();
  await expect.poll(image).toBe(completed);
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const webDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:/Standalone web story/}).click();
  const zip=unzipSync(new Uint8Array(await readFile((await (await webDownload).path())!)));
  const directory=await mkdtemp(join(tmpdir(),'hyde-text-'));
  try{
    const html=join(directory,'index.html');await writeFile(html,zip['index.html']);
    const viewer=await context.newPage(),errors:string[]=[];
    viewer.on('pageerror',error=>errors.push(error.message));
    await viewer.goto(pathToFileURL(html).href);
    const effect=await viewer.evaluate(()=>JSON.parse(document.querySelector('#hyde-story')!.textContent!).elements.find((element:{kind:string})=>element.kind==='text')?.textAnimation?.effect);
    expect(effect).toBe('scatter');
    const portableCanvas=viewer.locator('canvas').first();
    await expect.poll(()=>portableCanvas.evaluate((element:HTMLCanvasElement)=>element.toDataURL().length)).toBeGreaterThan(1000);
    const startFrame=await portableCanvas.evaluate((element:HTMLCanvasElement)=>element.toDataURL());
    await viewer.getByRole('slider',{name:'Playback position'}).evaluate((input:HTMLInputElement)=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'2');
      input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
    });
    await expect.poll(()=>portableCanvas.evaluate((element:HTMLCanvasElement)=>element.toDataURL())).not.toBe(startFrame);
    expect(errors).toEqual([]);
    await viewer.close();
  }finally{
    const absolute=await realpath(directory);
    if(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('hyde-text-'))await rm(absolute,{recursive:true,force:true});
  }
});
