import {expect,test} from '@playwright/test';

async function blankProject(page: import('@playwright/test').Page){
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
}

test('ordinary wheel pans the timeline; Control-wheel changes its scale',async({page})=>{
  await blankProject(page);
  for(let i=0;i<4;i++)await page.getByRole('button',{name:'Zoom timeline in'}).click();
  const scroll=page.locator('.timeline-scroll'),ruler=page.locator('.ruler');
  const width=await ruler.evaluate(node=>node.getBoundingClientRect().width);
  const bounds=await ruler.boundingBox();expect(bounds).toBeTruthy();
  await page.mouse.move(bounds!.x+Math.min(300,bounds!.width/2),bounds!.y+12);
  await page.mouse.wheel(0,250);
  await expect.poll(()=>scroll.evaluate(node=>node.scrollLeft)).toBeGreaterThan(0);
  expect(await ruler.evaluate(node=>node.getBoundingClientRect().width)).toBeCloseTo(width,0);
  const viewport=await scroll.boundingBox();expect(viewport).toBeTruthy();
  await page.mouse.move(viewport!.x+Math.min(400,viewport!.width/2),bounds!.y+12);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0,-250);
  await page.keyboard.up('Control');
  await expect.poll(()=>ruler.evaluate(node=>node.getBoundingClientRect().width)).toBeGreaterThan(width);
});

test('timeline clip selection supports Shift range, group nudging and group drag',async({page})=>{
  await blankProject(page);
  for(const name of ['First','Second','Third']){
    await page.getByRole('button',{name:'Add rectangle'}).first().click();
    await page.getByRole('textbox',{name:'Element name'}).fill(name);
    await page.getByRole('spinbutton',{name:'Duration s'}).fill('2');
  }
  const clip=(name:string)=>page.locator('.clip-block').filter({hasText:name});
  const labels=page.locator('.timeline-row .timeline-label');
  await labels.filter({hasText:'Third'}).click();
  await labels.filter({hasText:'First'}).click({modifiers:['Shift']});
  await expect(page.locator('.clip-block.timeline-item-selected')).toHaveCount(3);
  await page.keyboard.press('ArrowRight');
  const starts=await Promise.all(['First','Second','Third'].map(name=>clip(name).evaluate(node=>Number.parseFloat((node as HTMLElement).style.left))));
  for(const start of starts)expect(start).toBeGreaterThan(0);
  const before=starts;
  const box=await clip('Second').boundingBox(),lane=await clip('Second').locator('xpath=..').boundingBox();expect(box).toBeTruthy();expect(lane).toBeTruthy();
  await page.mouse.move(box!.x+Math.min(40,box!.width/2),box!.y+box!.height/2);
  await page.mouse.down();
  await page.mouse.move(box!.x+Math.min(40,box!.width/2)+lane!.width/8,box!.y+box!.height/2,{steps:8});
  await page.mouse.up();
  const after=await Promise.all(['First','Second','Third'].map(name=>clip(name).evaluate(node=>Number.parseFloat((node as HTMLElement).style.left))));
  for(let i=0;i<3;i++)expect(after[i]).toBeGreaterThan(before[i]);
});

test('keyframes support additive selection, range selection and grouped edits',async({page})=>{
  await blankProject(page);
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.getByRole('button',{name:'Keyframe rotation'}).click();
  const ruler=page.locator('.ruler');
  for(const fraction of [.25,.5]){
    const box=await ruler.boundingBox();expect(box).toBeTruthy();
    await page.mouse.click(box!.x+box!.width*fraction,box!.y+12);
    await page.getByRole('button',{name:'Keyframe rotation'}).click();
  }
  const keys=page.locator('.key-dot');await expect(keys).toHaveCount(3);
  await keys.nth(0).click();
  await keys.nth(1).click({modifiers:['Control']});
  await expect(page.locator('.key-dot.selected')).toHaveCount(2);
  await keys.nth(2).click({modifiers:['Shift']});
  await expect(page.locator('.key-dot.selected')).toHaveCount(2);
  const before=await keys.allTextContents();expect(before).toHaveLength(3);
  const timesBefore=await keys.evaluateAll(nodes=>nodes.map(node=>Number((node.getAttribute('aria-label')??'').match(/at ([\d.]+) seconds/)?.[1])));
  await page.keyboard.press('ArrowRight');
  const timesAfter=await keys.evaluateAll(nodes=>nodes.map(node=>Number((node.getAttribute('aria-label')??'').match(/at ([\d.]+) seconds/)?.[1])));
  expect(timesAfter[0]).toBe(timesBefore[0]);
  expect(timesAfter[1]).toBeGreaterThan(timesBefore[1]);
  expect(timesAfter[2]).toBeGreaterThan(timesBefore[2]);
  const handle=await keys.nth(1).boundingBox(),lane=await keys.nth(1).locator('xpath=..').boundingBox();expect(handle).toBeTruthy();expect(lane).toBeTruthy();
  await page.mouse.move(handle!.x+handle!.width/2,handle!.y+handle!.height/2);
  await page.mouse.down();
  await page.mouse.move(handle!.x+handle!.width/2+lane!.width/16,handle!.y+handle!.height/2,{steps:8});
  await page.mouse.up();
  const timesAfterDrag=await keys.evaluateAll(nodes=>nodes.map(node=>Number((node.getAttribute('aria-label')??'').match(/at ([\d.]+) seconds/)?.[1])));
  expect(timesAfterDrag[0]).toBe(timesBefore[0]);
  expect(timesAfterDrag[1]).toBeGreaterThan(timesAfter[1]);
  expect(timesAfterDrag[2]).toBeGreaterThan(timesAfter[2]);
  await page.getByRole('combobox',{name:'Easing family'}).selectOption('quad');
  await page.keyboard.press('Delete');
  await expect(keys).toHaveCount(1);
});

test('timeline marquee selects clips across rows, and context menus stay compact',async({page})=>{
  await blankProject(page);
  for(const name of ['One','Two']){
    await page.getByRole('button',{name:'Add rectangle'}).first().click();
    await page.getByRole('textbox',{name:'Element name'}).fill(name);
    await page.getByRole('spinbutton',{name:'Start s'}).fill('2');
    await page.getByRole('spinbutton',{name:'Duration s'}).fill('2');
  }
  const lanes=page.locator('.timeline-row .timeline-lane');
  const first=await lanes.first().boundingBox(),last=await lanes.last().boundingBox();expect(first).toBeTruthy();expect(last).toBeTruthy();
  const startX=first!.x+10,endX=first!.x+first!.width*.65;
  await page.mouse.move(startX,first!.y+first!.height/2);
  await page.mouse.down();
  await page.mouse.move(endX,last!.y+last!.height/2,{steps:8});
  await page.mouse.up();
  await expect(page.locator('.clip-block.timeline-item-selected')).toHaveCount(2);
  await page.locator('.stage-frame').click({button:'right',position:{x:10,y:10}});
  const menu=page.locator('.context-menu').last();
  await expect(menu).toBeVisible();
  expect((await menu.boundingBox())!.width).toBeLessThan(200);
});
