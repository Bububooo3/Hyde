import {test,expect} from '@playwright/test';

test('Save updates a matching chosen file and asks once per project before replacement',async({page})=>{
  await page.addInitScript(()=>{
    const state={writes:[] as {name:string;blob:Blob}[],pickers:[] as string[]};
    (window as any).__hydeSaveState=state;
    (window as any).showSaveFilePicker=async(options:{suggestedName:string})=>{
      state.pickers.push(options.suggestedName);
      const name=options.suggestedName;
      return {name,async createWritable(){return {async write(blob:Blob){state.writes.push({name,blob});},async close(){},async abort(){}};}};
    };
  });
  await page.goto('/');await page.getByRole('button',{name:/New project Choose a size/}).click();await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__hydeSaveState.writes.length)).toBe(1);
  await page.getByRole('button',{name:'Add rectangle',exact:true}).click();
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Replace project file?'})).toBeVisible();
  await page.getByLabel('Do not ask again for this project').check();
  await page.getByRole('button',{name:'Replace file'}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__hydeSaveState.writes.length)).toBe(2);
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__hydeSaveState.writes.length)).toBe(3);
  await expect(page.getByRole('heading',{name:'Replace project file?'})).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).__hydeSaveState.pickers)).toEqual(['Untitled story.hyde']);
  await page.getByRole('textbox',{name:'Project name',exact:true}).fill('Renamed story');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__hydeSaveState.writes.length)).toBe(4);
  expect(await page.evaluate(()=>(window as any).__hydeSaveState.pickers)).toEqual(['Untitled story.hyde','Renamed story.hyde']);
});

test('edits made during a file write remain marked unsaved',async({page})=>{
  await page.addInitScript(()=>{
    const state:{writing:boolean;finish?:()=>void}={writing:false};
    (window as any).__hydeSlowSave=state;
    (window as any).showSaveFilePicker=async(options:{suggestedName:string})=>({name:options.suggestedName,async createWritable(){return {
      async write(){state.writing=true;await new Promise<void>(resolve=>{state.finish=resolve;});},async close(){},async abort(){}
    };}});
  });
  await page.goto('/');await page.getByRole('button',{name:/New project Choose a size/}).click();await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__hydeSlowSave.writing)).toBe(true);
  await page.getByRole('button',{name:'Add rectangle',exact:true}).click();
  await page.evaluate(()=>(window as any).__hydeSlowSave.finish());
  await expect(page.getByText('Changes not saved to file',{exact:true})).toBeVisible();
  await expect(page.getByText(/newer edits still need saving/i)).toBeVisible();
});

test('Undo and Redo mark a previously saved project as changed',async({page})=>{
  await page.addInitScript(()=>{
    (window as any).showSaveFilePicker=async(options:{suggestedName:string})=>({name:options.suggestedName,async createWritable(){return {async write(){},async close(){},async abort(){}};}});
  });
  await page.goto('/');await page.getByRole('button',{name:/New project Choose a size/}).click();await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('button',{name:'Add rectangle',exact:true}).click();
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByText('Saved to Untitled story.hyde',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Undo (Ctrl Z)',exact:true}).click();
  await expect(page.getByText('Changes not saved to file',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Redo',exact:true}).click();
  await expect(page.getByText('Changes not saved to file',{exact:true})).toBeVisible();
});
