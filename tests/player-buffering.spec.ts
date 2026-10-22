import {expect,test} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createElement,createProject} from '../src/model';
import {videoFixture} from './video-fixture';

function toneWav():string{
  const rate=16000,count=rate*3,bytes=Buffer.alloc(44+count*2);
  bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(count*2,40);
  for(let index=0;index<count;index++)bytes.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*index/rate)*8000),44+index*2);
  return `data:audio/wav;base64,${bytes.toString('base64')}`;
}

test('standalone player pauses its audio clock while upcoming image and video buffer',async({page,context})=>{
  test.setTimeout(90_000);
  await page.goto('/');
  const laterVideo=await videoFixture(page,440,'#69a5c2');
  const laterPath=`/later.${laterVideo.extension}`;
  const project=createProject('Buffering fixture');
  project.width=320;project.height=180;project.duration=3;project.sequences[0].duration=3;
  project.assets=[
    {id:'late-image',name:'late.svg',kind:'image',mime:'image/svg+xml',dataUrl:'https://buffer.hyde.test/late.svg'},
    {id:'later-video',name:`later.${laterVideo.extension}`,kind:'video',mime:laterVideo.mime,dataUrl:`https://buffer.hyde.test${laterPath}`},
    {id:'tone',name:'tone.wav',kind:'audio',mime:'audio/wav',dataUrl:toneWav(),duration:3},
  ];
  project.elements=[
    createElement('rectangle',{id:'background',x:160,y:90,width:320,height:180,fill:'#172638',start:0,duration:3}),
    createElement('rectangle',{id:'late',x:160,y:90,width:140,height:100,assetId:'late-image',fill:'#d59a51',start:1,duration:2}),
    createElement('video',{id:'later',x:250,y:90,width:80,height:80,assetId:'later-video',muted:true,fill:'#69a5c2',start:2,duration:1}),
    createElement('audio',{id:'tone-track',assetId:'tone',start:0,duration:3}),
  ];
  const [js,css]=await Promise.all([
    readFile(join(process.cwd(),'dist/portable/player.js'),'utf8'),
    readFile(join(process.cwd(),'dist/portable/player.css'),'utf8'),
  ]);
  const html=`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script id="hyde-story" type="application/json">${JSON.stringify(project)}</script><script>${js}</script></body></html>`;
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="140" height="100"><rect width="140" height="100" fill="#d59a51"/></svg>';
  let releaseMedia!:()=>void,releaseLater!:()=>void,requested=false;
  const withheld=new Promise<void>(resolve=>{releaseMedia=resolve;});
  const withheldLater=new Promise<void>(resolve=>{releaseLater=resolve;});
  const viewer=await context.newPage(),errors:string[]=[];
  viewer.on('pageerror',error=>errors.push(error.message));
  await viewer.addInitScript(()=>{
    const offsets:number[]=[];
    (window as unknown as {hydeSourceOffsets:number[]}).hydeSourceOffsets=offsets;
    const original=AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start=function(when=0,offset=0,duration?:number){
      offsets.push(offset);
      if(duration===undefined)original.call(this,when,offset);
      else original.call(this,when,offset,duration);
    };
  });
  await viewer.route('https://buffer.hyde.test/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/late.svg'){
      requested=true;await withheld;
      await route.fulfill({status:200,contentType:'image/svg+xml',body:svg});
    }else if(path===laterPath){
      await withheldLater;
      await route.fulfill({status:200,contentType:laterVideo.mime,body:laterVideo.bytes});
    }else if(path==='/')await route.fulfill({status:200,contentType:'text/html',body:html});
    else await route.fulfill({status:404,body:'Not found'});
  });
  try{
    await viewer.goto('https://buffer.hyde.test/');
    await expect(viewer.getByRole('button',{name:'Start story'})).toBeVisible();
    await expect.poll(()=>requested).toBe(true);
    await viewer.getByRole('button',{name:'Start story'}).click();
    await expect(viewer.getByRole('button',{name:'Pause',exact:true})).toBeVisible();
    await expect(viewer.getByRole('status')).toContainText('Buffering media',{timeout:8000});
    const currentTime=()=>viewer.locator('.player-time').evaluate(node=>Number.parseFloat(node.textContent??'0'));
    const frozen=await currentTime();
    expect(frozen).toBeGreaterThanOrEqual(1);
    await viewer.waitForTimeout(500);
    expect(Math.abs(await currentTime()-frozen)).toBeLessThan(.12);
    releaseMedia();
    await expect(viewer.getByRole('button',{name:'Pause',exact:true})).toBeVisible({timeout:10_000});
    await expect.poll(currentTime,{timeout:8000}).toBeGreaterThan(frozen+.3);
    const sourceOffsets=()=>viewer.evaluate(()=>(window as unknown as {hydeSourceOffsets:number[]}).hydeSourceOffsets);
    await expect.poll(async()=>(await sourceOffsets()).length).toBeGreaterThanOrEqual(2);
    expect((await sourceOffsets()).some(offset=>Math.abs(offset-frozen)<.12)).toBe(true);
    await expect(viewer.getByRole('status')).toContainText('Buffering media',{timeout:8000});
    await viewer.getByRole('slider',{name:'Playback position'}).fill('2.5');
    await expect(viewer.locator('.player-time')).toContainText('2.5');
    await expect(viewer.getByRole('status')).toHaveCount(0);
    releaseLater();
    await viewer.waitForTimeout(500);
    expect(Math.abs(await currentTime()-2.5)).toBeLessThan(.05);
    await viewer.getByRole('button',{name:'Play',exact:true}).click();
    await expect.poll(currentTime,{timeout:8000}).toBeGreaterThan(2.6);
    expect((await sourceOffsets()).some(offset=>Math.abs(offset-2.5)<.05)).toBe(true);
    expect(errors).toEqual([]);
  }finally{releaseMedia();releaseLater();await viewer.close();}
});
