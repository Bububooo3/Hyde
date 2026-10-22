import {expect,test} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {strFromU8,unzipSync} from 'fflate';

test('workspace view and timeline filtering stay out of project and web story',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Open example',exact:true}).click();
  await page.getByRole('textbox',{name:'Project name'}).fill('Workspace boundary');
  await expect(page.getByText('Autosaved in this browser',{exact:true})).toBeVisible();

  const section=page.locator('.section-strip').getByRole('button',{name:'Backdrop'});
  await section.click();
  await expect(section).toHaveClass(/hidden-section/);
  await page.getByRole('button',{name:'Zoom in'}).click();
  await expect(page.locator('.zoom-control span')).toHaveText('110%');
  await page.getByRole('button',{name:'View',exact:true}).click();
  await page.getByRole('button',{name:'Show active rows only'}).click();
  await expect(page.getByRole('button',{name:'Showing active timeline rows'})).toBeVisible();

  const downloadEvent=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export',exact:true}).click();
  await page.getByRole('button',{name:/Standalone web story/}).click();
  const download=await downloadEvent;
  const files=unzipSync(new Uint8Array(await readFile((await download.path())!)));
  const story=JSON.parse(strFromU8(files['story.json']));
  expect(story.name).toBe('Workspace boundary');
  expect(story.elements.some((element:{section?:string})=>element.section==='Backdrop')).toBe(true);
  for(const viewField of ['showAll','hiddenSections','zoom','pan','leftWidth','rightWidth','timelineScale','timelineHeight']){
    expect(story).not.toHaveProperty(viewField);
  }

  page.on('dialog',dialog=>dialog.accept());
  await page.reload();
  await page.getByRole('button',{name:/Resume Workspace boundary/}).click();
  await expect(page.getByRole('textbox',{name:'Project name'})).toHaveValue('Workspace boundary');
  await expect(page.locator('.section-strip').getByRole('button',{name:'Backdrop'})).not.toHaveClass(/hidden-section/);
  await expect(page.locator('.zoom-control span')).toHaveText('100%');
  await page.getByRole('button',{name:'View',exact:true}).click();
  await expect(page.getByRole('button',{name:'Show active rows only'})).toBeVisible();
});
