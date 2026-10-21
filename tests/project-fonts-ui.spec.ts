import {expect,test} from '@playwright/test';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {strFromU8,unzipSync} from 'fflate';

test('a local font and its notice survive project and isolated web export',async({page,context})=>{
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add text'}).click();
  const fontFile=resolve('node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2');
  await page.locator('input[type=file][accept=".woff2,.woff,.ttf,.otf"]').setInputFiles(fontFile);
  await expect(page.locator('.project-fonts-panel .project-font-entry')).toHaveCount(1);
  await expect(page.locator('.project-fonts-panel .project-font-entry').getByRole('button',{name:'Using'})).toBeVisible();
  const notice='SIL OPEN FONT LICENSE Version 1.1 — project font notice';
  await page.getByRole('textbox',{name:/License notice for/}).fill(notice);
  await page.getByRole('textbox',{name:/License notice for/}).press('Tab');
  const archiveDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  const archive=unzipSync(new Uint8Array(await readFile((await (await archiveDownload).path())!)));
  expect(strFromU8(archive['licenses/fonts/0.txt'])).toBe(notice);
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await (await archiveDownload).path())!);
  await page.locator('.layer-name').filter({hasText:'Text'}).click();
  await expect(page.locator('.project-fonts-panel .project-font-entry').getByRole('button',{name:'Using'})).toBeVisible();
  await expect(page.getByRole('textbox',{name:/License notice for/})).toHaveValue(notice);
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const webDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:/Standalone web story/}).click();
  const web=unzipSync(new Uint8Array(await readFile((await (await webDownload).path())!)));
  expect(Object.keys(web).some(name=>name.startsWith('licenses/fonts/')&&strFromU8(web[name])===notice)).toBe(true);
  const directory=await mkdtemp(join(tmpdir(),'hyde-font-'));
  try{
    const html=join(directory,'index.html');await writeFile(html,web['index.html']);
    const viewer=await context.newPage(),errors:string[]=[];
    viewer.on('pageerror',error=>errors.push(error.message));
    await viewer.goto(pathToFileURL(html).href);
    await expect.poll(()=>viewer.evaluate(()=>{
      const project=JSON.parse(document.querySelector('#hyde-story')!.textContent!);
      const family=project.elements.find((element:{kind:string})=>element.kind==='text').fontFamily;
      return [...document.fonts].some(face=>face.family===family&&face.status==='loaded');
    })).toBe(true);
    expect(errors).toEqual([]);
    await viewer.close();
  }finally{
    const absolute=await realpath(directory);
    if(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('hyde-font-'))await rm(absolute,{recursive:true,force:true});
  }
});

test('bundled Google Font can be applied offline as a project asset',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add text'}).click();
  await page.getByRole('button',{name:'Add Inter font'}).click();
  const entry=page.locator('.project-fonts-panel .project-font-entry').filter({hasText:'Inter (Google Fonts).woff2'});
  await expect(entry.getByRole('button',{name:'Using'})).toBeVisible();
  await expect(entry.getByRole('textbox',{name:/License notice/})).toHaveValue(/SIL OPEN FONT LICENSE/);
  await expect(page.getByRole('button',{name:'Added Inter font'})).toBeDisabled();
  await expect.poll(()=>page.evaluate(()=>{
    const face=[...document.fonts].find(item=>item.family.startsWith('HydeFont_'));
    return !!face&&face.status==='loaded';
  })).toBe(true);
  await page.getByRole('searchbox',{name:'Search bundled fonts'}).fill('handwriting');
  await expect(page.getByRole('button',{name:'Add Caveat font'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Add Inter font'})).toHaveCount(0);
  await page.getByRole('button',{name:'Add Caveat font'}).click();
  await expect(page.getByRole('button',{name:'Added Caveat font'})).toBeDisabled();
  await expect(page.locator('.project-fonts-panel .project-font-entry').filter({hasText:'Caveat (Google Fonts).woff2'}).getByRole('button',{name:'Using'})).toBeVisible();
});
