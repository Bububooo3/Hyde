import {expect,test,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {createElement,createProject,type Project} from '../src/model';
import {saveProjectBlob} from '../src/storage';

/** One stable fixture exercises animated geometry, cached still art, text and a
 * shared texture in editor playback and both frame-by-frame export paths. */
function representativeProject():Project {
  const project=createProject('Sustained fixture');
  project.width=960;project.height=540;project.duration=20;project.sequences[0].duration=20;
  project.assets.push({id:'paper',name:'paper.svg',kind:'image',mime:'image/svg+xml',dataUrl:`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#24475c"/><path d="M0 40h80M40 0v80" stroke="#e5a94d" stroke-width="7"/></svg>')}`});
  for(let index=0;index<32;index++){
    const x=70+(index%8)*115,y=60+Math.floor(index/8)*120;
    const animated=index%3!==0;
    project.elements.push(createElement(index%4===0?'ellipse':'rectangle',{
      name:`Tile ${index+1}`,x,y,width:72,height:65,start:0,duration:20,
      fill:index%2?'#ffc857':'#5d8aa5',assetId:index%4===0?'paper':undefined,
      optimize:animated?'auto':'static',
      tracks:animated?[{property:'x',keyframes:[
        {id:`tile-${index}-a`,time:0,value:x,easing:'sine',direction:'inOut',mode:'smooth'},
        {id:`tile-${index}-b`,time:20,value:x+(index%2?28:-28),easing:'sine',direction:'inOut',mode:'smooth'},
      ]}]:[],
    }));
  }
  project.elements.push(createElement('text',{name:'Title',text:'A sustained Hyde story',x:480,y:475,width:720,height:60,fontSize:38,fill:'#ffffff',start:0,duration:20}));
  return project;
}

async function openFixture(page:Page,project:Project){
  const blob=await saveProjectBlob(project);
  await page.goto('/');
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles({name:'sustained.hyde',mimeType:'application/zip',buffer:Buffer.from(await blob.arrayBuffer())});
  await expect(page.locator('.stage-frame canvas')).toHaveCount(1);
}

async function metrics(page:Page){
  const session=await page.context().newCDPSession(page);
  try{
    await session.send('Performance.enable');
    await session.send('HeapProfiler.collectGarbage');
    const [performance,counters]=await Promise.all([session.send('Performance.getMetrics'),session.send('Memory.getDOMCounters')]);
    const byName=Object.fromEntries(performance.metrics.map(metric=>[metric.name,metric.value]));
    return {heapMB:+((byName.JSHeapUsedSize??0)/1048576).toFixed(1),nodes:counters.nodes,canvases:await page.locator('canvas').count(),hiddenCanvases:await page.locator('div[style*="-100000px"] canvas').count()};
  }finally{await session.detach();}
}

async function frameCadence(page:Page,durationMs:number){
  return page.evaluate(async(ms:number)=>{
    const intervals:number[]=[];let previous=performance.now();const until=previous+ms;
    await new Promise<void>(resolve=>{function sample(now:number){intervals.push(now-previous);previous=now;if(now>=until)resolve();else requestAnimationFrame(sample);}requestAnimationFrame(sample);});
    intervals.sort((a,b)=>a-b);
    return {frames:intervals.length,medianMs:+intervals[Math.floor(intervals.length*.5)].toFixed(1),p95Ms:+intervals[Math.floor(intervals.length*.95)].toFixed(1),over50ms:intervals.filter(value=>value>50).length};
  },durationMs);
}

test('sustained editor playback keeps one stage renderer and reports frame cadence and heap',async({page})=>{
  test.setTimeout(90_000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await openFixture(page,representativeProject());
  const before=await metrics(page);
  const idle=await frameCadence(page,3000);
  await page.getByRole('button',{name:'Play',exact:true}).first().click();
  const active=await frameCadence(page,10_000);
  await page.getByRole('button',{name:'Pause',exact:true}).first().click();
  const timecode=(await page.locator('.timecode').textContent())??'';
  const [minutes,seconds]=timecode.split(':').map(Number);
  const after=await metrics(page);
  console.log(`Sustained editor playback ${JSON.stringify({idle,active,timecode,before,after})}`);
  expect(active.frames).toBeGreaterThan(10);
  expect(minutes*60+seconds).toBeGreaterThanOrEqual(9);
  expect(after.canvases).toBe(before.canvases);
  expect(after.hiddenCanvases).toBe(0);
  expect(errors).toEqual([]);
});

test('repeated medium GIF exports and cancellation release rendering resources',async({page})=>{
  test.setTimeout(150_000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await openFixture(page,representativeProject());
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const panel=page.getByRole('region',{name:'Video and GIF export'});
  await panel.getByRole('button',{name:'GIF',exact:true}).click();
  await panel.getByRole('combobox',{name:'Export range'}).selectOption('selected');
  await panel.getByRole('spinbutton',{name:'Export to seconds'}).fill('6');
  await panel.getByRole('spinbutton',{name:'Export width'}).fill('320');
  await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption('15');
  const before=await metrics(page),runs=[];
  for(let index=0;index<2;index++){
    const start=performance.now(),download=page.waitForEvent('download',{timeout:90_000});
    await panel.getByRole('button',{name:'Export GIF'}).click();
    const bytes=await readFile((await (await download).path())!);
    await expect(panel.getByRole('status')).toContainText('90 frames');
    expect(bytes.subarray(0,6).toString('ascii')).toMatch(/^GIF8[79]a$/);
    const sampled=await metrics(page);
    expect(sampled.hiddenCanvases).toBe(0);
    runs.push({frames:90,seconds:+((performance.now()-start)/1000).toFixed(2),bytes:bytes.length,...sampled});
  }
  await panel.getByRole('spinbutton',{name:'Export to seconds'}).fill('8');
  await panel.getByRole('spinbutton',{name:'Export width'}).fill('640');
  await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption('30');
  await panel.getByRole('button',{name:'Export GIF'}).click();
  await expect(panel.getByRole('progressbar',{name:'Export progress'})).toBeVisible({timeout:30_000});
  await panel.getByRole('button',{name:'Cancel'}).click();
  await expect(panel.getByRole('status')).toContainText('Export canceled');
  await expect.poll(()=>page.locator('div[style*="-100000px"] canvas').count()).toBe(0);
  const afterCancel=await metrics(page);
  await panel.getByRole('spinbutton',{name:'Export to seconds'}).fill('0.5');
  await panel.getByRole('spinbutton',{name:'Export width'}).fill('64');
  await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption('6');
  const recovery=page.waitForEvent('download',{timeout:30_000});
  await panel.getByRole('button',{name:'Export GIF'}).click();
  expect((await recovery).suggestedFilename()).toMatch(/\.gif$/);
  const afterRecovery=await metrics(page);
  console.log(`Repeated GIF exports ${JSON.stringify({before,runs,afterCancel,afterRecovery})}`);
  expect(afterCancel.canvases).toBe(before.canvases);
  expect(afterRecovery.hiddenCanvases).toBe(0);
  expect(errors).toEqual([]);
});

test('repeated medium video exports and cancellation release rendering resources',async({page})=>{
  test.setTimeout(180_000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await openFixture(page,representativeProject());
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const panel=page.getByRole('region',{name:'Video and GIF export'});
  await panel.getByRole('combobox',{name:'Export range'}).selectOption('selected');
  await panel.getByRole('spinbutton',{name:'Export to seconds'}).fill('6');
  await panel.getByRole('spinbutton',{name:'Export width'}).fill('320');
  await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption('15');
  const button=panel.getByRole('button',{name:/Export (MP4|WEBM)/});
  await expect(button).toBeEnabled({timeout:30_000});
  const format=await panel.getByRole('combobox',{name:'Video format'}).inputValue();
  const before=await metrics(page),runs=[];
  for(let index=0;index<2;index++){
    const start=performance.now(),download=page.waitForEvent('download',{timeout:90_000});
    await button.click();
    const bytes=await readFile((await (await download).path())!);
    await expect(panel.getByRole('status')).toContainText('90 frames');
    expect(bytes.length).toBeGreaterThan(100);
    if(format==='mp4')expect(bytes.subarray(4,8).toString('ascii')).toBe('ftyp');
    else expect([...bytes.subarray(0,4)]).toEqual([0x1a,0x45,0xdf,0xa3]);
    const sampled=await metrics(page);
    expect(sampled.hiddenCanvases).toBe(0);
    runs.push({frames:90,seconds:+((performance.now()-start)/1000).toFixed(2),bytes:bytes.length,...sampled});
  }
  await panel.getByRole('spinbutton',{name:'Export to seconds'}).fill('8');
  await panel.getByRole('spinbutton',{name:'Export width'}).fill('640');
  await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption('30');
  await expect(button).toBeEnabled({timeout:30_000});
  await button.click();
  await expect(panel.getByRole('progressbar',{name:'Export progress'})).toBeVisible({timeout:30_000});
  await panel.getByRole('button',{name:'Cancel'}).click();
  await expect(panel.getByRole('status')).toContainText('Export canceled');
  await expect.poll(()=>page.locator('div[style*="-100000px"] canvas').count()).toBe(0);
  const afterCancel=await metrics(page);
  await panel.getByRole('spinbutton',{name:'Export to seconds'}).fill('0.5');
  await panel.getByRole('spinbutton',{name:'Export width'}).fill('64');
  await panel.getByRole('combobox',{name:'Export frame rate'}).selectOption('12');
  await expect(button).toBeEnabled({timeout:30_000});
  const recovery=page.waitForEvent('download',{timeout:30_000});
  await button.click();
  expect((await recovery).suggestedFilename()).toMatch(/\.(mp4|webm)$/);
  const afterRecovery=await metrics(page);
  console.log(`Repeated ${format.toUpperCase()} exports ${JSON.stringify({before,runs,afterCancel,afterRecovery})}`);
  expect(afterCancel.canvases).toBe(before.canvases);
  expect(afterRecovery.hiddenCanvases).toBe(0);
  expect(errors).toEqual([]);
});
