import {expect,test} from '@playwright/test';

test.use({launchOptions:{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']}});

function silenceWav():number[]{
  const samples=8000,bytes=Buffer.alloc(44+samples*2);
  bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);
  return [...bytes];
}

test('microphone take starts from the audio clock and its alignment survives reopen',async({page})=>{
  test.setTimeout(90_000);
  await page.addInitScript(({bytes})=>{
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}});
    class FakeMediaRecorder{
      static isTypeSupported(){return false;}
      mimeType='audio/wav';state='inactive';
      onstart?:()=>void;onstop?:()=>void;onerror?:()=>void;ondataavailable?:(event:{data:Blob})=>void;
      start(){this.state='recording';setTimeout(()=>this.onstart?.(),20);}
      stop(){this.state='inactive';this.ondataavailable?.({data:new Blob([new Uint8Array(bytes)],{type:this.mimeType})});setTimeout(()=>this.onstop?.(),20);}
    }
    Object.defineProperty(window,'MediaRecorder',{configurable:true,value:FakeMediaRecorder});
  },{bytes:silenceWav()});
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await expect(page.getByRole('checkbox',{name:'Monitor microphone while recording'})).not.toBeChecked();
  await page.getByRole('checkbox',{name:'Mute existing audio while recording'}).check();
  await page.getByRole('button',{name:'Record microphone with scene playback'}).click();
  await expect(page.getByRole('button',{name:'Stop microphone recording'})).toBeVisible();
  await page.waitForTimeout(220);
  await page.getByRole('button',{name:'Stop microphone recording'}).click();
  await expect(page.getByRole('spinbutton',{name:'Recording alignment seconds'})).toHaveValue('0');
  const start=page.getByRole('spinbutton',{name:'Start s'});
  const capturedStart=Number(await start.inputValue());
  expect(capturedStart).toBeGreaterThanOrEqual(0);
  await page.getByRole('spinbutton',{name:'Recording alignment seconds'}).fill('0.25');
  await page.getByRole('spinbutton',{name:'Recording alignment seconds'}).press('Tab');
  await expect.poll(async()=>Number(await start.inputValue())).toBeCloseTo(capturedStart+.25,2);
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await (await download).path())!);
  await page.locator('.layer-name').filter({hasText:'Voice recording'}).click();
  await expect(page.getByRole('spinbutton',{name:'Recording alignment seconds'})).toHaveValue('0.25');
  await expect.poll(async()=>Number(await start.inputValue())).toBeCloseTo(capturedStart+.25,2);
  await page.getByRole('spinbutton',{name:'Recording alignment seconds'}).fill('0');
  await page.getByRole('spinbutton',{name:'Recording alignment seconds'}).press('Tab');
  await expect.poll(async()=>Number(await start.inputValue())).toBeCloseTo(capturedStart,2);
});

test('Chrome microphone API produces an editable clip with a fake input device',async({page,context})=>{
  test.setTimeout(90_000);
  await context.grantPermissions(['microphone']);
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await expect(page.getByRole('checkbox',{name:'Monitor microphone while recording'})).not.toBeChecked();
  await page.getByRole('checkbox',{name:'Monitor microphone while recording'}).check();
  await page.getByRole('button',{name:'Record microphone with scene playback'}).click();
  await expect(page.getByRole('button',{name:'Stop microphone recording'})).toBeVisible();
  await page.waitForTimeout(550);
  await page.getByRole('button',{name:'Stop microphone recording'}).click();
  await expect(page.getByRole('spinbutton',{name:'Recording alignment seconds'})).toHaveValue('0');
  await expect(page.locator('.audio-clip-panel').getByRole('heading',{name:'Audio clip'})).toBeVisible();
  await expect.poll(async()=>Number(await page.getByRole('spinbutton',{name:'Source out seconds'}).inputValue())).toBeGreaterThan(.3);
});
