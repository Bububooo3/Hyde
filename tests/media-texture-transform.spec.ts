import {expect,test} from '@playwright/test';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {unzipSync} from 'fflate';

test('a masked image fill can be positioned independently and survives project and web export',async({page,context})=>{
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add ellipse'}).first().click();
  const frame=await page.locator('.stage-frame').boundingBox();expect(frame).toBeTruthy();
  await page.evaluate(({x,y})=>{
    const image='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="50" height="100" fill="#ec1944"/><rect x="50" width="50" height="100" fill="#2162c8"/></svg>';
    const file=new File([image],'halves.svg',{type:'image/svg+xml'}),data=new DataTransfer();data.items.add(file);
    document.querySelector('.stage-workspace')!.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientX:x,clientY:y}));
  },{x:frame!.x+frame!.width/2,y:frame!.y+frame!.height/2});
  await expect(page.locator('.layer-name')).toHaveCount(1);
  await expect(page.getByRole('combobox',{name:'Texture asset'})).toContainText('halves.svg');
  const image=()=>page.locator('.stage-frame canvas').evaluate((canvas:HTMLCanvasElement)=>canvas.toDataURL());
  await expect.poll(async()=>{const first=await image();await page.waitForTimeout(80);return first===await image();}).toBe(true);
  const before=await image();
  await page.getByRole('spinbutton',{name:'Offset X px'}).fill('60');
  await expect.poll(image).not.toBe(before);
  const archiveDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await (await archiveDownload).path())!);
  await page.locator('.layer-name').filter({hasText:'Ellipse'}).click();
  await expect(page.getByRole('spinbutton',{name:'Offset X px'})).toHaveValue('60');
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const webDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:/Standalone web story/}).click();
  const zip=unzipSync(new Uint8Array(await readFile((await (await webDownload).path())!)));
  const directory=await mkdtemp(join(tmpdir(),'hyde-texture-'));
  try{
    const html=join(directory,'index.html');await writeFile(html,zip['index.html']);
    const viewer=await context.newPage(),errors:string[]=[];
    viewer.on('pageerror',error=>errors.push(error.message));
    await viewer.goto(pathToFileURL(html).href);
    const exported=await viewer.evaluate(()=>JSON.parse(document.querySelector('#hyde-story')!.textContent!).elements.find((element:{kind:string})=>element.kind==='ellipse'));
    expect(exported.mediaTransform).toMatchObject({x:60,y:0,scaleX:1,scaleY:1,rotation:0});
    await expect.poll(()=>viewer.locator('canvas').first().evaluate((canvas:HTMLCanvasElement)=>canvas.toDataURL().length)).toBeGreaterThan(1000);
    expect(errors).toEqual([]);
    await viewer.close();
  }finally{
    const absolute=await realpath(directory);
    if(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('hyde-texture-'))await rm(absolute,{recursive:true,force:true});
  }
});
