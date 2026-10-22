import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {unzipSync,strFromU8} from 'fflate';
import {createElement,createProject} from '../src/model';

test('example renders and an edit survives project save/reopen',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.getByRole('button',{name:'Open example'}).click();
  await expect(page.locator('.render-host canvas')).toHaveCount(1);
  await page.getByRole('button',{name:'Add ellipse',exact:true}).click();
  await page.getByRole('textbox',{name:'Element name',exact:true}).fill('Round-trip circle');
  await page.getByRole('spinbutton',{name:'X',exact:true}).fill('200');
  await page.getByRole('spinbutton',{name:'Y',exact:true}).fill('220');
  await page.getByLabel('Fill color',{exact:true}).fill('#ce6040');
  const downloadEvent=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy',exact:true}).click();
  const download=await downloadEvent;expect(download.suggestedFilename()).toMatch(/\.hyde$/);
  const path=await download.path();expect(path).toBeTruthy();
  const zip=unzipSync(new Uint8Array(await readFile(path!)));expect(Object.keys(zip).some(x=>x.endsWith('.xml'))).toBeTruthy();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles(path!);
  await expect(page.locator('.layer-name').filter({hasText:'Round-trip circle'})).toHaveCount(1);
  await page.locator('.layer-name').filter({hasText:'Round-trip circle'}).click();
  await expect(page.getByRole('spinbutton',{name:'X',exact:true})).toHaveValue('200');
  await expect(page.getByRole('spinbutton',{name:'Y',exact:true})).toHaveValue('220');
  expect(errors).toEqual([]);
});

test('keyframes, playback, timeline-only section hiding and history',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.getByRole('button',{name:'Open example'}).click();
  await page.getByRole('button',{name:'Add rectangle',exact:true}).first().click();
  await page.getByRole('textbox',{name:'Element name',exact:true}).fill('Animated rectangle');
  await page.getByRole('button',{name:'Keyframe rotation',exact:true}).click();
  const ruler=await page.locator('.ruler').boundingBox();expect(ruler).toBeTruthy();
  await page.mouse.click(ruler!.x+ruler!.width/2,ruler!.y+12);
  await page.getByRole('button',{name:'Auto key',exact:true}).click();
  await page.getByRole('spinbutton',{name:'Rotation °',exact:true}).fill('90');
  await expect(page.locator('.key-dot')).toHaveCount(2);
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  const canvas=page.locator('.render-host canvas');
  const settledCanvas=async()=>{
    await expect.poll(async()=>{const first=await canvas.evaluate((c:HTMLCanvasElement)=>c.toDataURL());await page.waitForTimeout(80);return first===await canvas.evaluate((c:HTMLCanvasElement)=>c.toDataURL());}).toBe(true);
    return canvas.evaluate((c:HTMLCanvasElement)=>c.toDataURL());
  };
  const before=await settledCanvas();
  await page.locator('.section-strip').getByRole('button',{name:'Backdrop'}).click();
  const after=await settledCanvas();
  expect(after===before).toBe(true);
  await page.getByRole('button',{name:'Delete selection',exact:true}).click();
  await expect(page.locator('.layer-name').filter({hasText:'Animated rectangle'})).toHaveCount(0);
  await page.getByRole('button',{name:'Undo (Ctrl Z)',exact:true}).click();
  await expect(page.locator('.layer-name').filter({hasText:'Animated rectangle'})).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('web export plays from an isolated origin with only its own files',async({page,context})=>{
  await page.goto('/');await page.getByRole('button',{name:'Open example'}).click();
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const downloaded=page.waitForEvent('download');
  await page.getByRole('button',{name:/Standalone web story/}).click();
  const file=await downloaded;const zip=unzipSync(new Uint8Array(await readFile((await file.path())!)));
  expect(zip['index.html']).toBeTruthy();expect(zip['story.json']).toBeTruthy();
  expect(zip['licenses/JetBrains-Mono.txt']).toBeTruthy();
  expect(Object.keys(zip).some(path=>path.endsWith('.woff2'))).toBeTruthy();
  const story=JSON.parse(strFromU8(zip['story.json']));expect(story.assets[0].dataUrl).toMatch(/^\.\/media\//);
  const viewer=await context.newPage();const requests:string[]=[];const errors:string[]=[];
  viewer.on('pageerror',e=>errors.push(e.message));
  await viewer.route('**/*',async route=>{
    const url=new URL(route.request().url());requests.push(url.origin);
    if(url.origin!=='https://isolated.hyde.test'){await route.abort();return;}
    const path=url.pathname.slice(1)||'index.html';const data=zip[path];
    if(!data){await route.fulfill({status:404,body:'not packaged'});return;}
    const ext=path.split('.').pop();const type=ext==='js'?'application/javascript':ext==='css'?'text/css':ext==='html'?'text/html':ext==='json'?'application/json':ext==='svg'?'image/svg+xml':'application/octet-stream';
    await route.fulfill({status:200,contentType:type,body:Buffer.from(data)});
  });
  await viewer.goto('https://isolated.hyde.test/');
  await expect(viewer.locator('canvas')).toHaveCount(1);
  expect(await viewer.evaluate(()=>document.fonts.check('400 40px "JetBrains Mono"'))).toBeTruthy();
  await expect(viewer.getByText('Made with Hyde')).toHaveCount(0);
  await viewer.getByRole('button',{name:'Play',exact:true}).click();
  await expect(viewer.getByRole('button',{name:'Pause',exact:true})).toBeVisible();
  await viewer.getByRole('button',{name:'Pause',exact:true}).click();
  expect(requests.every(origin=>origin==='https://isolated.hyde.test')).toBeTruthy();expect(errors).toEqual([]);
});

test('attached parts keep local coordinates when keyed and export with their parent',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.getByRole('button',{name:'Open example'}).click();
  await page.locator('.layer-name').filter({hasText:'Paper tape'}).click();
  await expect(page.getByRole('spinbutton',{name:'X',exact:true})).toHaveValue('2');
  await page.getByRole('button',{name:'Keyframe position',exact:true}).click();
  await expect(page.getByRole('spinbutton',{name:'X',exact:true})).toHaveValue('2');
  await page.locator('.layer-name').filter({hasText:'Paper Box · body'}).click();
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Export .hyproj',exact:true}).click();
  const file=await downloaded;expect(file.suggestedFilename()).toMatch(/\.hyproj$/);
  const bytes=await readFile((await file.path())!);
  await page.locator('input[type=file][accept=".hyproj"]').setInputFiles({name:'Paper box.hyproj',mimeType:'application/octet-stream',buffer:bytes});
  await expect(page.locator('.layer-name').filter({hasText:'Paper Box · hinged lid'})).toHaveCount(2);
  const saved=page.waitForEvent('download');await page.getByRole('button',{name:'File',exact:true}).click();await page.getByRole('button',{name:'Download project copy',exact:true}).click();await saved;
  expect(errors).toEqual([]);
});

test('browser recovery keeps two independently opened projects',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'Open example'}).click();
  await page.getByRole('textbox',{name:'Project name',exact:true}).fill('Recovery A');
  await expect(page.getByText('Autosaved in this browser',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/hyde.*story studio/i}).click();
  await page.getByRole('button',{name:/New project Choose a size/}).click();
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('textbox',{name:'Project name',exact:true}).fill('Recovery B');
  await expect(page.getByText('Autosaved in this browser',{exact:true})).toBeVisible();
  page.on('dialog',d=>d.accept());await page.reload();
  await expect(page.getByRole('button',{name:/Resume Recovery B/})).toBeVisible();
  await page.locator('.recent-list summary').click();
  await page.locator('.recent-list').getByRole('button',{name:/Recovery A/}).click();
  await expect(page.getByRole('textbox',{name:'Project name',exact:true})).toHaveValue('Recovery A');
});

