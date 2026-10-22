import {expect,test,type Page} from '@playwright/test';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {unzipSync} from 'fflate';
import {saveProjectBlob} from '../src/storage';
import {createFidelityProject} from './fidelityFixture';

const width=320,height=180,sampleWidth=160,sampleHeight=90;
const sampleTimes=[.5,2.5,3.5];

async function frame(page:Page,selector:string,overscan=0):Promise<number[]> {
  return page.locator(selector).evaluate((canvas:HTMLCanvasElement,{overscan,width,height,sampleWidth,sampleHeight})=>{
    const copy=document.createElement('canvas');copy.width=sampleWidth;copy.height=sampleHeight;
    copy.getContext('2d',{willReadFrequently:true})!.drawImage(canvas,overscan,overscan,width,height,0,0,sampleWidth,sampleHeight);
    return Array.from(copy.getContext('2d')!.getImageData(0,0,sampleWidth,sampleHeight).data);
  },{overscan,width,height,sampleWidth,sampleHeight});
}

function meanError(a:number[],b:number[]):number {
  expect(a).toHaveLength(b.length);
  let sum=0;
  for(let index=0;index<a.length;index+=4)sum+=Math.abs(a[index]-b[index])+Math.abs(a[index+1]-b[index+1])+Math.abs(a[index+2]-b[index+2]);
  return +(sum/(a.length*.75)).toFixed(2);
}

async function seekEditor(page:Page,time:number){
  const ruler=page.getByLabel('Timeline ruler'),box=await ruler.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box!.x+box!.width*time/4,box!.y+box!.height/2,{modifiers:['Alt']});
  await expect.poll(()=>page.locator('.ruler-playhead').evaluate(node=>Number.parseFloat((node as HTMLElement).style.left)*4/100)).toBeCloseTo(time,2);
  await page.waitForTimeout(180);
}

async function seekPlayer(page:Page,time:number){
  await page.getByRole('slider',{name:'Playback position'}).evaluate((input:HTMLInputElement,value:number)=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,String(value));
    input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
  },time);
  await expect(page.locator('.player-time')).toContainText(time.toFixed(1));
  await page.waitForTimeout(180);
}

async function gifFrames(page:Page,bytes:Buffer,indices:number[]):Promise<number[][]>{
  return page.evaluate(async({bytes,indices,sampleWidth,sampleHeight})=>{
    const Decoder=(globalThis as any).ImageDecoder;
    if(!Decoder)throw new Error('Animated GIF ImageDecoder is unavailable in this browser.');
    const decoder=new Decoder({data:new Uint8Array(bytes),type:'image/gif'});
    const canvas=document.createElement('canvas');canvas.width=sampleWidth;canvas.height=sampleHeight;
    const ctx=canvas.getContext('2d',{willReadFrequently:true})!;
    const results:number[][]=[];
    try{
      for(const frameIndex of indices){
        const {image}=await decoder.decode({frameIndex});
        ctx.clearRect(0,0,sampleWidth,sampleHeight);ctx.drawImage(image,0,0,sampleWidth,sampleHeight);
        results.push(Array.from(ctx.getImageData(0,0,sampleWidth,sampleHeight).data));image.close();
      }
    }finally{decoder.close();}
    return results;
  },{bytes:Array.from(bytes),indices,sampleWidth,sampleHeight});
}

async function videoFrames(page:Page,bytes:Buffer,times:number[]):Promise<number[][]>{
  return page.evaluate(async({bytes,times,sampleWidth,sampleHeight})=>{
    const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'video/mp4'}));
    const video=document.createElement('video');video.muted=true;video.preload='auto';video.src=url;
    const canvas=document.createElement('canvas');canvas.width=sampleWidth;canvas.height=sampleHeight;
    const ctx=canvas.getContext('2d',{willReadFrequently:true})!,results:number[][]=[];
    try{
      await new Promise<void>((resolve,reject)=>{video.onloadedmetadata=()=>resolve();video.onerror=()=>reject(new Error('Encoded video did not load.'));});
      for(const time of times){
        await new Promise<void>((resolve,reject)=>{video.onseeked=()=>resolve();video.onerror=()=>reject(new Error('Encoded video seek failed.'));video.currentTime=time+.001;});
        ctx.drawImage(video,0,0,sampleWidth,sampleHeight);
        results.push(Array.from(ctx.getImageData(0,0,sampleWidth,sampleHeight).data));
      }
      return results;
    }finally{video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
  },{bytes:Array.from(bytes),times,sampleWidth,sampleHeight});
}

async function encodedAudioOnset(page:Page,bytes:Buffer):Promise<{onset:number;peak:number;duration:number}>{
  return page.evaluate(async data=>{
    const context=new AudioContext();
    try{
      const audio=await context.decodeAudioData(new Uint8Array(data).buffer);
      const channel=audio.getChannelData(0),block=Math.round(audio.sampleRate*.01),levels:number[]=[];
      for(let start=0;start<channel.length;start+=block){
        let energy=0;for(let index=start;index<Math.min(channel.length,start+block);index++)energy+=channel[index]*channel[index];
        levels.push(Math.sqrt(energy/Math.max(1,Math.min(block,channel.length-start))));
      }
      const peak=Math.max(...levels),first=levels.findIndex(value=>value>Math.max(.01,peak*.2));
      return {onset:first*block/audio.sampleRate,peak,duration:audio.duration};
    }finally{await context.close();}
  },Array.from(bytes));
}

