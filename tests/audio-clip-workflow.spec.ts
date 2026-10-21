import { expect, test } from '@playwright/test';

function toneWav(seconds = 2): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    wav.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / rate) * 8000), 44 + index * 2);
  }
  return wav;
}

test('an imported recording can be trimmed, faded, split, and duplicated in the editor', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.locator('input[type=file][accept="image/*,video/*,audio/*"]').setInputFiles({
    name: 'tone.wav', mimeType: 'audio/wav', buffer: toneWav(),
  });

  const panel = page.locator('.audio-clip-panel');
  await expect(panel.getByRole('heading', { name: 'Audio clip' })).toBeVisible();
  await expect(panel.getByRole('img', { name: 'Audio waveform for the selected source range' })).toBeVisible();
  await expect(panel.getByRole('spinbutton', { name: 'Source out seconds' })).toHaveValue('2');

  await panel.getByRole('spinbutton', { name: 'Source in seconds' }).fill('0.25');
  await panel.getByRole('spinbutton', { name: 'Source in seconds' }).press('Tab');
  await panel.getByRole('spinbutton', { name: 'Source out seconds' }).fill('1.75');
  await panel.getByRole('spinbutton', { name: 'Source out seconds' }).press('Tab');
  await expect(page.getByRole('spinbutton', { name: 'Duration s' })).toHaveValue('1.5');

  await panel.getByRole('spinbutton', { name: 'Fade in seconds' }).fill('0.2');
  await panel.getByRole('spinbutton', { name: 'Fade in seconds' }).press('Tab');
  await panel.getByRole('spinbutton', { name: 'Fade out seconds' }).fill('0.3');
  await panel.getByRole('spinbutton', { name: 'Fade out seconds' }).press('Tab');
  await panel.getByRole('spinbutton', { name: 'Clip volume percent' }).fill('55');
  await panel.getByRole('button', { name: 'Mute clip' }).click();
  await expect(panel.getByRole('button', { name: 'Unmute clip' })).toBeVisible();

  const ruler = await page.locator('.ruler').boundingBox();
  expect(ruler).toBeTruthy();
  await page.mouse.click(ruler!.x + ruler!.width * (0.75 / 8), ruler!.y + ruler!.height / 2);
  await expect(panel.getByRole('button', { name: 'Split at playhead' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Split at playhead' }).click();
  await expect(page.locator('.audio-clip')).toHaveCount(2);
  await expect.poll(async () => Number(await panel.getByRole('spinbutton', { name: 'Source in seconds' }).inputValue()))
    .toBeGreaterThan(0.95);
  const splitSourceIn = Number(await panel.getByRole('spinbutton', { name: 'Source in seconds' }).inputValue());
  expect(splitSourceIn).toBeLessThan(1.05);
  await panel.getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.locator('.audio-clip')).toHaveCount(3);
  await expect(panel.getByRole('spinbutton', { name: 'Fade out seconds' })).toHaveValue('0.3');
  await expect(panel.getByRole('spinbutton', { name: 'Clip volume percent' })).toHaveValue('55');
  expect(errors).toEqual([]);
});
