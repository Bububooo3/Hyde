import {expect,test} from '@playwright/test';

test('large media survives browser recovery through private asset storage',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  const bytes=await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;
    const context=canvas.getContext('2d')!,pixels=context.createImageData(512,512);
    let seed=123456789;
    for(let index=0;index<pixels.data.length;index+=4){
      for(let channel=0;channel<3;channel++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels.data[index+channel]=seed>>>24;}
      pixels.data[index+3]=255;
    }
    context.putImageData(pixels,0,0);
    const blob=await new Promise<Blob>(resolve=>canvas.toBlob(value=>resolve(value!),'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  expect(bytes.length).toBeGreaterThan(256*1024);
  await page.locator('input[type=file][accept="image/*,video/*,audio/*"]').setInputFiles({
    name:'large-noise.png',mimeType:'image/png',buffer:Buffer.from(bytes),
  });
  await expect(page.locator('.layer-name').filter({hasText:'large-noise'})).toBeVisible();
  await expect(page.getByText('Autosaved in this browser')).toBeVisible({timeout:15_000});
  const stored=await page.evaluate(async()=>{
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{
      const request=indexedDB.open('hyde-local');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    try{
      const transaction=db.transaction('recovery','readonly');
      const rows=await new Promise<any[]>((resolve,reject)=>{
        const request=transaction.objectStore('recovery').getAll();
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      });
      return rows.map(row=>({version:row.version,refs:row.assetRefs?.length??0,inline:row.project.assets.map((asset:{dataUrl:string})=>asset.dataUrl.length)}));
    }finally{db.close();}
  });
  expect(stored.some(row=>row.version===2&&row.refs>0&&row.inline.includes(0))).toBe(true);
  await page.reload();
  await page.getByRole('button',{name:/Resume Untitled story/}).click();
  await expect(page.locator('.layer-name').filter({hasText:'large-noise'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Assets'})).toBeVisible();
});
