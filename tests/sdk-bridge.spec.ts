import { expect, test } from '@playwright/test';

test('live automation is opt-in, scoped, revocable, and uses editor undo', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await page.evaluate(() => window.hydeAutomation === undefined)).toBe(true);

  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('button', { name: 'Automation access…' }).click();
  await page.getByRole('button', { name: 'Allow automation' }).click();
  const readOnly = await page.evaluate(async () => {
    const bridge = window.hydeAutomation!;
    const envelope = { protocolVersion: 1 as const, sessionId: bridge.sessionId, requestId: 'readonly' };
    return {
      inspect: await bridge.request({ ...envelope, operation: 'inspect', payload: { target: 'project' } }),
      write: await bridge.request({ ...envelope, operation: 'execute', payload: { protocolVersion: 1, expectedRevision: 0, commands: [{ op: 'element.create', args: { kind: 'rectangle' } }] } }),
    };
  });
  expect(readOnly.inspect.ok).toBe(true);
  expect(readOnly.write).toMatchObject({ ok: false, errors: [{ code: 'PERMISSION_DENIED' }] });
  await page.getByRole('button', { name: 'Revoke access' }).click();
  await expect.poll(() => page.evaluate(() => window.hydeAutomation === undefined)).toBe(true);

  await page.getByRole('checkbox', { name: 'Write', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Preview', exact: true }).check();
  await page.getByRole('button', { name: 'Allow automation' }).click();
  const result = await page.evaluate(async () => {
    const bridge = window.hydeAutomation!;
    const revision = (await bridge.request({ protocolVersion: 1, sessionId: bridge.sessionId, requestId: 'revision', operation: 'inspect', payload: { target: 'project' } })).revision;
    return bridge.request({ protocolVersion: 1, sessionId: bridge.sessionId, requestId: 'write', operation: 'execute', payload: {
      protocolVersion: 1, expectedRevision: revision, commands: [
        { op: 'element.create', args: { alias: '$a', kind: 'rectangle', properties: { name: 'Bridge first' } } },
        { op: 'element.create', args: { alias: '$b', kind: 'ellipse', properties: { name: 'Bridge second' } } },
      ],
    } });
  });
  expect(result.ok).toBe(true);
  const frame = await page.evaluate(async () => {
    const bridge = window.hydeAutomation!;
    const response = await bridge.request({ protocolVersion: 1, sessionId: bridge.sessionId, requestId: 'frame', operation: 'renderFrame', payload: { timeSeconds: 0, width: 320, height: 180, format: 'png' } });
    if (!response.ok) return { ok: false, errors: response.errors };
    const result = response.result as { bytes: Uint8Array; mime: string; width: number; height: number };
    return { ok: true, mime: result.mime, width: result.width, height: result.height, signature: [...result.bytes.slice(0, 8)], size: result.bytes.length };
  });
  expect(frame).toMatchObject({ ok: true, mime: 'image/png', width: 320, height: 180, signature: [137, 80, 78, 71, 13, 10, 26, 10] });
  expect(frame.ok && frame.size).toBeGreaterThan(100);
  await expect(page.locator('.layer-name').getByText('Bridge first', { exact: true })).toBeVisible();
  await expect(page.locator('.layer-name').getByText('Bridge second', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Undo (Ctrl Z)' }).click();
  await expect(page.locator('.layer-name').getByText('Bridge first', { exact: true })).toHaveCount(0);
  await expect(page.locator('.layer-name').getByText('Bridge second', { exact: true })).toHaveCount(0);
});
