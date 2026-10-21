import {expect,test} from '@playwright/test';

async function blankProject(page:import('@playwright/test').Page){
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
}

test('scene names edit inline with Enter, Escape, blur, and undo',async({page})=>{
  await blankProject(page);
  const block=page.locator('.sequence-block').first();
  await block.locator('.sequence-name').dblclick();
  const input=page.getByRole('textbox',{name:'Scene name'});
  await expect(input).toBeVisible();
  await input.fill('Opening');await input.press('Enter');
  await expect(block.locator('.sequence-name')).toContainText('Opening');
  await block.locator('.sequence-name').dblclick();
  await input.fill('Discarded');await input.press('Escape');
  await expect(block.locator('.sequence-name')).toContainText('Opening');
  await block.locator('.sequence-name').dblclick();
  await input.fill('Introduction');
  await page.locator('.timeline-title').click();
  await expect(block.locator('.sequence-name')).toContainText('Introduction');
  await page.keyboard.press('Control+z');
  await expect(block.locator('.sequence-name')).toContainText('Opening');
});

test('scene duration accepts exact seconds and aligns to frames explicitly',async({page})=>{
  await blankProject(page);
  const block=page.locator('.sequence-block').first();
  await block.click({button:'right'});
  await page.getByRole('button',{name:'Set scene duration…'}).click();
  const duration=page.getByRole('spinbutton',{name:'Scene duration in seconds'});
  await duration.fill('3');
  expect(await duration.evaluate((input:HTMLInputElement)=>input.checkValidity())).toBe(true);
  await page.getByRole('button',{name:'Apply'}).click();
  await expect(block).toContainText('3.0 s');
  await block.click({button:'right'});
  await page.getByRole('button',{name:'Set scene duration…'}).click();
  await duration.fill('3.02');
  await page.getByRole('button',{name:'Apply'}).click();
  await expect(block).toContainText('3.0 s');
});

test('property keys, master keys, and playheads share one timeline coordinate at every zoom',async({page})=>{
  await blankProject(page);
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  const ruler=page.locator('.ruler');
  const rulerBox=await ruler.boundingBox();expect(rulerBox).toBeTruthy();
  await page.mouse.click(rulerBox!.x+rulerBox!.width*.25,rulerBox!.y+12);
  await page.getByRole('button',{name:'Keyframe rotation'}).click();
  const property=page.locator('.property-row .key-dot').first();
  const master=page.locator('.timeline-row .clip-key').first();
  const playhead=page.locator('.property-row .playhead-line').first();
  await expect(property).toBeVisible();
  async function check(){
    const centers=await Promise.all([property,master,playhead].map(locator=>locator.evaluate(node=>{const box=node.getBoundingClientRect();return box.left+box.width/2;})));
    expect(Math.abs(centers[0]-centers[1])).toBeLessThan(1);
    expect(Math.abs(centers[0]-centers[2])).toBeLessThan(1);
  }
  await check();
  for(let i=0;i<3;i++)await page.getByRole('button',{name:'Zoom timeline in'}).click();
  await page.locator('.timeline-scroll').evaluate(node=>{node.scrollLeft=180;});
  await check();
});
