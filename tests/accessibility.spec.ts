import {expect,test} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {unzipSync} from 'fflate';

async function violations(page:import('@playwright/test').Page){
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
  return result.violations.map(item=>({id:item.id,impact:item.impact,targets:item.nodes.map(node=>`${node.target.join(' ')}: ${node.failureSummary?.split('\n')[1]??''}`)}));
}

test('welcome and editor have no automatically detected WCAG A/AA violations',async({page})=>{
  await page.goto('/');
  expect(await violations(page)).toEqual([]);
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add text'}).click();
  expect(await violations(page)).toEqual([]);
});

test('isolated player controls have no automatically detected WCAG A/AA violations',async({page,context})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:/Standalone web story/}).click();
  const zip=unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  const directory=await mkdtemp(join(tmpdir(),'hyde-a11y-'));
  try{
    const html=join(directory,'index.html');await writeFile(html,zip['index.html']);
    const viewer=await context.newPage();await viewer.goto(pathToFileURL(html).href);
    await expect(viewer.getByRole('slider',{name:'Playback position'})).toBeVisible();
    expect(await violations(viewer)).toEqual([]);
    await viewer.close();
  }finally{
    const absolute=await realpath(directory);
    if(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('hyde-a11y-'))await rm(absolute,{recursive:true,force:true});
  }
});
