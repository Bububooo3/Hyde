import {readFile} from 'node:fs/promises';
import path from 'node:path';
import type {Page} from '@playwright/test';
import {createElement,createProject} from '../src/model';

function toneWav(frequency:number,duration=1.2):Buffer{
  const rate=48_000,count=Math.round(rate*duration),bytes=Buffer.alloc(44+count*2);
  bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(count*2,40);
  for(let index=0;index<count;index++)bytes.writeInt16LE(Math.round(Math.sin(2*Math.PI*frequency*index/rate)*.2*32767),44+index*2);
  return bytes;
}

/** Deterministic browser-encoded A/V input. Chrome's MediaRecorder can return
 * empty blobs in headless environments, while Hyde's WebCodecs path is stable. */
export async function videoFixture(page:Page,frequency:number,color:string):Promise<{bytes:Buffer;mime:string;extension:string}>{
  const manifest=JSON.parse(await readFile(path.resolve('dist/build-manifest.json'),'utf8')) as Record<string,{file:string}>;
  const moduleUrl='/'+manifest['src/mediaExport.ts'].file;
  const project=createProject(`Fixture ${frequency}`);
  project.width=64;project.height=64;project.duration=1.2;project.fps=15;
  project.sequences[0].duration=project.duration;
  project.elements=[
    createElement('rectangle',{id:'visual',sceneId:project.sequences[0].id,x:32,y:32,width:64,height:64,fill:color,strokeWidth:0,duration:1.2}),
    createElement('audio',{id:'sound',sceneId:project.sequences[0].id,assetId:'tone',duration:1.2}),
  ];
  project.assets=[{id:'tone',name:'tone.wav',kind:'audio',mime:'audio/wav',dataUrl:`data:audio/wav;base64,${toneWav(frequency).toString('base64')}`,duration:1.2}];
  const result=await page.evaluate(async({moduleUrl,project,color})=>{
    const media=await import(/* @vite-ignore */ moduleUrl);
    const choices=await media.getVideoCapabilities(64,64,15,true);
    const choice=choices.find((entry:{format:string;supported:boolean;recommended:boolean})=>entry.supported&&entry.recommended)
      ??choices.find((entry:{format:string;supported:boolean})=>entry.supported);
    if(!choice)throw new Error('No browser A/V encoder is available for the video fixture.');
    const output=await media.exportMedia(project,{format:choice.format,start:0,end:1.2,width:64,height:64,fps:15,quality:'medium',loop:false,background:color,includeAudio:true});
    if(!output.includesAudio)throw new Error('The video fixture lost its audio track.');
    return {bytes:Array.from(new Uint8Array(await output.blob.arrayBuffer())),mime:output.blob.type,extension:choice.format};
  },{moduleUrl,project,color});
  return {bytes:Buffer.from(result.bytes),mime:result.mime,extension:result.extension};
}
