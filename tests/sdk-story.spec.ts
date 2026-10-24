import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { makeSDKAcceptanceStory } from './sdkAcceptanceFixture';

test('SDK story remains editable in Hyde and produces actual browser frames and GIF', async ({ page }) => {
  test.setTimeout(90_000);
  const { sdk, session, ids, bytes } = await makeSDKAcceptanceStory();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('input[type=file][accept=".hyde,.hy"]').setInputFiles({
    name: 'sdk-acceptance.hyde', mimeType: 'application/zip', buffer: Buffer.from(bytes),
  });
  await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('SDK acceptance story');
  await expect(page.locator('.stage-frame canvas')).toHaveCount(1);
  await expect(page.locator('.layer-name').filter({ hasText: 'Island title' })).toHaveCount(1);

  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('button', { name: 'Automation access…' }).click();
  await page.getByRole('checkbox', { name: 'Preview', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Export', exact: true }).check();
  await page.getByRole('button', { name: 'Allow automation' }).click();
  await expect.poll(() => page.evaluate(() => !!window.hydeAutomation)).toBe(true);
  const rendered = await page.evaluate(async () => {
    const bridge = window.hydeAutomation!;
    const summaries = [];
    for (const [index, timeSeconds] of [1.5, 4.5].entries()) {
      const reply = await bridge.request({ protocolVersion: 1, sessionId: bridge.sessionId, requestId: `frame-${index}`, operation: 'renderFrame', payload: { timeSeconds, width: 320, height: 180, format: 'png' } });
      if (!reply.ok) return { ok: false, errors: reply.errors };
      const frame = reply.result as { bytes: Uint8Array; mime: string; width: number; height: number };
      let hash = 2166136261;
      for (const byte of frame.bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
      summaries.push({ mime: frame.mime, width: frame.width, height: frame.height, signature: [...frame.bytes.slice(0, 8)], bytes: frame.bytes.length, hash });
    }
    return { ok: true, summaries };
  });
  expect(rendered, JSON.stringify(rendered)).toMatchObject({ ok: true, summaries: [
    { mime: 'image/png', width: 320, height: 180, signature: [137, 80, 78, 71, 13, 10, 26, 10] },
    { mime: 'image/png', width: 320, height: 180, signature: [137, 80, 78, 71, 13, 10, 26, 10] },
  ] });
  if (rendered.ok) {
    expect(rendered.summaries[0].bytes).toBeGreaterThan(500);
    expect(rendered.summaries[1].bytes).toBeGreaterThan(500);
    expect(rendered.summaries[0].hash).not.toBe(rendered.summaries[1].hash);
  }

  const started = await page.evaluate(async () => {
    const bridge = window.hydeAutomation!;
    return bridge.request({ protocolVersion: 1, sessionId: bridge.sessionId, requestId: 'gif-start', operation: 'startExport', payload: {
      format: 'gif', start: 0, end: 0.35, width: 64, height: 64, fps: 6, quality: 'low', loop: false, background: '#14233d', includeAudio: false,
    } });
  });
  expect(started.ok, JSON.stringify(started)).toBe(true);
  if (!started.ok) return;
  const jobId = (started.result as { jobId: string }).jobId;
  await expect.poll(async () => {
    const status = await page.evaluate(async id => {
      const bridge = window.hydeAutomation!;
      return bridge.request({ protocolVersion: 1, sessionId: bridge.sessionId, requestId: 'gif-status', operation: 'jobStatus', payload: { jobId: id } });
    }, jobId);
    if (!status.ok) return `error:${status.errors[0]?.message}`;
    const result = status.result as { state: string; message?: string };
    return result.state === 'failed' ? `failed:${result.message}` : result.state;
  }, { timeout: 30_000 }).toBe('completed');
  const gif = await page.evaluate(async id => {
    const bridge = window.hydeAutomation!;
    const reply = await bridge.request({ protocolVersion: 1, sessionId: bridge.sessionId, requestId: 'gif-artifact', operation: 'jobArtifact', payload: { jobId: id } });
    if (!reply.ok) return { ok: false, errors: reply.errors };
    const artifact = reply.result as { bytes: Uint8Array; mime: string };
    return { ok: true, mime: artifact.mime, magic: String.fromCharCode(...artifact.bytes.slice(0, 6)), bytes: artifact.bytes.length };
  }, jobId);
  expect(gif).toMatchObject({ ok: true, mime: 'image/gif', magic: 'GIF89a' });
  if (gif.ok) expect(gif.bytes).toBeGreaterThan(100);

  await page.getByRole('button', { name: 'Revoke access' }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.layer-name').filter({ hasText: 'Island title' }).click();
  await page.getByRole('textbox', { name: 'Element name', exact: true }).fill('Island title edited');
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('button', { name: 'Download project copy', exact: true }).click();
  const editedBytes = new Uint8Array(await readFile((await (await saved).path())!));
  const edited = await sdk.openProject(editedBytes);
  expect(edited.snapshot().elements.find(item => item.id === ids.$title)?.name).toBe('Island title edited');
  expect(edited.snapshot().elements.find(item => item.id === ids.$island)?.assetId).toBe(ids.$texture);
  expect(edited.snapshot().assets).toEqual(session.snapshot().assets);
  expect(edited.snapshot().sequences).toEqual(session.snapshot().sequences);
  expect(await edited.diagnostics()).toEqual([]);
  expect(errors).toEqual([]);
  await edited.close();
  await session.close();
});

test('SDK assembly imports into Hyde and its editable geometry and texture survive editor export', async ({ page }) => {
  const { sdk, session, ids } = await makeSDKAcceptanceStory();
  const assemblyBytes = await session.exportAssembly(ids.$assembly);
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('input[type=file][accept=".hyproj"]').setInputFiles({
    name: 'lantern.hyproj', mimeType: 'application/zip', buffer: Buffer.from(assemblyBytes),
  });
  const root = page.locator('.layer-name').filter({ hasText: 'Lantern assembly' });
  await expect(root).toHaveCount(1);
  await root.click();
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export .hyproj', exact: true }).click();
  const copy = await sdk.openAssembly(new Uint8Array(await readFile((await (await saved).path())!)));
  const native = copy.inspect();
  expect(native.elements.map(item => item.name)).toEqual(expect.arrayContaining(['Lantern assembly', 'Textured island', 'Hinged beam']));
  expect(native.elements.find(item => item.name === 'Textured island')?.shapePath?.points).toHaveLength(6);
  expect(native.elements.find(item => item.name === 'Textured island')?.assetId).toBe(native.assets[0]?.id);
  expect(native.elements.find(item => item.name === 'Hinged beam')?.attachment?.type).toBe('hinge');
  expect(native.assets).toMatchObject([{ kind: 'image', mime: 'image/png' }]);
  copy.close();
  await session.close();
});
