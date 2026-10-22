import {expect,test,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {createElement,createProject,type Project} from '../src/model';
import {saveProjectBlob} from '../src/storage';

const duration=30,gifFps=10,videoFps=12;

function toneWav():Buffer {
  const rate=48_000,count=rate,bytes=Buffer.alloc(44+count*2);
  bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(count*2,40);
  for(let index=0;index<count;index++)bytes.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*index/rate)*.15*32767),44+index*2);
  return bytes;
}

/** A thirty-second story with shared texture, still art and moving geometry. */
function longProject():Project {
  const project=createProject('Long export fixture');
  project.width=640;project.height=360;project.duration=duration;project.sequences[0].duration=duration;
  project.background='#14293b';
  project.assets.push({id:'shared-paper',name:'paper.svg',kind:'image',mime:'image/svg+xml',dataUrl:`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#446777"/><path d="M0 24h48M24 0v48" stroke="#e8bb72" stroke-width="4"/></svg>')}`});
  project.assets.push({id:'tone',name:'tone.wav',kind:'audio',mime:'audio/wav',dataUrl:`data:audio/wav;base64,${toneWav().toString('base64')}`,duration:1});
  for(let index=0;index<8;index++){
    const x=80+(index%4)*155,y=90+Math.floor(index/4)*170;
    project.elements.push(createElement(index%2?'ellipse':'rectangle',{
      name:`Panel ${index+1}`,x,y,width:90,height:70,start:0,duration,
      fill:index%2?'#e8bb72':'#719fbc',assetId:index%3===0?'shared-paper':undefined,
      tracks:index%2?[{property:'x',keyframes:[
        {id:`long-${index}-start`,time:0,value:x,easing:'sine',direction:'inOut',mode:'smooth'},
        {id:`long-${index}-end`,time:duration,value:x+35,easing:'sine',direction:'inOut',mode:'smooth'},
      ]}]:[],
    }));
  }
  project.elements.push(createElement('text',{name:'Title',text:'Thirty seconds of Hyde',x:320,y:320,width:570,height:55,fontSize:34,fill:'#ffffff',start:0,duration}));
  project.elements.push(createElement('audio',{name:'Opening tone',sceneId:project.sequences[0].id,assetId:'tone',start:1,duration:1}));
  return project;
}

async function openFixture(page:Page,project:Project){
  const archive=await saveProjectBlob(project);
  await page.goto('/');
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles({name:'long.hyde',mimeType:'application/zip',buffer:Buffer.from(await archive.arrayBuffer())});
  await expect(page.locator('.stage-frame canvas')).toHaveCount(1);
  await page.getByRole('button',{name:'Export',exact:true}).click();
  return page.getByRole('region',{name:'Video and GIF export'});
}

async function metrics(page:Page){
  const session=await page.context().newCDPSession(page);
  try{
    await session.send('Performance.enable');
    await session.send('HeapProfiler.collectGarbage');
    const {metrics}=await session.send('Performance.getMetrics');
    const heap=metrics.find(item=>item.name==='JSHeapUsedSize')?.value??0;
    return {heapMB:+(heap/1048576).toFixed(1),canvases:await page.locator('canvas').count(),hiddenCanvases:await page.locator('div[style*="-100000px"] canvas').count()};
  }finally{await session.detach();}
}

async function gifFrameCount(page:Page,bytes:Buffer){
  return page.evaluate(async data=>{
    const Decoder=(globalThis as any).ImageDecoder;
    if(!Decoder)throw new Error('Animated GIF ImageDecoder is unavailable in this browser.');
    const decoder=new Decoder({data:new Uint8Array(data),type:'image/gif'});
    try{
      await decoder.tracks.ready;
      const count=decoder.tracks.selectedTrack?.frameCount??0;
      const {image}=await decoder.decode({frameIndex:count-1});
      image.close();
      return count;
    }finally{decoder.close();}
  },Array.from(bytes));
}

