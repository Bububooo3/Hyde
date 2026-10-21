import {expect,test} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {unzipSync} from 'fflate';
import {videoFixture} from './video-fixture';

test('animated video textures switch their embedded sound in export and standalone playback',async({page})=>{
  test.setTimeout(180_000);
  const importErrors:string[]=[];
  page.on('dialog',dialog=>{importErrors.push(dialog.message());void dialog.dismiss();});
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  const low=await videoFixture(page,440,'#e64242');
  const high=await videoFixture(page,880,'#2369dc');
  await page.getByRole('button',{name:'Add rectangle'}).click();
  await page.locator('input[type=file][accept="image/*,video/*,audio/*"]').setInputFiles([
    {name:`low.${low.extension}`,mimeType:low.mime,buffer:low.bytes},
    {name:`high.${high.extension}`,mimeType:high.mime,buffer:high.bytes},
  ]);
  await expect.poll(async()=>await page.locator('.layer-name').count()+importErrors.length,{timeout:20_000}).toBeGreaterThanOrEqual(3);
  expect(importErrors).toEqual([]);
  for(const name of ['high','low']){
    await page.locator('.layer-name').filter({hasText:name}).click();
    await page.keyboard.press('Delete');
  }
  await page.locator('.layer-name').filter({hasText:'Rectangle'}).click();
  const texture=page.getByRole('combobox',{name:'Texture asset'});
  await texture.selectOption({label:`low.${low.extension}`});
  await page.getByRole('spinbutton',{name:'Speed ×'}).fill('0.5');
  await page.getByRole('button',{name:'Keyframe texture'}).click();
  const second=await page.locator('.ruler > span').filter({hasText:'2s'}).first().boundingBox();expect(second).toBeTruthy();
  await page.mouse.click(second!.x+second!.width/2,second!.y+second!.height/2);
  await page.getByRole('button',{name:'Auto key'}).click();
  await texture.selectOption({label:`high.${high.extension}`});
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const panel=page.getByRole('region',{name:'Video and GIF export'});
  await panel.getByRole('combobox',{name:'Export range'}).selectOption('selected');
  await panel.getByRole('spinbutton',{name:'Export to seconds'}).fill('2');
  await panel.getByRole('spinbutton',{name:'Export width'}).fill('64');
  await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption('12');
  await expect(panel.getByLabel('Include project audio')).toBeChecked();
  const exportButton=panel.getByRole('button',{name:/Export (MP4|WEBM)/});
  await expect(exportButton).toBeEnabled({timeout:30_000});
  const videoDownload=page.waitForEvent('download',{timeout:60_000});
  await exportButton.click();
  const video=await readFile((await (await videoDownload).path())!);
  const sound=await page.evaluate(async(base64)=>{
    const bytes=Uint8Array.from(atob(base64),letter=>letter.charCodeAt(0));
    const context=new AudioContext();
    try{
      const decoded=await context.decodeAudioData(bytes.buffer),pcm=decoded.getChannelData(0);
      const measure=(from:number,to:number)=>{
        const first=Math.floor(from*decoded.sampleRate),last=Math.min(pcm.length,Math.floor(to*decoded.sampleRate));
        let crossings=0,peak=0;
        for(let index=first+1;index<last;index++){
          if(pcm[index-1]<=0&&pcm[index]>0)crossings++;
          peak=Math.max(peak,Math.abs(pcm[index]));
        }
        return {frequency:crossings/((last-first)/decoded.sampleRate),peak};
      };
      return {early:measure(.3,.8),late:measure(1.3,1.8)};
    }finally{await context.close();}
  },video.toString('base64'));
  expect(sound.early.peak).toBeGreaterThan(.01);
  expect(sound.late.peak).toBeGreaterThan(.01);
  // Speed is linked to pitch, so 0.5× maps the 440/880 Hz sources to 220/440 Hz.
  expect(sound.early.frequency).toBeGreaterThan(170);
  expect(sound.early.frequency).toBeLessThan(270);
  expect(sound.late.frequency).toBeGreaterThan(350);
  expect(sound.late.frequency).toBeLessThan(550);
  const webDownload=page.waitForEvent('download',{timeout:60_000});
  await page.getByRole('button',{name:/Standalone web story/}).click();
  const files=unzipSync(new Uint8Array(await readFile((await (await webDownload).path())!)));
  const html=new TextDecoder().decode(files['index.html']);
  expect(html).toContain('animated audio.wav');
});
