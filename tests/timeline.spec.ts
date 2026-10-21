import { expect, test } from '@playwright/test';

test('visible Delete control removes a selected keyframe before its object', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.getByRole('button',{name:'Keyframe rotation'}).click();
  await page.locator('.key-dot').click();
  await expect(page.getByRole('button',{name:'Delete keyframe'}).first()).toBeVisible();
  await page.locator('.scene-panel-bottom').getByRole('button',{name:'Delete keyframe'}).click();
  await expect(page.locator('.key-dot')).toHaveCount(0);
  await expect(page.locator('.layer-name').filter({hasText:'Rectangle'})).toHaveCount(1);
});

test('active timeline rows follow the visible viewport instead of the playhead', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.getByRole('textbox',{name:'Element name'}).fill('Early');
  await page.getByRole('button',{name:'Add scene'}).click();
  await page.getByRole('button',{name:'Add ellipse'}).click();
  await page.getByRole('textbox',{name:'Element name'}).fill('Late');
  await page.locator('.layer-name').getByText('Early',{exact:true}).click();
  await page.getByRole('button',{name:'Back to start'}).click();
  for(let i=0;i<5;i++)await page.getByRole('button',{name:'Zoom timeline in'}).click();
  await page.locator('.timeline-scroll').evaluate((element:HTMLElement)=>{element.scrollLeft=element.scrollWidth;});
  await page.getByRole('button',{name:'Showing all timeline rows'}).click();
  await expect(page.locator('.timeline-row').filter({hasText:'Late'})).toHaveCount(1);
});

test('timeline playhead, scene, keyframe and zoom controls work together', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', {name:'New project'}).click();
  await page.getByRole('button', {name:'Done'}).click();
  await page.getByRole('button', {name:'Add scene'}).click();
  await expect(page.locator('.sequence-block')).toHaveCount(2);
  await expect(page.locator('.timeline-title')).toContainText('2 scenes');

  const ruler = page.locator('.ruler');
  const rulerBounds = await ruler.boundingBox();
  expect(rulerBounds).toBeTruthy();
  await page.mouse.move(rulerBounds!.x + rulerBounds!.width * .1, rulerBounds!.y + 12);
  await page.mouse.down();
  await page.mouse.move(rulerBounds!.x + rulerBounds!.width * .4, rulerBounds!.y + 12, {steps:8});
  await page.mouse.up();
  await expect(page.locator('.timecode')).not.toContainText('00:00');

  await page.getByRole('button', {name:'Back to start'}).click();
  await page.getByRole('button', {name:'Add rectangle'}).first().click();
  await page.getByRole('button', {name:'Keyframe rotation'}).click();
  await expect(page.getByRole('button', {name:'Auto key'})).toHaveClass(/suggested/);
  await expect(page.locator('.key-dot')).toHaveCount(1);
  const lane = page.locator('.property-row .timeline-lane').first();
  const laneBounds = await lane.boundingBox();
  expect(laneBounds).toBeTruthy();
  const key = page.locator('.key-dot').first();
  const keyBounds = await key.boundingBox();
  expect(keyBounds).toBeTruthy();
  await page.mouse.move(keyBounds!.x + keyBounds!.width/2, keyBounds!.y + keyBounds!.height/2);
  await page.mouse.down();
  await page.mouse.move(keyBounds!.x + keyBounds!.width/2 + laneBounds!.width / 8, keyBounds!.y + keyBounds!.height/2, {steps:8});
  await page.mouse.up();
  await expect(page.locator('.key-dot').first()).toHaveAttribute('aria-label', /rotation keyframe at 2 seconds/);
  await page.keyboard.press('Delete');
  await expect(page.locator('.key-dot')).toHaveCount(0);
  await expect(page.locator('.layer-name').filter({hasText:'Rectangle'})).toHaveCount(1);
  await page.getByRole('button', {name:'Undo (Ctrl Z)'}).click();
  await page.locator('.key-dot').click({button:'right'});
  await expect(page.locator('.timeline-context-menu').getByRole('button', {name:'Delete keyframe'})).toBeVisible();
  await page.locator('.timeline-context-menu').getByRole('button', {name:'Delete keyframe'}).click();
  await expect(page.locator('.key-dot')).toHaveCount(0);

  await page.mouse.move(rulerBounds!.x + rulerBounds!.width * .5, rulerBounds!.y + 12);
  await page.keyboard.down('Control');
  for (let i=0; i<5; i++) await page.mouse.wheel(0,-300);
  await page.keyboard.up('Control');
  await expect(ruler.getByText('0.5s', {exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});

test('ripple trim shifts later clips in the editor', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name:'New project'}).click();
  await page.getByRole('button', {name:'Done'}).click();
  await page.getByRole('button', {name:'Add rectangle'}).first().click();
  await page.getByRole('textbox', {name:'Element name'}).fill('First clip');
  await page.getByRole('spinbutton', {name:'Duration s'}).fill('2');
  await page.getByRole('button', {name:'Add rectangle'}).first().click();
  await page.getByRole('textbox', {name:'Element name'}).fill('Second clip');
  await page.getByRole('spinbutton', {name:'Start s'}).fill('3');
  await page.getByRole('spinbutton', {name:'Duration s'}).fill('2');
  await page.getByRole('button', {name:'Normal', exact:true}).click();
  const firstClip = page.locator('.clip-block').filter({hasText:'First clip'});
  const handle = await firstClip.locator('.trim-handle').boundingBox();
  const lane = await firstClip.locator('xpath=..').boundingBox();
  expect(handle).toBeTruthy();expect(lane).toBeTruthy();
  await page.mouse.move(handle!.x+handle!.width/2, handle!.y+handle!.height/2);
  await page.mouse.down();
  await page.mouse.move(handle!.x+handle!.width/2+lane!.width/8,handle!.y+handle!.height/2,{steps:8});
  await page.mouse.up();
  await page.locator('.layer-name').filter({hasText:'Second clip'}).click();
  await expect(page.getByRole('spinbutton', {name:'Start s'})).toHaveValue('4');
});

