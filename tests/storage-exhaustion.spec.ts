import {expect,test} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {strFromU8,unzipSync} from 'fflate';

test('quota failure keeps the previous recovery and still permits a project-file backup',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await expect(page.getByText('Autosaved in this browser')).toBeVisible();
  await page.evaluate(()=>{
    const nativePut=IDBObjectStore.prototype.put;
    let fail=true;
    IDBObjectStore.prototype.put=function(this:IDBObjectStore,...args:unknown[]){
      if(this.name==='recovery'&&fail){fail=false;throw new DOMException('Simulated full browser storage','QuotaExceededError');}
      return Reflect.apply(nativePut,this,args);
    } as typeof nativePut;
  });
  await page.getByRole('button',{name:'Add rectangle'}).click();
  await expect(page.getByText('Autosave failed — save a project file')).toBeVisible();
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  const zip=unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  expect(strFromU8(zip['manifest.xml'])).toContain('Rectangle');
  await page.reload();
  await page.getByRole('button',{name:/Resume Untitled story/}).click();
  await expect(page.locator('.layer-name').filter({hasText:'Rectangle'})).toHaveCount(0);
});

test('large-asset quota failure removes staged payload and preserves recovery',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await expect(page.getByText('Autosaved in this browser')).toBeVisible();
  const bytes=await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;
    const context=canvas.getContext('2d')!,pixels=context.createImageData(512,512);
    let seed=987654321;
    for(let index=0;index<pixels.data.length;index+=4){
      for(let channel=0;channel<3;channel++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels.data[index+channel]=seed>>>24;}
      pixels.data[index+3]=255;
    }
    context.putImageData(pixels,0,0);
    const blob=await new Promise<Blob>(resolve=>canvas.toBlob(value=>resolve(value!),'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  expect(bytes.length).toBeGreaterThan(256*1024);
  await page.evaluate(()=>{
    const nativePut=IDBObjectStore.prototype.put;
    let fail=true;
    IDBObjectStore.prototype.put=function(this:IDBObjectStore,...args:unknown[]){
      if(this.name==='recovery'&&fail){fail=false;throw new DOMException('Simulated full recovery database','QuotaExceededError');}
      return Reflect.apply(nativePut,this,args);
    } as typeof nativePut;
  });
  await page.locator('input[type=file][accept="image/*,video/*,audio/*"]').setInputFiles({
    name:'large-noise.png',mimeType:'image/png',buffer:Buffer.from(bytes),
  });
  await expect(page.getByText('Autosave failed — save a project file')).toBeVisible({timeout:15_000});
  const staged=await page.evaluate(async()=>{
    const root=await navigator.storage.getDirectory();
    const folder=await root.getDirectoryHandle('hyde-recovery-assets',{create:true});
    const names:string[]=[];
    for await(const name of folder.keys())names.push(name);
    return names;
  });
  expect(staged).toEqual([]);
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  const zip=unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  expect(strFromU8(zip['manifest.xml'])).toContain('large-noise');
  await page.reload();
  await page.getByRole('button',{name:/Resume Untitled story/}).click();
  await expect(page.locator('.layer-name').filter({hasText:'large-noise'})).toHaveCount(0);
});
