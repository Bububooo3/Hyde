import {expect,test} from '@playwright/test';

test('locked assembly anchors open an Apply/Cancel editor and preserve authored coordinates',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Open example',exact:true}).click();
  await page.locator('.layer-name').getByText('Paper Box · hinged lid',{exact:true}).click();

  await expect(page.getByText('Hinge anchor locked to parent')).toBeVisible();
  await page.getByRole('button',{name:'Edit pivot (keeps artwork stationary)'}).click();
  await expect(page.getByLabel('Pivot locked by attachment',{exact:true})).toHaveClass(/locked/);
  const pivot=page.locator('.selection-overlay .pivot');
  const originalX=Number(await pivot.getAttribute('cx'));
  const originalY=Number(await pivot.getAttribute('cy'));

  const open=()=>page.getByRole('button',{name:'Edit attachment…',exact:true}).click();
  await open();
  const dialog=page.getByRole('dialog',{name:'Edit assembly attachment'});
  const anchorX=dialog.getByRole('spinbutton',{name:'Attachment anchor X'});
  const anchorY=dialog.getByRole('spinbutton',{name:'Attachment anchor Y'});
  const localX=Number(await anchorX.inputValue());
  const localY=Number(await anchorY.inputValue());
  await anchorX.fill(String(localX+40));
  await anchorX.press('Tab');
  await anchorY.fill(String(localY+20));
  await anchorY.press('Tab');
  await dialog.getByRole('button',{name:'Cancel'}).click();
  await expect.poll(async()=>Number(await pivot.getAttribute('cx'))).toBeCloseTo(originalX);
  await expect.poll(async()=>Number(await pivot.getAttribute('cy'))).toBeCloseTo(originalY);

  await open();
  await expect(anchorX).toHaveValue(String(localX));
  await expect(anchorY).toHaveValue(String(localY));
  await anchorX.fill(String(localX+40));
  await anchorX.press('Tab');
  await anchorY.fill(String(localY+20));
  await anchorY.press('Tab');
  await dialog.getByRole('combobox',{name:'Attachment type'}).selectOption('fixed');
  await dialog.getByRole('button',{name:'Apply'}).click();
  await expect(page.getByText('Fixed anchor locked to parent')).toBeVisible();
  await page.getByRole('button',{name:'Select and move'}).click();
  await expect(page.getByLabel('Rotation locked by attachment',{exact:true})).toHaveClass(/locked/);
  await expect.poll(async()=>Number(await pivot.getAttribute('cx'))).toBeCloseTo(originalX+40);
  await expect.poll(async()=>Number(await pivot.getAttribute('cy'))).toBeCloseTo(originalY+20);

  await page.getByRole('button',{name:'Undo (Ctrl Z)',exact:true}).click();
  await expect.poll(async()=>Number(await pivot.getAttribute('cx'))).toBeCloseTo(originalX);
  await expect(page.getByText('Hinge anchor locked to parent')).toBeVisible();
  await page.getByRole('button',{name:'Redo',exact:true}).click();
  await expect.poll(async()=>Number(await pivot.getAttribute('cx'))).toBeCloseTo(originalX+40);
  await open();
  await expect(anchorX).toHaveValue(String(localX+40));
  await expect(anchorY).toHaveValue(String(localY+20));
  await expect(dialog.getByRole('combobox',{name:'Attachment type'})).toHaveValue('fixed');
});
