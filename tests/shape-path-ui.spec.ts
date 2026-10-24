import {expect,test} from '@playwright/test';
import { HydeAuthoringSession } from '../src/authoring';

test('editable shape paths can be curved, dragged, undone, and reopened',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.getByRole('button',{name:'Convert to editable path'}).click();
  const overlay=page.locator('.path-overlay');
  await expect(overlay).toBeVisible();
  await page.getByRole('button',{name:'Curve point'}).click();
  await expect(overlay.locator('path')).toHaveAttribute('d',/C /);
  const canvas=page.locator('.stage-frame canvas');
  const frame=()=>canvas.evaluate((element:HTMLCanvasElement)=>element.toDataURL());
  await expect.poll(async()=>{const first=await frame();await page.waitForTimeout(80);return first===await frame();}).toBe(true);
  const renderedBefore=await frame();
  const before=await overlay.locator('path').getAttribute('d');
  const anchor=overlay.locator('circle[aria-label="Move path point 1"]');
  const box=await anchor.boundingBox();expect(box).toBeTruthy();
  await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);
  await page.mouse.down();
  await page.mouse.move(box!.x+box!.width/2+28,box!.y+box!.height/2+18,{steps:5});
  await page.mouse.up();
  const after=await overlay.locator('path').getAttribute('d');
  expect(after).not.toBe(before);
  await expect.poll(frame).not.toBe(renderedBefore);
  const renderedAfter=await frame();
  await page.keyboard.press('Control+z');
  await expect(overlay.locator('path')).toHaveAttribute('d',before!);
  await expect.poll(frame).toBe(renderedBefore);
  await page.keyboard.press('Control+Shift+z');
  await expect(overlay.locator('path')).toHaveAttribute('d',after!);
  await expect.poll(frame).toBe(renderedAfter);
  const downloaded=page.waitForEvent('download');
  await page.getByRole('button',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Download project copy'}).click();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles((await (await downloaded).path())!);
  await page.locator('.layer-name').filter({hasText:'Rectangle'}).click();
  if(await page.getByRole('button',{name:'Edit path on stage'}).isVisible())
    await page.getByRole('button',{name:'Edit path on stage'}).click();
  await expect(overlay.locator('path')).toHaveAttribute('d',after!);
});

test('native hole handles remain editable after a Hyde archive round trip', async ({ page }) => {
  const sdk = HydeAuthoringSession.create('Editable holes');
  const created = await sdk.execute({ protocolVersion: 1, expectedRevision: sdk.revision, commands: [
    { op: 'element.create', args: { id: 'ring', kind: 'rectangle', properties: { name: 'Ring', x: 300, y: 240, width: 180, height: 180, fill: '#d24b38' } } },
    { op: 'shape.setPath', args: { id: 'ring', path: { points: [
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
    ], holes: [{ points: [
      { x: .3, y: .3 }, { x: .7, y: .3 }, { x: .7, y: .7 }, { x: .3, y: .7 },
    ] }] } } },
  ] });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles({
    name: 'editable-holes.hyde', mimeType: 'application/zip', buffer: Buffer.from(sdk.exportProject()),
  });
  await page.locator('.layer-name').filter({ hasText: 'Ring' }).click();
  if (await page.getByRole('button', { name: 'Edit path on stage' }).isVisible())
    await page.getByRole('button', { name: 'Edit path on stage' }).click();
  const overlay = page.locator('.path-overlay');
  await expect(overlay.locator('circle[aria-label="Move path hole 1 point 1"]')).toBeVisible();
  const before = await overlay.locator('path').getAttribute('d');
  const box = await overlay.locator('circle[aria-label="Move path hole 1 point 1"]').boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 24, box!.y + box!.height / 2, { steps: 4 });
  await page.mouse.up();
  const after = await overlay.locator('path').getAttribute('d');
  expect(after).not.toBe(before);
  await page.keyboard.press('Control+z');
  await expect(overlay.locator('path')).toHaveAttribute('d', before!);
  await page.keyboard.press('Control+Shift+z');
  await expect(overlay.locator('path')).toHaveAttribute('d', after!);
});
