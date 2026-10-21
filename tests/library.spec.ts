import { expect, test } from '@playwright/test';

test('session library shows collapsible folders and a changeable visible depth', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open example', exact: true }).click();
  await page.evaluate(() => {
    const input = document.querySelector('input[webkitdirectory]') as HTMLInputElement;
    const paths: Array<[string, string]> = [
      ['Pack/Characters/Ada.hyproj', 'application/octet-stream'],
      ['Pack/Sounds/Loop.wav', 'audio/wav'],
      ['Pack/Sounds/Extra/Deep/More/Hit.wav', 'audio/wav'],
      ['Pack/Notes.txt', 'text/plain'],
    ];
    const transfer = new DataTransfer();
    for (const [path, type] of paths) {
      const file = new File(['test'], path.split('/').at(-1)!, { type });
      Object.defineProperty(file, 'webkitRelativePath', { value: path });
      transfer.items.add(file);
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await expect(page.getByRole('button', { name: 'Pack 3' })).toBeVisible();
  await expect(page.getByText('Pack · Snapshot')).toBeVisible();
  await expect(page.getByRole('button',{name:'Reselect'})).toBeVisible();
  await expect(page.getByText('Ada.hyproj', { exact: true })).toBeVisible();
  await expect(page.getByText('Loop.wav', { exact: true })).toBeVisible();
  await expect(page.getByText('Hit.wav', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Notes.txt', { exact: true })).toHaveCount(0);
  await expect(page.getByText('1 file in deeper folders.')).toBeVisible();

  await page.getByRole('button', { name: 'Sounds 2' }).click();
  await expect(page.getByText('Loop.wav', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sounds 2' }).click();
  await expect(page.getByText('Loop.wav', { exact: true })).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Folder depth' }).fill('5');
  await expect(page.getByText('Hit.wav', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview Loop.wav' }).click();
  await expect(page.getByRole('heading', { name: 'Loop.wav' })).toBeVisible();
  await expect(page.locator('.asset-preview audio')).toHaveCount(1);
});

test('a directory handle can refresh files without reopening the folder',async({page})=>{
  await page.addInitScript(()=>{
    const names=['Voice.wav'];
    (window as typeof window & {__hydeLibraryNames:string[]}).__hydeLibraryNames=names;
    Object.defineProperty(window,'showDirectoryPicker',{configurable:true,value:async()=>({
      kind:'directory',name:'Series Pack',
      async *entries(){for(const name of names)yield [name,{kind:'file',name,async getFile(){return new File(['fixture'],name,{type:'audio/wav'});}}];},
    })});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Open example',exact:true}).click();
  await page.getByRole('button',{name:'Libraries',exact:true}).click();
  await page.getByRole('button',{name:'Open component library folder'}).click();
  await expect(page.getByText('Series Pack · Connected')).toBeVisible();
  await expect(page.getByText('Voice.wav',{exact:true})).toBeVisible();
  await page.evaluate(()=>(window as typeof window & {__hydeLibraryNames:string[]}).__hydeLibraryNames.push('Second.wav'));
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.getByText('Second.wav',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Preview Voice.wav'}).click();
  await expect(page.getByRole('heading',{name:'Voice.wav'})).toBeVisible();
});
