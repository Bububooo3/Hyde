import {expect,test} from '@playwright/test';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {unzipSync} from 'fflate';

test('editor, project archive, and isolated web playback render in this engine',async({page,context})=>{
  test.setTimeout(90_000);
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add rectangle'}).click();
  await page.getByRole('button',{name:'Add text'}).click();
  await page.getByRole('textbox',{name:'Text content'}).fill('Across browsers');
  const canvas=page.locator('.stage-frame canvas');
  await expect.poll(()=>canvas.evaluate((node:HTMLCanvasElement)=>node.toDataURL().length)).toBeGreaterThan(1000);
  const archive=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await (await archive).path())!);
  await expect(page.locator('.layer-name').filter({hasText:'Text'})).toBeVisible();
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:/Standalone web story/}).click();
  const zip=unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  const directory=await mkdtemp(join(tmpdir(),'hyde-engine-'));
  try{
    const html=join(directory,'index.html');await writeFile(html,zip['index.html']);
    const viewer=await context.newPage();viewer.on('pageerror',error=>errors.push(error.message));
    await viewer.goto(pathToFileURL(html).href);
    await expect.poll(()=>viewer.locator('canvas').first().evaluate((node:HTMLCanvasElement)=>node.toDataURL().length)).toBeGreaterThan(1000);
    await viewer.close();
  }finally{
    const absolute=await realpath(directory);
    if(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('hyde-engine-'))await rm(absolute,{recursive:true,force:true});
  }
  expect(errors).toEqual([]);
});
