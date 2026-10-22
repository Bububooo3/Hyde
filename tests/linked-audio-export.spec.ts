import {expect,test} from '@playwright/test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {unzipSync} from 'fflate';

function toneWav(){
  const rate=16000,count=rate,bytes=Buffer.alloc(44+count*2);
  bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(count*2,40);
  for(let index=0;index<count;index++)bytes.writeInt16LE(Math.round(Math.sin(index*2*Math.PI*440/rate)*12000),44+index*2);
  return bytes;
}

test('nested linked scenes package each audible pitch clip once and play from a local file',async({page,context})=>{
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.locator('input[type=file][accept="image/*,video/*,audio/*"]').setInputFiles({name:'tone.wav',mimeType:'audio/wav',buffer:toneWav()});
  await page.getByRole('button',{name:'Edit clip…'}).click();
  await page.locator('.audio-clip-panel').getByRole('button',{name:'Unlink pitch from speed'}).click();
  await page.getByRole('spinbutton',{name:'Pitch offset in semitones'}).fill('12');
  await page.getByRole('spinbutton',{name:'Pitch offset in semitones'}).press('Tab');
  await page.getByRole('dialog',{name:'Edit media clip'}).getByRole('button',{name:'Apply'}).click();
  await page.locator('.sequence-block').first().click({button:'right'});
  await page.getByRole('button',{name:'Place linked copy'}).click();
  await page.locator('.sequence-block').nth(1).click({button:'right'});
  await page.getByRole('button',{name:'Set scene duration…'}).click();
  await page.getByRole('spinbutton',{name:'Scene duration in seconds'}).fill('4');
  await page.getByRole('button',{name:'Apply'}).click();
  await page.locator('.sequence-block').nth(1).click({button:'right'});
  await page.getByRole('button',{name:'Place linked copy'}).click();
  await page.locator('.sequence-block').nth(2).click({button:'right'});
  await page.getByRole('button',{name:'Set scene duration…'}).click();
  await page.getByRole('spinbutton',{name:'Scene duration in seconds'}).fill('2');
  await page.getByRole('button',{name:'Apply'}).click();
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const downloaded=page.waitForEvent('download',{timeout:60_000});
  await page.getByRole('button',{name:/Standalone web story/}).click();
  const zip=unzipSync(new Uint8Array(await readFile((await (await downloaded).path())!)));
  const directory=await mkdtemp(join(tmpdir(),'hyde-linked-audio-'));
  try{
    const html=join(directory,'index.html');await writeFile(html,zip['index.html']);
    const viewer=await context.newPage(),errors:string[]=[];
    viewer.on('pageerror',error=>errors.push(error.message));
    await viewer.goto(pathToFileURL(html).href);
    const packaged=await viewer.evaluate(()=>{
      const story=JSON.parse(document.querySelector('#hyde-story')!.textContent!);
      const linked=story.sequences.filter((scene:{sourceSceneId?:string})=>scene.sourceSceneId);
      const overrides=linked.map((scene:{id:string})=>story.elements.filter((element:{kind:string;sceneId?:string})=>element.kind==='audio'&&element.sceneId===scene.id));
      return {linked,overrides,assets:overrides.map((clips:{assetId:string}[])=>story.assets.find((asset:{id:string})=>asset.id===clips[0]?.assetId))};
    });
    expect(packaged.linked).toHaveLength(2);
    expect(packaged.linked[0].sourceSceneId).toBeTruthy();
    expect(packaged.linked[1].sourceSceneId).toBe(packaged.linked[0].id);
    expect(packaged.linked.every((scene:{muted?:boolean})=>scene.muted)).toBe(true);
    expect(packaged.overrides.map((clips:unknown[])=>clips.length)).toEqual([1,1]);
    // With pitch unlinked, each effective speed is baked into its own WAV.
    expect(packaged.overrides.map((clips:{speed:number}[])=>clips[0].speed)).toEqual([1,1]);
    expect(packaged.assets.every((asset:{mime:string})=>asset.mime==='audio/wav')).toBe(true);
    expect(packaged.assets[0].duration/packaged.assets[1].duration).toBeCloseTo(2,1);
    const seekTime=(packaged.linked[1] as {start:number}).start+.1;
    await viewer.getByRole('slider',{name:'Playback position'}).evaluate((input:HTMLInputElement,value:number)=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,String(value));
      input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
    },seekTime);
    await expect(viewer.locator('.player-time')).toContainText(seekTime.toFixed(1));
    await viewer.getByRole('button',{name:'Play',exact:true}).click();
    await expect(viewer.getByRole('button',{name:'Pause'})).toBeVisible({timeout:30_000});
    expect(errors).toEqual([]);
    await viewer.close();
  }finally{await rm(directory,{recursive:true,force:true});}
});
