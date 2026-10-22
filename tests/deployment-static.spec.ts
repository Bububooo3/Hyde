import {expect,test} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {unzipSync} from 'fflate';

test('production editor and web export work from a static subdirectory',async({page})=>{
  test.setTimeout(90_000);
  const dist=resolve('dist');
  const types:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.woff':'font/woff','.woff2':'font/woff2'};
  const server=createServer(async(request,response)=>{
    const pathname=new URL(request.url??'/', 'http://localhost').pathname;
    if(!pathname.startsWith('/hyde/')){response.writeHead(404).end();return;}
    const relative=decodeURIComponent(pathname.slice('/hyde/'.length))||'index.html';
    const path=resolve(dist,relative);
    if(!path.startsWith(dist+sep)){response.writeHead(404).end();return;}
    try{const bytes=await readFile(path);response.writeHead(200,{'Content-Type':types[extname(path)]??'application/octet-stream'}).end(bytes);}
    catch{response.writeHead(404).end();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();if(!address||typeof address==='string')throw new Error('Static server did not expose a port.');
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/hyde/`);
    await page.getByRole('button',{name:'New project'}).click();
    await page.getByRole('button',{name:'Done'}).click();
    await page.getByRole('button',{name:'Add text'}).click();
    await expect(page.locator('.stage-frame canvas')).toBeVisible();
    const dimensions=await page.locator('.stage-frame canvas').evaluate((canvas:HTMLCanvasElement)=>[canvas.width,canvas.height]);
    expect(dimensions[0]).toBeGreaterThan(0);expect(dimensions[1]).toBeGreaterThan(0);
    await page.getByRole('button',{name:'Export',exact:true}).click();
    const download=page.waitForEvent('download');
    await page.getByRole('button',{name:/Standalone web story/}).click();
    const zip=unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
    expect(zip['index.html']).toBeDefined();
    expect(zip['story.json']).toBeDefined();
    expect(errors).toEqual([]);
  }finally{await page.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
