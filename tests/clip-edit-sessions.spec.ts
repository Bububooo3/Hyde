import {expect,test} from '@playwright/test';

function quietWav():Buffer{
  const samples=16000,bytes=Buffer.alloc(44+samples*2);
  bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);
  return bytes;
}

test('assembly edits offer Apply, Discard, Keep Editing and recover an unapplied draft',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.keyboard.press('Control+g');
  await page.getByRole('button',{name:'Save animation clip'}).click();
  await page.getByRole('button',{name:'Place Animation clip clip'}).click();
  const open=()=>page.getByRole('button',{name:'Edit assembly animation…'}).click();
  await open();
  await expect(page.locator('header.topbar')).toHaveAttribute('inert','');
  const editor=page.getByRole('region',{name:'Assembly clip keys'});
  await editor.getByRole('combobox',{name:'Assembly clip track'}).selectOption({label:'Rectangle · Position X'});
  await editor.getByRole('button',{name:'Shared source'}).click();
  const value=editor.getByRole('spinbutton',{name:'Assembly key 1 value'});
  const original=await value.inputValue();
  await value.fill('80');await value.press('Enter');
  await page.getByRole('button',{name:'Close clip editor'}).click();
  const choice=page.getByRole('alertdialog',{name:'Unapplied clip changes'});
  await expect(choice).toBeVisible();
  await choice.getByRole('button',{name:'Keep Editing'}).click();
  await expect(value).toHaveValue('80');
  await page.getByRole('button',{name:'Close clip editor'}).click();
  await choice.getByRole('button',{name:'Discard'}).click();
  await expect(page.locator('header.topbar')).not.toHaveAttribute('inert');
  await open();
  await editor.getByRole('combobox',{name:'Assembly clip track'}).selectOption({label:'Rectangle · Position X'});
  await editor.getByRole('button',{name:'Shared source'}).click();
  await expect(value).toHaveValue(original);
  await value.fill('120');await value.press('Enter');
  await page.getByRole('button',{name:'Close clip editor'}).click();
  await choice.getByRole('button',{name:'Apply'}).click();
  await open();
  await editor.getByRole('combobox',{name:'Assembly clip track'}).selectOption({label:'Rectangle · Position X'});
  await editor.getByRole('button',{name:'Shared source'}).click();
  await expect(value).toHaveValue('120');
  await value.fill('140');await value.press('Enter');
  await expect(page.getByText('Unapplied draft · recoverable in this browser')).toBeVisible();
  await expect(page.getByText('Autosaved in this browser')).toBeVisible();
  await page.waitForFunction(async()=>{
    const request=indexedDB.open('hyde-edit-drafts');
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    try{return await new Promise<boolean>((resolve,reject)=>{const tx=db.transaction('drafts','readonly');const read=tx.objectStore('drafts').getAll();read.onsuccess=()=>resolve(read.result.some(item=>item.elements.some((element:{assemblyClips?:{tracks:{keyframes:{value:number}[]}[]}[]})=>element.assemblyClips?.some(clip=>clip.tracks.some(track=>track.keyframes.some(key=>key.value===140))))));read.onerror=()=>reject(read.error);});}finally{db.close();}
  });
  page.on('dialog',dialog=>void dialog.accept());
  await page.reload();
  await page.getByRole('button',{name:/Resume /}).click();
  await expect(page.getByRole('dialog',{name:'Edit assembly animation'})).toBeVisible();
  await editor.getByRole('combobox',{name:'Assembly clip track'}).selectOption({label:'Rectangle · Position X'});
  await editor.getByRole('button',{name:'Shared source'}).click();
  await expect(value).toHaveValue('140');
  await page.getByRole('dialog',{name:'Edit assembly animation'}).getByRole('button',{name:'Cancel'}).click();
  await open();
  await editor.getByRole('combobox',{name:'Assembly clip track'}).selectOption({label:'Rectangle · Position X'});
  await editor.getByRole('button',{name:'Shared source'}).click();
  await expect(value).toHaveValue('120');
});

test('canceling a media clip edit leaves the clip unchanged',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.locator('input[type=file][accept="image/*,video/*,audio/*"]').setInputFiles({name:'quiet.wav',mimeType:'audio/wav',buffer:quietWav()});
  await page.getByRole('button',{name:'Edit clip…'}).click();
  const sourceIn=page.getByRole('spinbutton',{name:'Source in seconds'});
  await expect(sourceIn).toHaveValue('0');
  await sourceIn.fill('0.25');await sourceIn.press('Tab');
  await expect(sourceIn).toHaveValue('0.25');
  await page.getByRole('dialog',{name:'Edit media clip'}).getByRole('button',{name:'Cancel'}).click();
  await page.getByRole('button',{name:'Edit clip…'}).click();
  await expect(sourceIn).toHaveValue('0');
});

test('attachment hierarchy and limits apply together or discard together',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.locator('.object-heading input').fill('Root');
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.locator('.object-heading input').fill('Part');
  const open=()=>page.getByRole('button',{name:'Edit parent & attachment…'}).click();
  await open();
  const dialog=page.getByRole('dialog',{name:'Edit assembly attachment'});
  const parent=dialog.getByRole('combobox',{name:'Parent assembly'});
  await parent.selectOption({label:'Root'});
  await dialog.getByRole('combobox',{name:'Attachment type'}).selectOption('slider');
  await dialog.getByRole('spinbutton',{name:'Min attachment limit'}).fill('0');
  await dialog.getByRole('spinbutton',{name:'Min attachment limit'}).press('Tab');
  await dialog.getByRole('spinbutton',{name:'Max attachment limit'}).fill('100');
  await dialog.getByRole('spinbutton',{name:'Max attachment limit'}).press('Tab');
  await dialog.getByRole('button',{name:'Cancel'}).click();
  await open();
  await expect(parent).toHaveValue('');
  await parent.selectOption({label:'Root'});
  await dialog.getByRole('combobox',{name:'Attachment type'}).selectOption('slider');
  await dialog.getByRole('spinbutton',{name:'Min attachment limit'}).fill('0');
  await dialog.getByRole('spinbutton',{name:'Min attachment limit'}).press('Tab');
  await dialog.getByRole('spinbutton',{name:'Max attachment limit'}).fill('100');
  await dialog.getByRole('spinbutton',{name:'Max attachment limit'}).press('Tab');
  await dialog.getByRole('button',{name:'Apply'}).click();
  await open();
  await expect(parent.locator('option:checked')).toHaveText('Root');
  await expect(dialog.getByRole('combobox',{name:'Attachment type'})).toHaveValue('slider');
  await expect(dialog.getByRole('spinbutton',{name:'Min attachment limit'})).toHaveValue('0');
  await expect(dialog.getByRole('spinbutton',{name:'Max attachment limit'})).toHaveValue('100');
});