async function videoDuration(page:Page,bytes:Buffer,format:'mp4'|'webm'){
  return page.evaluate(async({data,format})=>{
    const url=URL.createObjectURL(new Blob([new Uint8Array(data)],{type:`video/${format}`}));
    const video=document.createElement('video');video.preload='metadata';video.src=url;
    try{
      return await new Promise<number>((resolve,reject)=>{
        video.onloadedmetadata=()=>resolve(video.duration);
        video.onerror=()=>reject(new Error('Long encoded video could not be opened.'));
      });
    }finally{video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
  },{data:Array.from(bytes),format});
}

test('thirty-second GIF exports repeat, cancel mid-render, and release their stage resources',async({page})=>{
  test.setTimeout(300_000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  let downloadCount=0;page.on('download',()=>downloadCount++);
  const panel=await openFixture(page,longProject());
  await panel.getByRole('button',{name:'GIF',exact:true}).click();
  await panel.getByRole('spinbutton',{name:'Export width'}).fill('256');
  await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption(String(gifFps));
  const frameCount=duration*gifFps;
  const before=await metrics(page),runs=[];
  for(let index=0;index<2;index++){
    const started=performance.now(),download=page.waitForEvent('download',{timeout:180_000});
    await panel.getByRole('button',{name:'Export GIF'}).click();
    const bytes=await readFile((await (await download).path())!);
    await expect(panel.getByRole('status')).toContainText(`${frameCount} frames`);
    expect(await gifFrameCount(page,bytes)).toBe(frameCount);
    const sample=await metrics(page);
    expect(sample.hiddenCanvases).toBe(0);
    expect(sample.canvases).toBe(before.canvases);
    runs.push({seconds:+((performance.now()-started)/1000).toFixed(2),bytes:bytes.length,...sample});
  }
  await panel.getByRole('spinbutton',{name:'Export width'}).fill('512');
  await panel.getByRole('button',{name:'Export GIF'}).click();
  await expect.poll(async()=>Number(await panel.getByRole('progressbar',{name:'Export progress'}).getAttribute('value'))).toBeGreaterThan(4);
  await panel.getByRole('button',{name:'Cancel'}).click();
  await expect(panel.getByRole('status')).toContainText('Export canceled');
  expect(downloadCount).toBe(2);
  const afterCancel=await metrics(page);
  expect(afterCancel.hiddenCanvases).toBe(0);
  expect(afterCancel.canvases).toBe(before.canvases);
  console.log(`Long GIF export ${JSON.stringify({before,runs,afterCancel})}`);
  expect(errors).toEqual([]);
});

test('thirty-second video exports repeat, cancel mid-render, and release stage resources',async({page})=>{
  test.setTimeout(300_000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  let downloadCount=0;page.on('download',()=>downloadCount++);
  const panel=await openFixture(page,longProject());
  await panel.getByRole('spinbutton',{name:'Export width'}).fill('256');
  await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption(String(videoFps));
  const frameCount=duration*videoFps;
  const button=panel.getByRole('button',{name:/Export (MP4|WEBM)/});
  await expect(button).toBeEnabled({timeout:30_000});
  const format=await panel.getByRole('combobox',{name:'Video format'}).inputValue() as 'mp4'|'webm';
  const before=await metrics(page),runs=[];
  for(let index=0;index<2;index++){
    const started=performance.now(),download=page.waitForEvent('download',{timeout:180_000});
    await button.click();
    const bytes=await readFile((await (await download).path())!);
    await expect(panel.getByRole('status')).toContainText(`${frameCount} frames`);
    expect(await videoDuration(page,bytes,format)).toBeCloseTo(duration,1);
    const sample=await metrics(page);
    expect(sample.hiddenCanvases).toBe(0);
    expect(sample.canvases).toBe(before.canvases);
    runs.push({seconds:+((performance.now()-started)/1000).toFixed(2),bytes:bytes.length,...sample});
  }
  await panel.getByRole('spinbutton',{name:'Export width'}).fill('512');
  await expect(button).toBeEnabled({timeout:30_000});
  await button.click();
  await expect.poll(async()=>Number(await panel.getByRole('progressbar',{name:'Export progress'}).getAttribute('value'))).toBeGreaterThan(4);
  await panel.getByRole('button',{name:'Cancel'}).click();
  await expect(panel.getByRole('status')).toContainText('Export canceled');
  expect(downloadCount).toBe(2);
  const afterCancel=await metrics(page);
  expect(afterCancel.hiddenCanvases).toBe(0);
  expect(afterCancel.canvases).toBe(before.canvases);
  console.log(`Long ${format.toUpperCase()} export ${JSON.stringify({before,runs,afterCancel})}`);
  expect(errors).toEqual([]);
});

test('unavailable video encoder gives a clear reason and leaves GIF export available',async({page})=>{
  await page.addInitScript(()=>{
    Object.defineProperty(window,'VideoEncoder',{configurable:true,value:undefined});
  });
  const panel=await openFixture(page,longProject());
  const format=panel.getByRole('combobox',{name:'Video format'});
  await expect(format).toBeEnabled({timeout:30_000});
  await expect(panel.getByText('This browser cannot encode this video format at the chosen size and frame rate.').first()).toBeVisible();
  await expect(panel.getByRole('button',{name:/Export (MP4|WEBM)/})).toBeDisabled();
  await panel.getByRole('button',{name:'GIF',exact:true}).click();
  await panel.getByRole('combobox',{name:'Export range'}).selectOption('selected');
  await panel.getByRole('spinbutton',{name:'Export to seconds'}).fill('0.5');
  await panel.getByRole('spinbutton',{name:'Export width'}).fill('64');
  await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption('6');
  const download=page.waitForEvent('download',{timeout:30_000});
  await panel.getByRole('button',{name:'Export GIF'}).click();
  expect((await download).suggestedFilename()).toMatch(/\.gif$/);
});

test('video encoder setup failure reports recovery advice and frees the hidden renderer',async({page})=>{
  await page.addInitScript(()=>{
    Object.defineProperty(VideoEncoder.prototype,'configure',{
      configurable:true,
      value(){throw new DOMException('Simulated encoder setup failure.','NotSupportedError');},
    });
  });
  const panel=await openFixture(page,longProject());
  await panel.getByRole('combobox',{name:'Export range'}).selectOption('selected');
  await panel.getByRole('spinbutton',{name:'Export to seconds'}).fill('0.5');
  await panel.getByRole('spinbutton',{name:'Export width'}).fill('64');
  await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption('12');
  const button=panel.getByRole('button',{name:/Export (MP4|WEBM)/});
  await expect(button).toBeEnabled({timeout:30_000});
  await button.click();
  await expect(panel.getByRole('status')).toContainText(/encoder/i);
  await expect(panel.getByRole('status')).toContainText(/another format|smaller size/i);
  await expect.poll(()=>page.locator('div[style*="-100000px"] canvas').count()).toBe(0);
  await expect(button).toBeEnabled();
});
