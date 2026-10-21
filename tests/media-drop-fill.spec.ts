import {expect,test} from '@playwright/test';

test('dropping an image onto an existing shape makes it a masked fill',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add ellipse'}).first().click();
  const frame=await page.locator('.stage-frame').boundingBox();expect(frame).toBeTruthy();
  await page.evaluate(({x,y})=>{
    const file=new File(['<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ec1944"/></svg>'],'fill.svg',{type:'image/svg+xml'});
    const data=new DataTransfer();data.items.add(file);
    document.querySelector('.stage-workspace')!.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientX:x,clientY:y}));
  },{x:frame!.x+frame!.width/2,y:frame!.y+frame!.height/2});
  await expect(page.locator('.layer-name')).toHaveCount(1);
  await expect(page.locator('.layer-name')).toContainText('Ellipse');
  await expect(page.getByRole('combobox',{name:'Texture asset'})).toContainText('fill.svg');
  await expect(page.getByRole('button',{name:'Enable four-corner pin'})).toBeVisible();
});
