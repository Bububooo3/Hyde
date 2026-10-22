import {expect,test,type Locator,type Page} from '@playwright/test';

const DURATION=8;
const LANDMARK=3.18;
const UNSNAPPED=3.22;

async function newProject(page:Page){
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done',exact:true}).click();
}

async function addLandmark(page:Page){
  await page.getByRole('button',{name:'Add rectangle',exact:true}).click();
  await page.getByRole('textbox',{name:'Element name'}).fill('Off-frame edge');
  await page.getByRole('spinbutton',{name:'Start s'}).fill(String(LANDMARK));
  await page.getByRole('spinbutton',{name:'Duration s'}).fill('1');
}

async function seek(page:Page,time:number){
  const ruler=page.getByLabel('Timeline ruler');
  const box=await ruler.boundingBox();expect(box).toBeTruthy();
  await ruler.click({position:{x:box!.width*time/DURATION,y:box!.height/2}});
}

async function dragByTime(page:Page,dot:Locator,seconds:number,alt=false){
  await dot.scrollIntoViewIfNeeded();
  const box=await dot.boundingBox();
  const lane=await dot.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " timeline-lane ")][1]').boundingBox();
  expect(box).toBeTruthy();expect(lane).toBeTruthy();
  const x=box!.x+box!.width/2,y=box!.y+box!.height/2;
  await page.mouse.move(x,y);
  if(alt)await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(x+lane!.width*seconds/DURATION,y,{steps:10});
  await page.mouse.up();
  if(alt)await page.keyboard.up('Alt');
}

async function globalTime(dot:Locator){
  return dot.evaluate((node,duration)=>Number.parseFloat((node as HTMLElement).style.left)*duration/100,DURATION);
}

async function globalEnd(block:Locator){
  return block.evaluate((node,duration)=>{
    const style=(node as HTMLElement).style;
    return (Number.parseFloat(style.left)+Number.parseFloat(style.width))*duration/100;
  },DURATION);
}

async function placedAssembly(page:Page){
  await newProject(page);
  await addLandmark(page);
  await page.getByRole('button',{name:'Add rectangle',exact:true}).click();
  await page.getByRole('textbox',{name:'Element name'}).fill('Articulated part');
  await page.getByTitle('Keyframe position').click();
  await page.keyboard.press('Control+g');
  await page.getByRole('textbox',{name:'Assembly clip name'}).fill('Snap source');
  await page.getByRole('spinbutton',{name:'Assembly clip length in seconds'}).fill('2');
  await page.getByRole('button',{name:'Save animation clip'}).click();
  await seek(page,2);
  await page.getByRole('button',{name:'Place Snap source clip'}).click();
}

test('ordinary property key drags snap to an off-frame clip edge and Alt bypasses it',async({page})=>{
  await newProject(page);
  await addLandmark(page);
  await page.getByRole('button',{name:'Add rectangle',exact:true}).click();
  await page.getByRole('textbox',{name:'Element name'}).fill('Keyed part');
  await seek(page,1);
  await page.getByTitle('Keyframe position').click();
  const key=page.locator('.property-x .key-dot').first();
  await expect(key).toBeVisible();
  await dragByTime(page,key,UNSNAPPED-1);
  await expect.poll(()=>globalTime(key)).toBeCloseTo(LANDMARK,2);
  await page.getByRole('button',{name:'Undo (Ctrl Z)'}).click();
  await expect.poll(()=>globalTime(key)).toBeCloseTo(1,2);
  await dragByTime(page,key,UNSNAPPED-1,true);
  await expect.poll(()=>globalTime(key)).toBeCloseTo(UNSNAPPED,2);
});

test('camera key drags snap to an off-frame clip edge and Alt bypasses it',async({page})=>{
  await newProject(page);
  await addLandmark(page);
  await seek(page,1);
  await page.locator('.camera-panel summary').click();
  await page.getByRole('button',{name:'Keyframe camera x'}).click();
  const key=page.locator('.camera-key-dot[data-property="x"]').first();
  await expect(key).toBeVisible();
  await dragByTime(page,key,UNSNAPPED-1);
  await expect.poll(()=>globalTime(key)).toBeCloseTo(LANDMARK,2);
  await page.getByRole('button',{name:'Undo (Ctrl Z)'}).click();
  await expect.poll(()=>globalTime(key)).toBeCloseTo(1,2);
  await dragByTime(page,key,UNSNAPPED-1,true);
  await expect.poll(()=>globalTime(key)).toBeCloseTo(UNSNAPPED,2);
});

test('assembly master key drags snap to an off-frame clip edge and Alt bypasses it',async({page})=>{
  await placedAssembly(page);
  await page.getByRole('button',{name:'Show assembly master'}).click();
  const key=page.getByRole('button',{name:/Articulated part Position X shared key at/}).first();
  await expect(key).toBeVisible();
  await expect.poll(()=>globalTime(key)).toBeCloseTo(2,2);
  await dragByTime(page,key,UNSNAPPED-2);
  await expect.poll(()=>globalTime(key)).toBeCloseTo(LANDMARK,2);
  await page.getByRole('button',{name:'Undo (Ctrl Z)'}).click();
  await expect.poll(()=>globalTime(key)).toBeCloseTo(2,2);
  await dragByTime(page,key,UNSNAPPED-2,true);
  await expect.poll(()=>globalTime(key)).toBeCloseTo(UNSNAPPED,2);
});

test('assembly clip moves and trims snap to off-frame clip edges with Alt bypass',async({page})=>{
  await placedAssembly(page);
  const block=page.getByRole('button',{name:'Placed assembly clip Snap source'});
  await expect.poll(()=>globalTime(block)).toBeCloseTo(2,2);
  await dragByTime(page,block,UNSNAPPED-2);
  await expect.poll(()=>globalTime(block)).toBeCloseTo(LANDMARK,2);
  await page.getByRole('button',{name:'Undo (Ctrl Z)'}).click();
  await expect.poll(()=>globalTime(block)).toBeCloseTo(2,2);
  await dragByTime(page,block,UNSNAPPED-2,true);
  await expect.poll(()=>globalTime(block)).toBeCloseTo(UNSNAPPED,2);
  await page.getByRole('button',{name:'Undo (Ctrl Z)'}).click();
  await expect.poll(()=>globalEnd(block)).toBeCloseTo(4,2);
  const trim=block.locator('.assembly-clip-trim');
  await dragByTime(page,trim,UNSNAPPED-3);
  await expect.poll(()=>globalEnd(block)).toBeCloseTo(LANDMARK+1,2);
  await page.getByRole('button',{name:'Undo (Ctrl Z)'}).click();
  await expect.poll(()=>globalEnd(block)).toBeCloseTo(4,2);
  await dragByTime(page,trim,UNSNAPPED-3,true);
  await expect.poll(()=>globalEnd(block)).toBeCloseTo(UNSNAPPED+1,2);
});