test('preview, isolated player, GIF, and encoded video preserve a composed animated story and pulse timing',async({page,context})=>{
  test.setTimeout(150_000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const project=createFidelityProject(),archive=await saveProjectBlob(project);
  await page.goto('/');
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles({name:'fidelity.hyde',mimeType:'application/zip',buffer:Buffer.from(await archive.arrayBuffer())});
  await expect(page.locator('.stage-frame canvas')).toHaveCount(1);
  const editor:number[][]=[];
  for(const time of sampleTimes){
    await seekEditor(page,time);
    if(!editor.length)await expect.poll(async()=>(await frame(page,'.stage-frame canvas',240))[(45*sampleWidth+80)*4],{timeout:10000}).toBeLessThan(80);
    editor.push(await frame(page,'.stage-frame canvas',240));
  }
  expect(meanError(editor[0],editor[1])).toBeGreaterThan(5);
  expect(meanError(editor[1],editor[2])).toBeGreaterThan(5);

  await page.getByRole('button',{name:'Export',exact:true}).click();
  const webDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:/Standalone web story/}).click();
  const zip=unzipSync(new Uint8Array(await readFile((await (await webDownload).path())!)));
  const packaged=JSON.parse(new TextDecoder().decode(zip['story.json']));
  expect(packaged.sequences).toHaveLength(3);
  expect(packaged.elements.find((element:{id:string})=>element.id==='animated-text')?.textAnimation).toBeTruthy();
  expect(packaged.elements.find((element:{id:string})=>element.id==='lid')?.attachment?.type).toBe('hinge');
  const directory=await mkdtemp(join(tmpdir(),'hyde-fidelity-'));
  try{
    const html=join(directory,'index.html');await writeFile(html,zip['index.html']);
    const viewer=await context.newPage();viewer.on('pageerror',error=>errors.push(error.message));
    await viewer.goto(pathToFileURL(html).href);
    await expect(viewer.locator('.player-screen canvas')).toHaveCount(1);
    const portable:number[][]=[];
    for(const time of sampleTimes){await seekPlayer(viewer,time);portable.push(await frame(viewer,'.player-screen canvas'));}
    const playerErrors=editor.map((image,index)=>meanError(image,portable[index]));
    console.log(`Editor/player frame error ${JSON.stringify(playerErrors)}`);
    for(const value of playerErrors)expect(value).toBeLessThan(5);
    await viewer.close();

    const panel=page.getByRole('region',{name:'Video and GIF export'});
    await panel.getByRole('button',{name:'GIF',exact:true}).click();
    await panel.getByRole('spinbutton',{name:'Export width'}).fill(String(width));
    await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption('6');
    const gifDownload=page.waitForEvent('download',{timeout:60000});
    await panel.getByRole('button',{name:'Export GIF'}).click();
    const gif=await readFile((await (await gifDownload).path())!);
    const gifImages=await gifFrames(page,gif,sampleTimes.map(time=>Math.round(time*6)));
    const gifErrors=portable.map((image,index)=>meanError(image,gifImages[index]));
    console.log(`Player/GIF frame error ${JSON.stringify(gifErrors)}`);
    for(const value of gifErrors)expect(value).toBeLessThan(30);

    await panel.getByRole('button',{name:'Video',exact:true}).click();
    await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption('12');
    await panel.getByRole('combobox',{name:'Video format'}).selectOption('mp4');
    await expect(panel.getByRole('button',{name:'Export MP4'})).toBeEnabled({timeout:30000});
    const videoDownload=page.waitForEvent('download',{timeout:90000});
    await panel.getByRole('button',{name:'Export MP4'}).click();
    const video=await readFile((await (await videoDownload).path())!);
    const videoImages=await videoFrames(page,video,[5/12,...sampleTimes]);
    const videoErrors=portable.map((image,index)=>meanError(image,videoImages[index+1]));
    console.log(`Player/MP4 frame error ${JSON.stringify(videoErrors)}`);
    for(const value of videoErrors)expect(value).toBeLessThan(26);
    const band=(image:number[])=>image[(84*sampleWidth+5)*4];
    expect(band(videoImages[1])-band(videoImages[0])).toBeGreaterThan(80);
    const audio=await encodedAudioOnset(page,video);
    console.log(`Encoded pulse timing ${JSON.stringify({audio,flashTime:.5,flashBefore:band(videoImages[0]),flashAt:band(videoImages[1])})}`);
    expect(audio.peak).toBeGreaterThan(.04);
    expect(Math.abs(audio.onset-.5)).toBeLessThan(1/12);
  }finally{
    const absolute=await realpath(directory);
    if(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('hyde-fidelity-'))await rm(absolute,{recursive:true,force:true});
  }
  expect(errors).toEqual([]);
});
