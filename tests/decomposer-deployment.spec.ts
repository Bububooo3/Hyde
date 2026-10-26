import {expect,test} from '@playwright/test';
import {createServer as createStaticServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname,resolve,sep} from 'node:path';
import {createServer as createViteServer} from 'vite';
import {encodePng} from '../src/decomposer/image';
import {decodeAssemblyBytes,decodeProjectBytes} from '../src/archive';

function illustration():Buffer {
  const width=40,height=32,rgba=new Uint8Array(width*height*4);
  for(let y=8;y<24;y++)for(let x=4;x<20;x++)rgba.set([190,55,40,255],(y*width+x)*4);
  for(let y=4;y<28;y++)for(let x=20;x<34;x++)rgba.set([32,105,190,255],(y*width+x)*4);
  return Buffer.from(encodePng({width,height,rgba}));
}

test('main development server opens the standalone Decomposer and returns to Studio',async({page,context})=>{
  const server=await createViteServer({server:{host:'127.0.0.1',port:0},logLevel:'silent'});
  await server.listen();
  try{
    const address=server.httpServer?.address();
    if(!address||typeof address==='string')throw new Error('Vite did not open a development port.');
    const origin=`http://127.0.0.1:${address.port}`;
    await page.goto(origin+'/');
    await page.getByRole('button',{name:'Close welcome'}).click();
    await page.getByRole('button',{name:'Tools'}).click();
    const opened=context.waitForEvent('page');
    await page.getByRole('button',{name:'Image Decomposer'}).click();
    const decomposer=await opened;
    try{
      await expect(decomposer).toHaveURL(origin+'/decomposer.html');
      await expect(decomposer.getByRole('heading',{name:'Turn illustrations into editable Hyde art'})).toBeVisible();
      await decomposer.getByRole('link',{name:'Story Studio'}).click();
      await expect(decomposer).toHaveURL(origin+'/');
      await expect(decomposer.getByRole('button',{name:'Tools'})).toBeVisible();
    }finally{await decomposer.close();}
  }finally{await server.close();}
});

test('packaged apps work from /ai/hyde/ with Decomposer worker and native imports',async({page,context})=>{
  test.setTimeout(120_000);
  const dist=resolve('dist'),prefix='/ai/hyde/',requests:string[]=[],missing:string[]=[];
  const types:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.woff':'font/woff','.woff2':'font/woff2','.svg':'image/svg+xml'};
  const server=createStaticServer(async(request,response)=>{
    const pathname=new URL(request.url??'/', 'http://localhost').pathname;
    requests.push(pathname);
    if(pathname==='/favicon.ico'){response.writeHead(204).end();return;}
    if(!pathname.startsWith(prefix)){missing.push(pathname);response.writeHead(404).end();return;}
    const relative=decodeURIComponent(pathname.slice(prefix.length));
    const path=resolve(dist,relative.endsWith('/')||!relative?relative+'index.html':relative);
    if(!path.startsWith(dist+sep)){missing.push(pathname);response.writeHead(404).end();return;}
    try{const bytes=await readFile(path);response.writeHead(200,{'Content-Type':types[extname(path)]??'application/octet-stream'}).end(bytes);}
    catch{missing.push(pathname);response.writeHead(404).end();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();if(!address||typeof address==='string')throw new Error('Static server did not open a port.');
    const origin=`http://127.0.0.1:${address.port}`,errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+prefix);
    await page.getByRole('button',{name:'Close welcome'}).click();
    await page.getByRole('button',{name:'Tools'}).click();
    const opened=context.waitForEvent('page');
    await page.getByRole('button',{name:'Image Decomposer'}).click();
    const decomposer=await opened;
    decomposer.on('pageerror',error=>errors.push(error.message));
    try{
      await expect(decomposer).toHaveURL(origin+prefix+'decomposer/');
      await decomposer.getByLabel('Import images').setInputFiles({name:'two-parts.png',mimeType:'image/png',buffer:illustration()});
      await expect(decomposer.getByRole('status')).toContainText('Automatic first pass found 2 editable regions.',{timeout:30_000});
      await expect(decomposer.locator('.canvas-card canvas')).toHaveCount(2);
      await expect.poll(()=>decomposer.locator('.canvas-card canvas').last().evaluate((canvas:HTMLCanvasElement)=>canvas.width>0&&canvas.height>0)).toBe(true);
      const assemblyDownload=decomposer.waitForEvent('download');
      await decomposer.getByRole('button',{name:'Export',exact:true}).click();
      const assembly=await assemblyDownload,assemblyBytes=await readFile((await assembly.path())!);
      expect(assembly.suggestedFilename()).toMatch(/\.hyproj$/);
      expect(decodeAssemblyBytes(assemblyBytes).elements.length).toBeGreaterThan(0);
      await decomposer.getByLabel('Export format').selectOption('hyde');
      const projectDownload=decomposer.waitForEvent('download');
      await decomposer.getByRole('button',{name:'Export',exact:true}).click();
      const project=await projectDownload,projectBytes=await readFile((await project.path())!);
      expect(project.suggestedFilename()).toMatch(/\.hyde$/);
      const nativeProject=decodeProjectBytes(projectBytes);
      expect(nativeProject.elements.length).toBeGreaterThan(0);
      await decomposer.getByRole('link',{name:'Story Studio'}).click();
      await expect(decomposer).toHaveURL(origin+prefix);
      await expect(decomposer.getByRole('button',{name:'Tools'})).toBeVisible();
      const rows=page.locator('.scene-element-row'),before=await rows.count();
      await page.locator('input[type=file][accept=".hyproj"]').setInputFiles({name:assembly.suggestedFilename(),mimeType:'application/zip',buffer:assemblyBytes});
      await expect.poll(()=>rows.count()).toBeGreaterThan(before);
      await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles({name:project.suggestedFilename(),mimeType:'application/zip',buffer:projectBytes});
      await expect(page.getByRole('textbox',{name:'Project name'})).toHaveValue(nativeProject.name);
      await expect(rows).not.toHaveCount(0);
      expect(requests.some(path=>/^\/ai\/hyde\/decomposer\/assets\/worker-[^/]+\.js$/.test(path))).toBe(true);
      expect(missing).toEqual([]);
      expect(errors).toEqual([]);
      expect((await readFile(resolve(dist,'portable/player.js'))).length).toBeGreaterThan(0);
      expect((await readFile(resolve(dist,'portable/player.css'))).length).toBeGreaterThan(0);
    }finally{await decomposer.close();}
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
