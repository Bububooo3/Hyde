import {expect,test,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {strFromU8,unzipSync} from 'fflate';

async function pixel(page:Page,selector:string,x:number,y:number,overscan=0):Promise<number[]>{
  return page.locator(selector).evaluate((canvas:HTMLCanvasElement,point)=>{
    const copy=document.createElement('canvas');copy.width=canvas.width;copy.height=canvas.height;
    const context=copy.getContext('2d')!;context.drawImage(canvas,0,0);
    return [...context.getImageData(point.x+point.overscan,point.y+point.overscan,1,1).data];
  },{x,y,overscan});
}

async function sampledFrame(page:Page,selector:string,overscan=0):Promise<number[]>{
  return page.locator(selector).evaluate((canvas:HTMLCanvasElement,offset)=>{
    const copy=document.createElement('canvas');copy.width=240;copy.height=135;
    const context=copy.getContext('2d',{willReadFrequently:true})!;
    context.drawImage(canvas,offset,offset,960,540,0,0,240,135);
    return Array.from(context.getImageData(0,0,240,135).data);
  },overscan);
}

function meanChannelError(a:number[],b:number[]):number{
  let sum=0;
  for(let index=0;index<a.length;index+=4)sum+=Math.abs(a[index]-b[index])+Math.abs(a[index+1]-b[index+1])+Math.abs(a[index+2]-b[index+2]);
  return sum/(a.length*.75);
}

test('primary showcase reopens and its poster pixels match an isolated standalone package',async({page,context})=>{
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByRole('button',{name:/Explore the lantern keeper/}).click();
  await expect(page.getByRole('textbox',{name:'Project name'})).toHaveValue('The lantern keeper');
  const archiveDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  const archive=await readFile((await (await archiveDownload).path())!);
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles({name:'lantern.hyde',mimeType:'application/zip',buffer:archive});
  await expect(page.getByRole('textbox',{name:'Project name'})).toHaveValue('The lantern keeper');
  const ruler=(await page.getByLabel('Timeline ruler').boundingBox())!;
  await page.keyboard.down('Alt');
  await page.mouse.click(ruler.x+ruler.width*1.3/12,ruler.y+ruler.height/2);
  await page.keyboard.up('Alt');
  await expect(page.locator('.timecode')).toContainText('00:01');
  const positions=[[30,30],[258,340],[657,303]] as const;
  await expect(page.locator('.stage-frame canvas')).toHaveCount(1);
  await page.waitForTimeout(180);
  const preview=await Promise.all(positions.map(([x,y])=>pixel(page,'.stage-frame canvas',x,y,240)));
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:/Standalone web story/}).click();
  const zip=unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  expect(zip['story.json']).toBeTruthy();
  const exported=JSON.parse(strFromU8(zip['story.json']));
  expect(exported.sequences).toHaveLength(3);
  expect(exported.assets.some((asset:{name:string})=>asset.name==='Lantern chimes.wav')).toBe(true);
  const viewer=await context.newPage(),errors:string[]=[];viewer.on('pageerror',error=>errors.push(error.message));
  await viewer.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='https://lantern.hyde.test'){await route.abort();return;}
    const path=url.pathname.slice(1)||'index.html',data=zip[path];
    if(!data){await route.fulfill({status:404,body:'missing package file'});return;}
    const extension=path.split('.').pop();
    const contentType=extension==='js'?'application/javascript':extension==='css'?'text/css':extension==='html'?'text/html':extension==='json'?'application/json':extension==='svg'?'image/svg+xml':'application/octet-stream';
    await route.fulfill({status:200,contentType,body:Buffer.from(data)});
  });
  await viewer.goto('https://lantern.hyde.test/');
  await expect(viewer.locator('canvas')).toHaveCount(1);
  await expect.poll(async()=>{
    const pixels=await Promise.all(positions.map(([x,y])=>pixel(viewer,'.player-screen canvas',x,y)));
    return pixels.every((sample,index)=>sample.slice(0,3).every((channel,channelIndex)=>Math.abs(channel-preview[index][channelIndex])<=12));
  },{timeout:20_000}).toBe(true);
  await page.getByRole('button',{name:'Close dialog'}).click();
  const flightRuler=(await page.getByLabel('Timeline ruler').boundingBox())!;
  await page.mouse.click(flightRuler.x+flightRuler.width*8.5/12,flightRuler.y+flightRuler.height/2,{modifiers:['Alt']});
  await expect.poll(()=>page.locator('.ruler-playhead').evaluate(node=>Number.parseFloat((node as HTMLElement).style.left)*12/100)).toBeCloseTo(8.5,1);
  await viewer.getByRole('slider',{name:'Playback position'}).evaluate((input:HTMLInputElement)=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'8.5');
    input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await expect(viewer.locator('.player-time')).toContainText('8.5');
  await page.waitForTimeout(220);await viewer.waitForTimeout(220);
  const editorFlight=await sampledFrame(page,'.stage-frame canvas',240);
  await expect.poll(async()=>meanChannelError(editorFlight,await sampledFrame(viewer,'.player-screen canvas')),{timeout:20_000}).toBeLessThan(6);
  expect(errors).toEqual([]);
  await viewer.close();
});

test('primary showcase flight range exports playable GIF and MP4 with sound',async({page})=>{
  test.setTimeout(120_000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button',{name:/Explore the lantern keeper/}).click();
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const panel=page.getByRole('region',{name:'Video and GIF export'});
  await panel.getByRole('combobox',{name:'Export range'}).selectOption('selected');
  await panel.getByRole('spinbutton',{name:'Export from seconds'}).fill('8');
  await panel.getByRole('spinbutton',{name:'Export to seconds'}).fill('9');
  await panel.getByRole('spinbutton',{name:'Export width'}).fill('320');
  await panel.getByRole('button',{name:'GIF',exact:true}).click();
  await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption('6');
  const gifDownload=page.waitForEvent('download',{timeout:60_000});
  await panel.getByRole('button',{name:'Export GIF'}).click();
  const gif=await readFile((await (await gifDownload).path())!);
  expect(gif.subarray(0,6).toString()).toBe('GIF89a');
  expect(gif.readUInt16LE(6)).toBe(320);
  await expect(panel.getByRole('status')).toContainText('6 frames');

  await panel.getByRole('button',{name:'Video',exact:true}).click();
  await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption('12');
  await panel.getByRole('combobox',{name:'Video format'}).selectOption('mp4');
  await expect(panel.getByRole('button',{name:'Export MP4'})).toBeEnabled({timeout:30_000});
  const videoDownload=page.waitForEvent('download',{timeout:90_000});
  await panel.getByRole('button',{name:'Export MP4'}).click();
  const video=await readFile((await (await videoDownload).path())!);
  expect(video.subarray(4,8).toString()).toBe('ftyp');
  await expect(panel.getByRole('status')).toContainText('12 frames + audio');
  const metadata=await page.evaluate(async data=>{
    const url=URL.createObjectURL(new Blob([new Uint8Array(data)],{type:'video/mp4'}));
    const media=document.createElement('video');media.src=url;
    try{
      await new Promise<void>((resolve,reject)=>{media.onloadedmetadata=()=>resolve();media.onerror=()=>reject(new Error('Showcase MP4 failed to decode.'));});
      return {width:media.videoWidth,height:media.videoHeight,duration:media.duration};
    }finally{media.removeAttribute('src');media.load();URL.revokeObjectURL(url);}
  },Array.from(video));
  expect(metadata.width).toBe(320);expect(metadata.height).toBe(180);
  expect(metadata.duration).toBeGreaterThanOrEqual(1);
  expect(errors).toEqual([]);
});
