import {expect,test} from '@playwright/test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {unzipSync} from 'fflate';
import {createElement,createProject} from '../src/model';
import {fontFamilyForAsset} from '../src/projectFonts';
import {saveProjectBlob} from '../src/storage';

test('broken image, unsupported video and font remain recoverable with visible warnings',async({page,context})=>{
  test.setTimeout(90_000);
  const project=createProject('Broken assets recovery');
  project.width=320;project.height=180;project.duration=2;project.sequences[0].duration=2;
  const font={id:'broken-font',name:'Missing typeface.woff2',kind:'font' as const,mime:'font/woff2',dataUrl:'data:font/woff2;base64,AA=='};
  project.assets=[
    {id:'broken-image',name:'Missing picture.png',kind:'image',mime:'image/png',dataUrl:'data:image/png;base64,AA=='},
    {id:'unsupported-video',name:'Unsupported clip.unknown',kind:'video',mime:'video/x-unknown',dataUrl:'data:video/x-unknown;base64,AA=='},
    font,
  ];
  project.elements=[
    createElement('rectangle',{id:'broken-fill',x:85,y:90,width:130,height:100,fill:'#d79a62',assetId:'broken-image',duration:2}),
    createElement('video',{id:'unsupported-clip',x:268,y:135,width:80,height:65,assetId:'unsupported-video',muted:true,duration:2}),
    createElement('text',{id:'fallback-text',name:'Fallback text',x:170,y:60,pivotX:0,pivotY:0,width:150,height:50,text:'Still editable',fontFamily:fontFamilyForAsset(font),fontSize:20,fill:'#ffffff',duration:2}),
  ];
  const archive=Buffer.from(await (await saveProjectBlob(project)).arrayBuffer());
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles({name:'broken.hyde',mimeType:'application/zip',buffer:archive});
  await expect(page.getByRole('textbox',{name:'Project name'})).toHaveValue(project.name);
  await expect(page.locator('.stage-frame canvas')).toHaveCount(1);
  await expect(page.getByRole('status')).toContainText('Missing picture.png');
  await expect(page.getByRole('status')).toContainText('Unsupported clip.unknown');
  await expect(page.getByRole('status')).toContainText('Missing typeface.woff2');
  await page.locator('.layer-name').filter({hasText:'Fallback text'}).click();
  await expect(page.getByRole('textbox',{name:'Element name'})).toHaveValue('Fallback text');
  const copyDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  const copyPath=await (await copyDownload).path();expect(copyPath).toBeTruthy();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles(copyPath!);
  await expect(page.getByRole('textbox',{name:'Project name'})).toHaveValue(project.name);
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const webDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:/Standalone web story/}).click();
  const packageFiles=unzipSync(new Uint8Array(await readFile((await (await webDownload).path())!)));
  const directory=await mkdtemp(join(tmpdir(),'hyde-missing-assets-'));
  try{
    const html=join(directory,'index.html');await writeFile(html,packageFiles['index.html']);
    const viewer=await context.newPage();viewer.on('pageerror',error=>errors.push(error.message));
    await viewer.goto(pathToFileURL(html).href);
    await expect(viewer.locator('.player-screen canvas')).toHaveCount(1);
    await expect(viewer.getByRole('alert')).toContainText('Missing picture.png');
    await expect(viewer.getByRole('alert')).toContainText('Unsupported clip.unknown');
    await expect(viewer.getByRole('alert')).toContainText('Missing typeface.woff2');
    expect(errors).toEqual([]);
    await viewer.close();
  }finally{await rm(directory,{recursive:true,force:true});}
});
