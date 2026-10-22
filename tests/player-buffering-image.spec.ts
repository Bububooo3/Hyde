import {expect,test} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createElement,createProject} from '../src/model';

test('standalone player holds time while a delayed image enters the scene',async({context})=>{
  const project=createProject('Network delay');
  project.width=320;project.height=180;project.duration=2;project.sequences[0].duration=2;
  project.assets=[{id:'image',name:'delayed.svg',kind:'image',mime:'image/svg+xml',dataUrl:'https://delayed.hyde.test/image.svg'}];
  project.elements=[
    createElement('rectangle',{x:160,y:90,width:320,height:180,fill:'#172638',duration:2}),
    createElement('rectangle',{x:160,y:90,width:120,height:90,assetId:'image',start:.5,duration:1.5}),
  ];
  const [js,css]=await Promise.all([
    readFile(join(process.cwd(),'dist/portable/player.js'),'utf8'),
    readFile(join(process.cwd(),'dist/portable/player.css'),'utf8'),
  ]);
  const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script id="hyde-story" type="application/json">${JSON.stringify(project)}</script><script>${js}</script></body></html>`;
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const viewer=await context.newPage();
  await viewer.route('https://delayed.hyde.test/**',async route=>{
    if(new URL(route.request().url()).pathname==='/image.svg'){
      await held;
      await route.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><rect width="120" height="90" fill="#f2a954"/></svg>'});
    }else await route.fulfill({status:200,contentType:'text/html',body:html});
  });
  const seconds=()=>viewer.locator('.player-time').evaluate(node=>Number.parseFloat(node.textContent??'0'));
  try{
    await viewer.goto('https://delayed.hyde.test/');
    await viewer.getByRole('button',{name:'Start story'}).click();
    await expect(viewer.getByRole('status')).toContainText('Buffering media',{timeout:8000});
    const frozen=await seconds();expect(frozen).toBeGreaterThanOrEqual(.5);
    await viewer.waitForTimeout(350);
    expect(Math.abs(await seconds()-frozen)).toBeLessThan(.12);
    release();
    await expect.poll(seconds,{timeout:8000}).toBeGreaterThan(frozen+.3);
    await expect(viewer.getByRole('status')).toHaveCount(0);
  }finally{release();await viewer.close();}
});
