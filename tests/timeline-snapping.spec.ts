import {expect,test,type Locator,type Page} from '@playwright/test';

async function dragBy(page:Page,handle:Locator,pixels:number,alt=false){
  const box=await handle.boundingBox();expect(box).toBeTruthy();
  const x=box!.x+box!.width/2,y=box!.y+box!.height/2;
  await page.mouse.move(x,y);
  if(alt)await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(x+pixels,y,{steps:8});
  await page.mouse.up();
  if(alt)await page.keyboard.up('Alt');
}

test('timeline scrubbing, clip moving, and trimming snap to authored edges with Alt bypass',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  for(const [name,start] of [['Anchor','3.17'],['Mover','0.4']]){
    await page.getByRole('button',{name:'Add rectangle'}).first().click();
    await page.getByRole('textbox',{name:'Element name'}).fill(name);
    await page.getByRole('spinbutton',{name:'Start s'}).fill(start);
    await page.getByRole('spinbutton',{name:'Duration s'}).fill('1');
  }
  const ruler=page.getByLabel('Timeline ruler');
  const rulerBox=await ruler.boundingBox();expect(rulerBox).toBeTruthy();
  const seekX=rulerBox!.x+rulerBox!.width*3.22/8,seekY=rulerBox!.y+rulerBox!.height/2;
  await page.mouse.click(seekX,seekY);
  await expect.poll(()=>page.locator('.ruler-playhead').evaluate(node=>Number.parseFloat((node as HTMLElement).style.left)*8/100)).toBeCloseTo(3.17,2);
  await page.keyboard.down('Alt');
  await page.mouse.click(seekX,seekY);
  await page.keyboard.up('Alt');
  const bypassTime=await page.locator('.ruler-playhead').evaluate(node=>Number.parseFloat((node as HTMLElement).style.left)*8/100);
  expect(bypassTime).toBeGreaterThan(3.2);
  expect(bypassTime).toBeLessThan(3.25);
  await page.mouse.click(rulerBox!.x+2,seekY);

  const mover=page.locator('.clip-block').filter({hasText:'Mover'});
  const lane=await mover.locator('xpath=..').boundingBox();expect(lane).toBeTruthy();
  const nearEdge=(3.17-1.4)/8*lane!.width+4;
  await dragBy(page,mover,nearEdge);
  await expect(page.getByRole('spinbutton',{name:'Start s'})).toHaveValue('2.17');

  await page.getByRole('spinbutton',{name:'Start s'}).fill('0.4');
  await dragBy(page,mover,nearEdge,true);
  const bypassStart=Number(await page.getByRole('spinbutton',{name:'Start s'}).inputValue());
  expect(bypassStart).toBeGreaterThan(2.19);
  expect(bypassStart).toBeLessThan(2.25);

  await page.getByRole('spinbutton',{name:'Start s'}).fill('0.4');
  const nearTrim=(3.17-1.4)/8*lane!.width+4;
  await dragBy(page,mover.locator('.trim-handle'),nearTrim);
  await expect(page.getByRole('spinbutton',{name:'Duration s'})).toHaveValue('2.77');
});
