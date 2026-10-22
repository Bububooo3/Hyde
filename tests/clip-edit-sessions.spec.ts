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

test('global editing shortcuts cannot mutate the base project under a clip edit',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.getByRole('textbox',{name:'Element name'}).fill('Root');
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.getByRole('textbox',{name:'Element name'}).fill('Part');
  await page.getByRole('button',{name:'Edit parent & attachment…'}).click();
  const dialog=page.getByRole('dialog',{name:'Edit assembly attachment'});
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+d');
  await expect(page.locator('.scene-element-row')).toHaveCount(2);
  await dialog.getByRole('combobox',{name:'Parent assembly'}).selectOption({label:'Root'});
  await dialog.getByRole('button',{name:'Apply'}).click();
  await expect(page.locator('.scene-element-row')).toHaveCount(2);
  await expect(page.getByRole('textbox',{name:'Element name'})).toHaveValue('Part');
  await page.getByRole('button',{name:'Edit parent & attachment…'}).click();
  await expect(dialog.getByRole('combobox',{name:'Parent assembly'}).locator('option:checked')).toHaveText('Root');
});

test('a stale clip draft remains available until explicit recovery or discard',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.getByRole('textbox',{name:'Element name'}).fill('Root');
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.getByRole('textbox',{name:'Element name'}).fill('Part');
  await page.getByRole('button',{name:'Edit parent & attachment…'}).click();
  await page.getByRole('dialog',{name:'Edit assembly attachment'}).getByRole('combobox',{name:'Parent assembly'}).selectOption({label:'Root'});
  await expect(page.getByText('Unapplied draft · recoverable in this browser')).toBeVisible();
  const savedDrafts=()=>page.evaluate(async()=>{
    const request=indexedDB.open('hyde-edit-drafts');
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    try{return await new Promise<{projectId:string;elements:{parentId?:string;attachment?:{parentId:string}}[]}[]>((resolve,reject)=>{const tx=db.transaction('drafts','readonly');const read=tx.objectStore('drafts').getAll();read.onsuccess=()=>resolve(read.result);read.onerror=()=>reject(read.error);});}finally{db.close();}
  });
  await expect.poll(async()=>(await savedDrafts()).length).toBe(1);
  const stored=await savedDrafts();
  expect(stored[0].elements.some(element=>!!(element.parentId||element.attachment?.parentId))).toBe(true);
  const originalId=stored[0].projectId;
  expect(originalId).toBeTruthy();
  await expect(page.getByText('Autosaved in this browser')).toBeVisible();
  await page.evaluate(async id=>{
    const request=indexedDB.open('hyde-local');
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('recovery','readwrite');const store=tx.objectStore('recovery');const read=store.get(`project:${id}`);read.onsuccess=()=>{const entry=read.result;entry.project.updatedAt='newer-project-revision';store.put(entry,`project:${id}`);};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}finally{db.close();}
  },originalId);
  page.on('dialog',dialog=>void dialog.accept());
  await page.reload();
  await page.getByRole('button',{name:/Resume /}).click();
  const review=page.getByRole('alertdialog',{name:'Unfinished clip edit needs review'});
  await expect(review).toBeVisible();
  await expect(page.locator('.scene-element-row')).toHaveCount(2);
  await review.getByRole('button',{name:'Keep for later'}).click();
  await expect(page.getByRole('button',{name:'Unfinished clip draft needs review'})).toBeVisible();
  await page.getByRole('button',{name:'Select Part'}).click();
  await page.getByRole('button',{name:'Edit parent & attachment…'}).click();
  await expect(review).toBeVisible();
  await review.getByRole('button',{name:'Recover as separate copy'}).click();
  const editor=page.getByRole('dialog',{name:'Edit assembly attachment'});
  await expect(editor).toBeVisible();
  await expect(page.locator('input[aria-label="Project name"]')).toHaveValue('Untitled story (recovered clip edit)');
  await expect(editor.getByRole('combobox',{name:'Parent assembly'}).locator('option:checked')).toHaveText('Root');
  await editor.getByRole('button',{name:'Cancel'}).click();
  await page.getByRole('button',{name:'Edit parent & attachment…'}).click();
  await expect(editor.getByRole('combobox',{name:'Parent assembly'})).toHaveValue('');
});
