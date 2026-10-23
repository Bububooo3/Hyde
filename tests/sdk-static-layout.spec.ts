import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { decodeProjectBytes } from '../src/archive';

test('browser SDK captures editable static shape-aware text through one atomic bridge batch', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('button', { name: 'Automation access…' }).click();
  await page.getByRole('checkbox', { name: 'Write', exact: true }).check();
  await page.getByRole('button', { name: 'Allow automation' }).click();
  const captured = await page.evaluate(async () => {
    await document.fonts.ready;
    const bridge = window.hydeAutomation!;
    const revision = (await bridge.request({ protocolVersion: 1, sessionId: bridge.sessionId, requestId: 'static-revision', operation: 'inspect', payload: { target: 'project' } })).revision;
    const response = await bridge.request({ protocolVersion: 1, sessionId: bridge.sessionId, requestId: 'static-create', operation: 'execute', payload: {
      protocolVersion: 1, expectedRevision: revision, commands: [
        { op: 'element.create', args: { id: 'static-flow-shape', kind: 'ellipse', properties: { name: 'Flow shape', x: 320, y: 260, width: 180, height: 180, start: 0, duration: 8 } } },
        { op: 'element.create', args: { id: 'static-flow-text', kind: 'text', properties: { name: 'Static text', x: 90, y: 170, width: 480, height: 240, text: 'Words flow around the editable shape and remain positioned after capture.', fontFamily: 'Georgia', fontSize: 30, start: 0, duration: 8 } } },
        { op: 'element.setTextMaskTarget', args: { id: 'static-flow-text', targetId: 'static-flow-shape', mode: 'around' } },
        { op: 'text.setLayout', args: { id: 'static-flow-text', layout: 'static', width: 480 } },
        { op: 'text.captureStaticLayout', args: { id: 'static-flow-text', timeSeconds: .5 } },
      ],
    } });
    if (!response.ok) return response;
    const detail = await bridge.request({ protocolVersion: 1, sessionId: bridge.sessionId, requestId: 'static-inspect', operation: 'inspect', payload: { target: 'element', id: 'static-flow-text' } });
    return { response, detail };
  });
  expect(captured, JSON.stringify(captured)).toMatchObject({ response: { ok: true }, detail: { ok: true } });
  if (!('detail' in captured) || !captured.detail.ok) return;
  const element = (captured.detail.result as { element: { textLayout: string; staticTextFlow?: { mode: string; capturedAt: number; sourceText: string; lines: unknown[] } } }).element;
  expect(element.textLayout).toBe('static');
  expect(element.staticTextFlow).toMatchObject({ mode: 'around', capturedAt: .5 });
  expect(element.staticTextFlow?.sourceText).toContain('Words flow around');
  expect(element.staticTextFlow?.lines.length).toBeGreaterThan(0);
  await expect(page.locator('.layer-name').getByText('Static text', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('button', { name: 'Download project copy', exact: true }).click();
  const reopened = decodeProjectBytes(new Uint8Array(await readFile((await (await saved).path())!)));
  expect(reopened.elements.find(item => item.id === 'static-flow-text')?.staticTextFlow?.lines.length).toBe(element.staticTextFlow?.lines.length);
});