test('text media is clipped to glyph alpha and Static layout survives a fresh renderer',async({page})=>{
  const p=createProject('Glyph mask test');p.width=400;p.height=240;p.background='#000000';
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#00ff00"/></svg>';
  p.assets=[{id:'green',name:'green.svg',mime:'image/svg+xml',kind:'image',dataUrl:'data:image/svg+xml,'+encodeURIComponent(svg)}];
  p.elements=[createElement('text',{x:50,y:40,pivotX:0,pivotY:0,width:160,height:160,text:'H',fontFamily:'Arial',fontSize:100,fill:'#ffffff',assetId:'green'})];
  await page.route('**/story.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify(p)}));
  await page.goto('/player.html');
  const counts=()=>page.locator('canvas').evaluate((c:HTMLCanvasElement)=>{const probe=document.createElement('canvas');probe.width=c.width;probe.height=c.height;const ctx=probe.getContext('2d')!;ctx.drawImage(c,0,0);const pixels=ctx.getImageData(50,40,160,160).data;let green=0,black=0,white=0;for(let i=0;i<pixels.length;i+=4){if(pixels[i]<20&&pixels[i+1]>200&&pixels[i+2]<20)green++;if(pixels[i]<10&&pixels[i+1]<10&&pixels[i+2]<10)black++;if(pixels[i]>230&&pixels[i+1]>230&&pixels[i+2]>230)white++;}return {green,black,white};});
  await expect.poll(async()=> (await counts()).green).toBeGreaterThan(100);
  const mask=await counts();expect(mask.black).toBeGreaterThan(1000);expect(mask.white).toBeLessThan(100);
  // Persisted Static width controls wrapping even when the object width differs.
  p.elements[0].assetId=undefined;p.elements[0].text='one two three four';p.elements[0].fontSize=30;p.elements[0].textLayout='static';p.elements[0].staticLayoutWidth=70;p.elements[0].width=300;
  await page.reload();
  const textBottom=()=>page.locator('canvas').evaluate((c:HTMLCanvasElement)=>{const probe=document.createElement('canvas');probe.width=c.width;probe.height=c.height;const ctx=probe.getContext('2d')!;ctx.drawImage(c,0,0);const d=ctx.getImageData(0,0,c.width,c.height).data;let last=0;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;if(d[i]>200&&d[i+1]>200&&d[i+2]>200)last=y;}return last;});
  await expect.poll(textBottom).toBeGreaterThan(120);
});
