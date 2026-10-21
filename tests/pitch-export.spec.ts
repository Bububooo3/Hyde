import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';

function toneWav(seconds = 2): Buffer {
  const rate = 16_000;
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
    wav.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / rate) * 12_000), 44 + index * 2);
  }
  return wav;
}

test('independent clip pitch reaches audio video export and the offline web player', async ({ page, context }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('input[type=file][accept="image/*,video/*,audio/*"]').setInputFiles({
    name: '440Hz.wav', mimeType: 'audio/wav', buffer: toneWav(),
  });

  const clip = page.locator('.audio-clip-panel');
  await expect(clip.getByRole('spinbutton', { name: 'Source out seconds' })).toHaveValue('2');
  await page.getByRole('spinbutton', { name: 'Speed ×' }).fill('2');
  await page.getByRole('spinbutton', { name: 'Speed ×' }).press('Tab');
  await expect(page.getByRole('spinbutton', { name: 'Duration s' })).toHaveValue('1');
  await expect(clip.getByRole('spinbutton', { name: 'Source out seconds' })).toHaveValue('2');
  await clip.getByRole('button', { name: 'Unlink pitch from speed' }).click();
  await expect(clip.getByRole('button', { name: 'Link pitch to speed' })).toBeVisible();
  await clip.getByRole('spinbutton', { name: 'Pitch offset in semitones' }).fill('12');
  await clip.getByRole('spinbutton', { name: 'Pitch offset in semitones' }).press('Tab');
  await expect(clip.getByRole('spinbutton', { name: 'Pitch offset in semitones' })).toHaveValue('12');

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Video and GIF export' });
  await panel.getByRole('combobox', { name: 'Export range' }).selectOption('selected');
  await panel.getByRole('spinbutton', { name: 'Export to seconds' }).fill('1.2');
  await panel.getByRole('spinbutton', { name: 'Export width' }).fill('64');
  await panel.getByRole('combobox', { name: 'Export frame rate' }).selectOption('12');
  await expect(panel.getByText('Include project audio')).toBeVisible();
  await expect(panel.getByLabel('Include project audio')).toBeChecked();
  const format = panel.getByRole('combobox', { name: 'Video format' });
  await expect(format).toBeEnabled({ timeout: 30_000 });
  const selectedFormat = await format.inputValue();
  const exportButton = panel.getByRole('button', { name: /Export (MP4|WEBM)/ });
  await expect(exportButton).toBeEnabled();
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${selectedFormat}$`));
  const videoBytes = await readFile((await download.path())!);
  await expect(panel.getByRole('status')).toContainText('+ audio');

  // Chrome can decode audio tracks from its own MP4/WebM exports. Count crossings
  // in the active part of the clip to verify that the independent offset is used.
  const audio = await page.evaluate(async ({ base64 }) => {
    const raw = atob(base64);
    const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
    const context = new AudioContext();
    try {
      const decoded = await context.decodeAudioData(bytes.buffer);
      const pcm = decoded.getChannelData(0);
      const from = Math.floor(decoded.sampleRate * .25);
      const to = Math.min(pcm.length, Math.floor(decoded.sampleRate * .75));
      let crossings = 0;
      let previous = pcm[from];
      let peak = 0;
      for (let sample = from + 1; sample < to; sample++) {
        if (previous <= 0 && pcm[sample] > 0) crossings++;
        previous = pcm[sample];
        peak = Math.max(peak, Math.abs(previous));
      }
      return { duration: decoded.duration, frequency: crossings / ((to - from) / decoded.sampleRate), peak };
    } finally { await context.close(); }
  }, { base64: videoBytes.toString('base64') });
  expect(audio.duration).toBeGreaterThan(1.1);
  expect(audio.duration).toBeLessThan(1.35);
  expect(audio.peak).toBeGreaterThan(.01);
  expect(audio.frequency).toBeGreaterThan(800);
  expect(audio.frequency).toBeLessThan(950);

  const webDownloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await page.getByRole('button', { name: /Standalone web story/ }).click();
  const webDownload = await webDownloadPromise;
  const files = unzipSync(new Uint8Array(await readFile((await webDownload.path())!)));
  const directory = await mkdtemp(join(tmpdir(), 'hyde-pitch-export-'));
  try {
    const htmlPath = join(directory, 'index.html');
    await writeFile(htmlPath, files['index.html']);
    const viewer = await context.newPage();
    const viewerErrors: string[] = [];
    viewer.on('pageerror', error => viewerErrors.push(error.message));
    await viewer.goto(pathToFileURL(htmlPath).href);
    await expect(viewer.locator('.player-screen canvas')).toHaveCount(1);
    const savedClip = await viewer.evaluate(() => {
      const embedded = JSON.parse(document.querySelector('#hyde-story')!.textContent!);
      return embedded.elements.find((item: { kind: string }) => item.kind === 'audio');
    });
    expect(savedClip.duration).toBe(1);
    await viewer.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(viewer.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 30_000 });
    expect(viewerErrors).toEqual([]);
    await viewer.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  expect(errors).toEqual([]);
});
