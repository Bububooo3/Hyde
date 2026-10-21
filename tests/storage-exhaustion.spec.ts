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
