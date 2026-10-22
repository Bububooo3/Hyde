import {expect,test} from '@playwright/test';
import {createElement,createProject} from '../src/model';
import {saveProjectBlob} from '../src/storage';

test('dragging near another object shows an alignment guide and snaps its edge',async({page})=>{
  const project=createProject('Alignment guides');
  project.width=960;project.height=540;
  const sceneId=project.sequences[0].id;
  project.elements=[
    createElement('rectangle',{id:'mover',name:'Mover',sceneId,x:300,y:120,width:100,height:80}),
    createElement('rectangle',{id:'target',name:'Target',sceneId,x:600,y:300,width:100,height:80}),
  ];
  const blob=await saveProjectBlob(project);
  await page.goto('/');
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles({name:'alignment.hyde',mimeType:'application/zip',buffer:Buffer.from(await blob.arrayBuffer())});
  await page.locator('.layer-name').getByText('Mover',{exact:true}).click();
  const frame=(await page.locator('.stage-frame').boundingBox())!;
  const point=(x:number,y:number)=>({x:frame.x+x/960*frame.width,y:frame.y+y/540*frame.height});
  const start=point(300,120),end=point(498,120);
  await page.mouse.move(start.x,start.y);
  await page.mouse.down();
  await page.mouse.move(end.x,end.y,{steps:8});
  await expect(page.locator('.stage-alignment-guide')).toHaveCount(1);
  await expect(page.locator('.stage-alignment-guide')).toHaveAttribute('x1','550');
  await page.mouse.up();
  await expect(page.locator('.stage-alignment-guide')).toHaveCount(0);
  await expect(page.getByRole('spinbutton',{name:'X',exact:true})).toHaveValue('500');
  await page.getByRole('button',{name:'Undo (Ctrl Z)'}).click();
  await expect(page.getByRole('spinbutton',{name:'X',exact:true})).toHaveValue('300');
  await page.keyboard.down('Alt');
  await page.mouse.move(start.x,start.y);
  await page.mouse.down();
  await page.mouse.move(end.x,end.y,{steps:8});
  await expect(page.locator('.stage-alignment-guide')).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const bypassX=Number(await page.getByRole('spinbutton',{name:'X',exact:true}).inputValue());
  expect(bypassX).toBeGreaterThan(497);
  expect(bypassX).toBeLessThan(499);
});
