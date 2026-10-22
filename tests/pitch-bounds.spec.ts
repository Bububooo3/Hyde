import {expect,test} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createElement,createProject} from '../src/model';

function toneWav():string{
  const rate=16000,count=rate,bytes=Buffer.alloc(44+count*2);
  bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(count*2,40);
  for(let index=0;index<count;index++)bytes.writeInt16LE(Math.round(Math.sin(index*2*Math.PI*440/rate)*12000),44+index*2);
  return `data:audio/wav;base64,${bytes.toString('base64')}`;
}

for(const [speed,pitch,expectedDuration,expectedFrequency] of [[.25,-24,4,110],[4,24,.25,1760]]){
  test(`independent audio at ${speed}× and ${pitch} semitones has bounded duration and audible pitch`,async({page})=>{
    test.setTimeout(90_000);
    const project=createProject('Pitch boundary');
    project.duration=5;project.sequences[0].duration=5;
    project.assets=[{id:'tone',name:'tone.wav',kind:'audio',mime:'audio/wav',dataUrl:toneWav(),duration:1}];
    project.elements=[createElement('audio',{id:'tone-clip',assetId:'tone',start:0,duration:expectedDuration,speed,linkSpeedPitch:false,pitchSemitones:pitch})];
    const [js,css]=await Promise.all([
      readFile(join(process.cwd(),'dist/portable/player.js'),'utf8'),
      readFile(join(process.cwd(),'dist/portable/player.css'),'utf8'),
    ]);
    const html=`<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script id="hyde-story" type="application/json">${JSON.stringify(project)}</script><script>${js}</script></body></html>`;
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      const samples:Array<{duration:number;frequency:number;peak:number}>=[];
      (window as unknown as {hydePitchSamples:typeof samples}).hydePitchSamples=samples;
      const original=AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start=function(when=0,offset=0,duration?:number){
        const buffer=this.buffer;
        if(buffer){
          const values=buffer.getChannelData(0),from=Math.floor(values.length*.35),to=Math.floor(values.length*.65);
          let crossings=0,peak=0;
          for(let index=from+1;index<to;index++){
            if(values[index-1]<=0&&values[index]>0)crossings++;
            peak=Math.max(peak,Math.abs(values[index]));
          }
          samples.push({duration:buffer.duration,frequency:crossings/((to-from)/buffer.sampleRate),peak});
        }
        if(duration===undefined)original.call(this,when,offset);
        else original.call(this,when,offset,duration);
      };
    });
    await page.route('https://pitch-bounds.hyde.test/**',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
    await page.goto('https://pitch-bounds.hyde.test/');
    await page.getByRole('button',{name:'Start story'}).click();
    await expect.poll(()=>page.evaluate(()=>(window as unknown as {hydePitchSamples:unknown[]}).hydePitchSamples.length),{timeout:60_000}).toBeGreaterThan(0);
    const sample=await page.evaluate(()=>(window as unknown as {hydePitchSamples:Array<{duration:number;frequency:number;peak:number}>}).hydePitchSamples[0]);
    expect(sample.duration).toBeCloseTo(expectedDuration,1);
    expect(sample.peak).toBeGreaterThan(.01);
    expect(sample.frequency).toBeGreaterThan(expectedFrequency*.8);
    expect(sample.frequency).toBeLessThan(expectedFrequency*1.2);
    expect(errors).toEqual([]);
  });
}
