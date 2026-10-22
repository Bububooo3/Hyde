import {expect,test} from '@playwright/test';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {unzipSync} from 'fflate';
import {createElement,createProject} from '../src/model';
import {createMotionBehavior} from '../src/motion';
import {saveProjectBlob} from '../src/storage';

test('procedural motion is editable, seekable, saved, and rendered in a standalone web story',async({page,context})=>{
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add ellipse'}).first().click();
  await page.getByRole('button',{name:'Add motion behavior'}).click();
  await expect(page.getByText('Follow path',{exact:true}).last()).toBeVisible();
  const overlay=page.locator('.motion-path-overlay');
  await expect(overlay).toBeVisible();
  const pathBefore=await overlay.locator('path').getAttribute('d');
  const handle=await overlay.locator('circle[aria-label="Move motion point 2"]').boundingBox();expect(handle).toBeTruthy();
  await page.mouse.move(handle!.x+handle!.width/2,handle!.y+handle!.height/2);
  await page.mouse.down();
  await page.mouse.move(handle!.x+handle!.width/2+28,handle!.y+handle!.height/2+16,{steps:5});
  await page.mouse.up();
  await expect(overlay.locator('path')).not.toHaveAttribute('d',pathBefore!);
  await page.keyboard.press('Control+z');
  await expect(overlay.locator('path')).toHaveAttribute('d',pathBefore!);
  await expect(page.getByRole('button',{name:'Redo',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Redo',exact:true}).click();
  await expect(overlay.locator('path')).not.toHaveAttribute('d',pathBefore!);
  await page.locator('.motion-points summary').last().click();
  await page.getByRole('spinbutton',{name:'Point 2 X'}).fill('240');
  await expect(page.getByRole('spinbutton',{name:'Point 2 X'})).toHaveValue('240');
  await page.getByRole('combobox',{name:'New motion behavior'}).selectOption('oscillation');
  await page.getByRole('button',{name:'Add motion behavior'}).click();
  await page.getByRole('combobox',{name:'New motion behavior'}).selectOption('shake');
  await page.getByRole('button',{name:'Add motion behavior'}).click();
  await expect(page.locator('.motion-card')).toHaveCount(3);
  const image=()=>page.locator('.stage-frame canvas').evaluate((canvas:HTMLCanvasElement)=>canvas.toDataURL());
  const atStart=await image();
  const tick=await page.locator('.ruler > span').filter({hasText:'2s'}).first().boundingBox();expect(tick).toBeTruthy();
  await page.mouse.click(tick!.x+tick!.width/2,tick!.y+tick!.height/2);
  await expect.poll(image).not.toBe(atStart);
  const archiveDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await (await archiveDownload).path())!);
  await page.locator('.layer-name').filter({hasText:'Ellipse'}).click();
  await expect(page.locator('.motion-card')).toHaveCount(3);
  if(!await page.getByRole('spinbutton',{name:'Point 2 X'}).isVisible())await page.locator('.motion-points summary').last().click();
  await expect(page.getByRole('spinbutton',{name:'Point 2 X'})).toHaveValue('240');
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const webDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:/Standalone web story/}).click();
  const zip=unzipSync(new Uint8Array(await readFile((await (await webDownload).path())!)));
  const directory=await mkdtemp(join(tmpdir(),'hyde-motion-'));
  try{
    const html=join(directory,'index.html');await writeFile(html,zip['index.html']);
    const viewer=await context.newPage(),errors:string[]=[];
    viewer.on('pageerror',error=>errors.push(error.message));
    await viewer.goto(pathToFileURL(html).href);
    const types=await viewer.evaluate(()=>JSON.parse(document.querySelector('#hyde-story')!.textContent!).elements.find((element:{kind:string})=>element.kind==='ellipse')?.motionBehaviors.map((behavior:{type:string})=>behavior.type));
    expect(types).toEqual(['followPath','oscillation','shake']);
    const canvas=viewer.locator('canvas').first();
    await expect.poll(()=>canvas.evaluate((element:HTMLCanvasElement)=>element.toDataURL().length)).toBeGreaterThan(1000);
    const first=await canvas.evaluate((element:HTMLCanvasElement)=>element.toDataURL());
    await viewer.getByRole('slider',{name:'Playback position'}).evaluate((input:HTMLInputElement)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'2');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});
    await expect.poll(()=>canvas.evaluate((element:HTMLCanvasElement)=>element.toDataURL())).not.toBe(first);
    expect(errors).toEqual([]);
    await viewer.close();
  }finally{
    const absolute=await realpath(directory);
    if(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('hyde-motion-'))await rm(absolute,{recursive:true,force:true});
  }
});

test('a motion-path guide stays fixed as the object follows keyed position',async({page})=>{
  const project=createProject('Fixed motion guide'),path=createMotionBehavior('followPath',4);
  path.points=[{x:20,y:10},{x:240,y:0}];
  project.elements.push(createElement('rectangle',{
    id:'traveler',name:'Traveler',sceneId:project.sequences[0].id,x:100,y:200,duration:project.duration,motionBehaviors:[path],
    tracks:[{property:'x',keyframes:[
      {id:'first',time:0,value:100,easing:'linear',direction:'inOut',mode:'smooth'},
      {id:'second',time:4,value:500,easing:'linear',direction:'inOut',mode:'smooth'},
    ]}],
  }));
  const bytes=Buffer.from(await (await saveProjectBlob(project)).arrayBuffer());
  await page.goto('/');
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles({name:'motion.hyde',mimeType:'application/octet-stream',buffer:bytes});
  await page.locator('.layer-name').filter({hasText:'Traveler'}).click();
  await page.getByRole('button',{name:'Edit motion path on stage'}).click();
  const pathNode=page.locator('.motion-path-overlay path'),before=await pathNode.getAttribute('d');
  expect(before).toMatch(/^M 120 210 /);
  await expect(page.locator('.selection-overlay .pivot')).toHaveAttribute('cx','120');
  await expect(page.locator('.selection-overlay .pivot')).toHaveAttribute('cy','210');
  const ruler=await page.locator('.ruler').boundingBox();expect(ruler).toBeTruthy();
  await page.mouse.click(ruler!.x+ruler!.width*2/project.duration,ruler!.y+ruler!.height/2);
  await expect(pathNode).toHaveAttribute('d',before!);
});
