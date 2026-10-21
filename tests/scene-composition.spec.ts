import {expect,test} from '@playwright/test';
import {createElement,createProject,type Project} from '../src/model';
import {makeSceneIndependent} from '../src/scenePlacement';

async function openStory(page:import('@playwright/test').Page,project:Project){
  await page.route('**/story.json',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(project)}));
  await page.goto('/player.html');
  await expect(page.locator('canvas')).toHaveCount(1);
}

async function pixel(page:import('@playwright/test').Page,x:number,y:number):Promise<number[]>{
  return page.locator('canvas').evaluate((canvas:HTMLCanvasElement,point)=>{
    const copy=document.createElement('canvas');copy.width=canvas.width;copy.height=canvas.height;
    const context=copy.getContext('2d')!;context.drawImage(canvas,0,0);
    return [...context.getImageData(point.x,point.y,1,1).data];
  },{x,y});
}

test('overlapping source scenes use independent cameras',async({page})=>{
  const project=createProject('Two cameras');project.width=400;project.height=200;project.background='#000000';
  const first=project.sequences[0];first.duration=4;
  first.camera={x:200,y:100,zoom:1,rotation:0,tracks:[]};
  const second={id:'second',name:'Second',start:0,duration:4,color:'#ffc857',camera:{x:300,y:100,zoom:1,rotation:0,tracks:[]}};
  project.sequences.push(second);project.duration=4;
  project.elements=[
    createElement('rectangle',{id:'red',sceneId:first.id,x:100,y:100,width:40,height:40,fill:'#ff0000',strokeWidth:0,start:0,duration:4}),
    createElement('rectangle',{id:'blue',sceneId:second.id,x:300,y:100,width:40,height:40,fill:'#0000ff',strokeWidth:0,start:0,duration:4}),
  ];
  await openStory(page,project);
  await expect.poll(async()=> (await pixel(page,100,100))[0]).toBeGreaterThan(200);
  const red=await pixel(page,100,100),blue=await pixel(page,200,100);
  expect(red[2]).toBeLessThan(30);expect(blue[2]).toBeGreaterThan(200);
});

test('a linked scene can render inside a picture-in-picture frame',async({page})=>{
  const project=createProject('Picture in picture');project.width=400;project.height=200;project.background='#000000';
  const first=project.sequences[0];first.duration=4;project.duration=4;
  project.elements=[createElement('rectangle',{id:'shape',sceneId:first.id,x:200,y:100,width:40,height:40,fill:'#ff0000',strokeWidth:0,start:0,duration:4})];
  project.sequences.push({id:'pip',name:'Inset',sourceSceneId:first.id,start:0,duration:4,color:'#ffc857',frame:{x:280,y:100,width:100,height:50}});
  await openStory(page,project);
  await expect.poll(async()=> (await pixel(page,330,125))[0]).toBeGreaterThan(200);
  const original=await pixel(page,200,100),inset=await pixel(page,330,125);
  expect(original[0]).toBeGreaterThan(200);expect(inset[1]).toBeLessThan(30);
  expect((await pixel(page,285,105))[0]).toBeLessThan(30);
});

test('a rotated placement frame turns its picture, backdrop, and crop together',async({page})=>{
  const project=createProject('Rotated inset');project.width=400;project.height=200;project.background='#000000';
  const source=project.sequences[0];source.duration=4;project.duration=4;
  project.elements=[createElement('rectangle',{id:'shape',sceneId:source.id,x:300,y:100,width:32,height:32,fill:'#ff0000',strokeWidth:0,start:0,duration:4})];
  project.sequences.push({id:'rotated',name:'Rotated inset',sourceSceneId:source.id,start:0,duration:4,color:'#ffc857',
    frame:{x:250,y:50,width:100,height:100},frameRotation:90});
  await openStory(page,project);
  await expect.poll(async()=> (await pixel(page,300,125))[0]).toBeGreaterThan(200);
  expect((await pixel(page,325,100))[0]).toBeLessThan(30);
});

test('split frames fit shapes without stretching their height',async({page})=>{
  const project=createProject('Split fit');project.width=400;project.height=200;project.background='#000000';
  const first=project.sequences[0];first.duration=4;project.duration=4;
  project.elements=[createElement('rectangle',{id:'shape',sceneId:first.id,x:200,y:100,width:40,height:40,fill:'#ff0000',strokeWidth:0,start:0,duration:4})];
  project.sequences.push({id:'left',name:'Left inset',sourceSceneId:first.id,start:0,duration:4,color:'#ffc857',frame:{x:0,y:0,width:200,height:200}});
  await openStory(page,project);
  await expect.poll(async()=> (await pixel(page,100,100))[0]).toBeGreaterThan(200);
  expect((await pixel(page,100,112))[0]).toBeLessThan(30);
});

test('nested placements retain the source placement frame and mask',async({page})=>{
  const project=createProject('Nested frames');project.width=400;project.height=200;project.background='#000000';
  const source=project.sequences[0];source.duration=4;project.duration=4;
  project.elements=[createElement('rectangle',{id:'shape',sceneId:source.id,x:200,y:100,width:40,height:40,fill:'#ff0000',strokeWidth:0,start:0,duration:4})];
  project.sequences.push({id:'inner',name:'Inner',sourceSceneId:source.id,start:0,duration:4,color:'#ffc857',frame:{x:0,y:0,width:200,height:200}});
  project.sequences.push({id:'outer',name:'Outer',sourceSceneId:'inner',start:0,duration:4,color:'#ffc857',frame:{x:200,y:0,width:200,height:100}});
  await openStory(page,project);
  await expect.poll(async()=> (await pixel(page,250,50))[0]).toBeGreaterThan(200);
  expect((await pixel(page,300,50))[0]).toBeLessThan(30);
});

test('making a nested placement independent preserves its composed frame',async({page})=>{
  const project=createProject('Independent nested frame');project.width=400;project.height=200;project.background='#000000';
  const source=project.sequences[0];source.duration=4;project.duration=4;
  project.elements=[createElement('rectangle',{id:'shape',sceneId:source.id,x:200,y:100,width:40,height:40,fill:'#ff0000',strokeWidth:0,start:0,duration:4})];
  project.sequences.push({id:'inner',name:'Inner',sourceSceneId:source.id,start:0,duration:4,color:'#ffc857',frame:{x:0,y:0,width:200,height:200}});
  project.sequences.push({id:'outer',name:'Outer',sourceSceneId:'inner',start:0,duration:4,color:'#ffc857',frame:{x:200,y:0,width:200,height:100}});
  const independent=makeSceneIndependent(project,'outer');
  expect(independent.sequences[2].frameStack).toHaveLength(1);
  await openStory(page,independent);
  await expect.poll(async()=> (await pixel(page,250,50))[0]).toBeGreaterThan(200);
  expect((await pixel(page,300,50))[0]).toBeLessThan(30);
});