test('scene menu carries scene contents through duplicate, retime, move and delete', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button',{name:'New project'}).click();
  await page.getByRole('button',{name:'Done'}).click();
  await page.getByRole('button',{name:'Add rectangle'}).first().click();
  await page.getByRole('button',{name:'Add scene'}).click();
  await page.getByRole('button',{name:'Add ellipse'}).click();
  await page.locator('.sequence-block').first().click({button:'right'});
  await page.locator('.timeline-context-menu').getByRole('button',{name:'Duplicate scene'}).click();
  await expect(page.locator('.sequence-block')).toHaveCount(3);
  await expect(page.locator('.layer-name').filter({hasText:'Rectangle'})).toHaveCount(2);
  await page.locator('.sequence-block').nth(1).click({button:'right'});
  await page.locator('.timeline-context-menu').getByRole('button',{name:'Set scene duration'}).click();
  await page.getByRole('spinbutton',{name:'Scene duration in seconds'}).fill('4');
  await page.getByRole('button',{name:'Apply',exact:true}).click();
  await expect(page.locator('.sequence-block').nth(1)).toContainText('4.0 s');
  await page.locator('.sequence-block').nth(1).click({button:'right'});
  await page.locator('.timeline-context-menu').getByRole('button',{name:'Move scene later'}).click();
  await expect(page.locator('.sequence-block').last()).toContainText('Scene 01 copy');
  await page.locator('.sequence-block').last().click({button:'right'});
  await page.locator('.timeline-context-menu').getByRole('button',{name:'Delete scene'}).click();
  await expect(page.locator('.sequence-block')).toHaveCount(2);
  await expect(page.locator('.layer-name').filter({hasText:'Rectangle'})).toHaveCount(1);
});
