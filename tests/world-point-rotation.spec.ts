import {test,expect} from '@playwright/test';

test('world-point rotation uses the chosen stage point and remains undoable',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:/New project Choose a size/}).click();
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('button',{name:'Add rectangle',exact:true}).click();
  await page.getByRole('button',{name:'World point',exact:true}).click();
  await expect(page.locator('.world-rotation-point')).toBeVisible();
  const x=page.getByRole('spinbutton',{name:'X',exact:true});
  const y=page.getByRole('spinbutton',{name:'Y',exact:true});
  const rotation=page.getByRole('spinbutton',{name:'Rotation °',exact:true});
  await page.getByRole('spinbutton',{name:'World X',exact:true}).fill('860');
  await page.getByRole('spinbutton',{name:'World Y',exact:true}).fill('540');
  await rotation.fill('90');
  await expect(x).toHaveValue('860');
  await expect(y).toHaveValue('640');
  await page.getByRole('button',{name:'Undo (Ctrl Z)',exact:true}).click();
  await expect(x).toHaveValue('960');
  await expect(y).toHaveValue('540');
  await page.getByRole('button',{name:'Redo',exact:true}).click();
  await expect(x).toHaveValue('860');
  await expect(y).toHaveValue('640');
  await page.getByRole('button',{name:'Pick point on stage',exact:true}).click();
  const frame=await page.locator('.stage-frame').boundingBox();
  expect(frame).toBeTruthy();
  await page.mouse.click(frame!.x+frame!.width*.4,frame!.y+frame!.height*.5);
  await expect(page.getByRole('spinbutton',{name:'World X',exact:true})).toHaveValue('768');
});

test('rotation handle orbits the selected object around the world point',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:/New project Choose a size/}).click();
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('button',{name:'Add rectangle',exact:true}).click();
  await page.getByRole('button',{name:'World point',exact:true}).click();
  await page.getByRole('spinbutton',{name:'World X',exact:true}).fill('860');
  const center=await page.locator('.world-rotation-point circle').boundingBox();
  const handle=await page.getByLabel('Rotate selection',{exact:true}).boundingBox();
  expect(center).toBeTruthy();expect(handle).toBeTruthy();
  const cx=center!.x+center!.width/2,cy=center!.y+center!.height/2;
  const hx=handle!.x+handle!.width/2,hy=handle!.y+handle!.height/2;
  await page.mouse.move(hx,hy);await page.mouse.down();
  await page.mouse.move(cx-(hy-cy),cy+(hx-cx),{steps:8});await page.mouse.up();
  await expect(page.getByRole('spinbutton',{name:'Rotation °',exact:true})).toHaveValue('90');
  await expect(page.getByRole('spinbutton',{name:'X',exact:true})).toHaveValue('860');
  await expect(page.getByRole('spinbutton',{name:'Y',exact:true})).toHaveValue('640');
});
