import {expect,test,type Page} from '@playwright/test';

async function newProject(page:Page){
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done',exact:true}).click();
}

async function cameraTimes(page:Page){
  return page.locator('.camera-key-dot[data-property="x"]').evaluateAll(nodes=>nodes.map(node=>Number((node.getAttribute('aria-label')??'').match(/at ([\d.]+) seconds/)?.[1])));
}

test('scene camera keys move the stage and stay editable through selection, save and reopen',async({page})=>{
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await newProject(page);
  await page.getByRole('button',{name:'Add rectangle',exact:true}).click();
  await page.getByRole('textbox',{name:'Element name',exact:true}).fill('Camera target');
  await page.locator('.camera-panel summary').click();
  await expect(page.getByRole('spinbutton',{name:'Camera X'})).toHaveValue('960');
  const pivot=page.locator('.selection-overlay .pivot');
  const before=await pivot.boundingBox();expect(before).toBeTruthy();

  await page.getByRole('button',{name:'Keyframe camera x'}).click();
  const ruler=await page.locator('.ruler').boundingBox();expect(ruler).toBeTruthy();
  await page.mouse.click(ruler!.x+ruler!.width/2,ruler!.y+12);
  await page.getByRole('button',{name:'Auto key',exact:true}).click();
  await page.getByRole('spinbutton',{name:'Camera X'}).fill('1200');
  await page.getByRole('spinbutton',{name:'Camera X'}).press('Tab');
  const keys=page.locator('.camera-key-dot[data-property="x"]');
  await expect(keys).toHaveCount(2);
  await page.locator('.layer-name').filter({hasText:'Camera target'}).click();
  const after=await pivot.boundingBox();expect(after).toBeTruthy();
  expect(after!.x).toBeLessThan(before!.x-30);

  // A click on the visually transformed shape should resolve through the camera.
  const stage=page.locator('.stage-frame');
  const bounds=await stage.boundingBox();expect(bounds).toBeTruthy();
  await stage.click({position:{x:12,y:12}});
  await expect(page.locator('.selection-overlay .pivot')).toHaveCount(0);
  await page.mouse.click(after!.x+after!.width/2,after!.y+after!.height/2);
  await expect(page.getByRole('textbox',{name:'Element name',exact:true})).toHaveValue('Camera target');

  await keys.nth(0).click();
  await keys.nth(1).click({modifiers:['Control']});
  await expect(page.locator('.camera-key-dot.selected')).toHaveCount(2);
  const original=await cameraTimes(page);
  await page.keyboard.press('ArrowRight');
  const nudged=await cameraTimes(page);
  expect(nudged[0]).toBeGreaterThan(original[0]);
  expect(nudged[1]).toBeGreaterThan(original[1]);

  const marker=await keys.nth(1).boundingBox(),lane=await keys.nth(1).locator('xpath=..').boundingBox();
  expect(marker).toBeTruthy();expect(lane).toBeTruthy();
  const x=marker!.x+marker!.width/2,y=marker!.y+marker!.height/2;
  await page.mouse.move(x,y);await page.mouse.down();
  await page.mouse.move(x+lane!.width/24,y,{steps:8});await page.mouse.up();
  const dragged=await cameraTimes(page);
  expect(dragged[0]).toBeGreaterThan(nudged[0]);
  expect(dragged[1]).toBeGreaterThan(nudged[1]);

  const downloaded=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy',exact:true}).click();
  const file=await downloaded;
  const path=await file.path();expect(path).toBeTruthy();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles(path!);
  await expect(keys).toHaveCount(2);
  expect(await cameraTimes(page)).toEqual(dragged);
  if(!await page.locator('.camera-panel').evaluate(node=>node.hasAttribute('open')))await page.locator('.camera-panel summary').click();
  const newRuler=await page.locator('.ruler').boundingBox();expect(newRuler).toBeTruthy();
  await page.mouse.click(newRuler!.x+newRuler!.width*.9,newRuler!.y+12);
  await expect(page.getByRole('spinbutton',{name:'Camera X'})).toHaveValue('1200');
  expect(errors).toEqual([]);
});
