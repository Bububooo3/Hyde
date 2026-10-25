// @vitest-environment node
import { expect, it } from 'vitest';
import { runBrowserTask } from '../cliBrowserRunner';
import { decodePng, encodePng } from './image';
import { compareNativeRender } from './quality';
import { DecompositionSession } from './session';

const width = 48, height = 40;
function still(withFront: boolean): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 6; y < 34; y++) for (let x = 6; x < 38; x++) rgba.set([186, 62, 39, 255], (y * width + x) * 4);
  if (!withFront) rgba.set([187, 63, 39, 255], (12 * width + 21) * 4);
  if (withFront) for (let y = 6; y < 23; y++) for (let x = 19; x < 25; x++) rgba.set([33, 103, 182, 255], (y * width + x) * 4);
  return encodePng({ width, height, rgba });
}

it('uses an explicitly matched and aligned alternate still as reviewable occlusion evidence', async () => {
  const session = await DecompositionSession.importSources([
    { bytes: still(true), name: 'primary.png', mime: 'image/png', role: 'primary' },
    { bytes: still(false), name: 'alternate.png', mime: 'image/png', role: 'alternate-pose' },
  ], { mode: 'animation-ready' });
  await session.analyze();
  const first = session.snapshot(), primary = first.sources.find(item => item.role === 'primary')!, alternate = first.sources.find(item => item.role === 'alternate-pose')!;
  const back = first.regions.find(item => item.sourceId === primary.id && item.color === '#ba3e27' && item.geometry.status === 'visible')!;
  const front = first.regions.find(item => item.sourceId === primary.id && item.color === '#2167b6' && item.geometry.status === 'visible')!;
  const other = first.regions.find(item => item.sourceId === alternate.id && item.color === '#ba3e27' && item.geometry.status === 'visible')!;
  expect(back && front && other).toBeTruthy();
  expect(first.layers.every(item => !item.evidence.some(value => value.includes('manual identity')))).toBe(true);
  const match = { id: 'manual-red-identity', sourceIds: [alternate.id, primary.id] as [string, string],
    regionIds: [other.id, back.id] as [string, string], kind: 'same-part' as const, origin: 'manual' as const,
    accepted: true, evidence: ['owner identified the red part in both stills'] };
  const result = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'reference.correspond', correspondence: match }] });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  await session.analyze();
  expect(session.snapshot().layers.every(item => !item.evidence.some(value => value.includes('manual identity')))).toBe(true);
  const aligned = await session.execute({ expectedRevision: session.revision, edits: [
    { op: 'reference.setTransform', sourceId: alternate.id, transformToPrimary: [1, 0, 0, 1, 0, 0] },
  ] });
  expect(aligned.ok, JSON.stringify(aligned)).toBe(true);
  await session.analyze();
  const analyzed = session.snapshot();
  const layer = analyzed.layers.find(item => item.frontRegionId === front.id && item.backRegionId === back.id);
  expect(layer).toBeTruthy();
  expect(layer!.evidence.some(item => item.includes('manual-red-identity'))).toBe(true);
  expect(analyzed.diagnostics.some(item => item.code === 'OCCLUSION_UNDERCONSTRAINED' && item.evidence?.some(value => value.includes('aligned pixels')))).toBe(true);
  const hidden = analyzed.regions.filter(item => item.geometry.status === 'inferred' && item.generationStatus !== 'historical');
  expect(hidden).toHaveLength(1);
  expect(hidden[0].partId).toBe(back.partId);
  expect(hidden[0].confidence.reasons.some(item => item.includes('uncertain'))).toBe(true);
  const invalidTexture = await session.execute({ expectedRevision: session.revision, edits: [
    { op: 'region.setAlignedTexture', regionId: back.id, sourceId: alternate.id },
  ] });
  expect(invalidTexture.ok).toBe(false);
  expect(session.revision).toBe(aligned.revision + 1);
  expect(analyzed.layers.some(item => item.frontRegionId === front.id && item.backRegionId === hidden[0].id && item.status === 'proposed')).toBe(true);
  if (process.env.HYDE_TEST_BROWSER) {
    const native = await session.exportHyde({ format: 'hyde' });
    const frame = await runBrowserTask(native.project, { kind: 'preview', options: { timeSeconds: 0, width, height, format: 'png' } });
    const quality = compareNativeRender(decodePng(still(true)), frame.bytes, analyzed);
    expect(quality.silhouette.iou).toBeGreaterThan(.99);
    expect(quality.color.meanAbsoluteSrgbChannelError!).toBeLessThan(.02);
  }
  const generatedColor = hidden[0].color;
  const recolor = await session.execute({ expectedRevision: session.revision, edits: [
    { op: 'region.setColor', regionId: hidden[0].id, color: '#a1b2c3' },
  ] });
  expect(recolor.ok, JSON.stringify(recolor)).toBe(true);
  expect(session.snapshot().regions.find(item => item.id === hidden[0].id)).toMatchObject({
    color: '#a1b2c3', authoredColor: '#a1b2c3', generatedColor,
  });
  await session.analyze();
  const editedHidden = session.snapshot().regions.find(item => item.id === hidden[0].id)!;
  expect(editedHidden).toMatchObject({ color: '#a1b2c3', authoredColor: '#a1b2c3', generatedColor });
  expect(editedHidden.geometry.manualPath).toBeUndefined();
  expect(editedHidden.locked.mask).toBe(false);
  const nativeEdited = await session.exportHyde({ format: 'hyde' });
  expect(nativeEdited.project.elements.find(item => item.id === nativeEdited.mapping.regionIds[hidden[0].id])?.fill).toBe('#a1b2c3');
  const colorReopened = await DecompositionSession.openDocument(await session.saveDocument());
  expect(colorReopened.snapshot().regions.find(item => item.id === hidden[0].id)?.color).toBe('#a1b2c3');
  const reset = await colorReopened.execute({ expectedRevision: colorReopened.revision, edits: [
    { op: 'region.setColor', regionId: hidden[0].id, color: null },
  ] });
  expect(reset.ok, JSON.stringify(reset)).toBe(true);
  expect(colorReopened.snapshot().regions.find(item => item.id === hidden[0].id)?.color).toBe(generatedColor);
  expect(colorReopened.undo(colorReopened.revision)).toBe(true);
  expect(colorReopened.snapshot().regions.find(item => item.id === hidden[0].id)?.color).toBe('#a1b2c3');
  await colorReopened.close();
  const chosen = await session.execute({ expectedRevision: session.revision, edits: [
    { op: 'region.setAlignedTexture', regionId: hidden[0].id, sourceId: alternate.id },
  ] });
  expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
  expect(session.snapshot().regions.find(item => item.id === hidden[0].id)?.alignedTexture?.transformToPrimary).toEqual([1, 0, 0, 1, 0, 0]);
  await session.analyze();
  const texturedRegion = session.snapshot().regions.find(item => item.id === hidden[0].id)!;
  expect(texturedRegion.alignedTexture?.sourceId).toBe(alternate.id);
  const textured = await session.exportHyde({ format: 'hyde' });
  expect(textured.warnings.some(item => item.regionId === hidden[0].id && item.code === 'TEXTURE_APPROXIMATION' && item.severity === 'warning')).toBe(true);
  const nativeShape = textured.project.elements.find(item => item.id === textured.mapping.regionIds[hidden[0].id])!;
  expect(nativeShape.kind).toBe('polygon');
  expect(nativeShape.assetId).toBeTruthy();
  const textureAsset = textured.project.assets.find(item => item.id === nativeShape.assetId)!;
  const crop = decodePng(Uint8Array.from(Buffer.from(textureAsset.dataUrl.split(',')[1], 'base64')));
  const localX = 21 - texturedRegion.bounds.x, localY = 12 - texturedRegion.bounds.y;
  const pixel = (localY * crop.width + localX) * 4;
  expect([...crop.rgba.slice(pixel, pixel + 4)]).toEqual([187, 63, 39, 255]);
  if (process.env.HYDE_TEST_BROWSER) {
    const frame = await runBrowserTask(textured.project, { kind: 'preview', options: { timeSeconds: 0, width, height, format: 'png' } });
    const quality = compareNativeRender(decodePng(still(true)), frame.bytes, session.snapshot());
    expect(quality.silhouette.iou).toBeGreaterThan(.99);
    expect(quality.color.meanAbsoluteSrgbChannelError!).toBeLessThan(.02);
  }
  const texturedReopened = await DecompositionSession.openDocument(await session.saveDocument());
  expect(texturedReopened.snapshot().regions.find(item => item.id === hidden[0].id)?.alignedTexture).toEqual(texturedRegion.alignedTexture);
  const clearTexture = await texturedReopened.execute({ expectedRevision: texturedReopened.revision, edits: [
    { op: 'region.setAlignedTexture', regionId: hidden[0].id, sourceId: null },
  ] });
  expect(clearTexture.ok, JSON.stringify(clearTexture)).toBe(true);
  expect(texturedReopened.snapshot().regions.find(item => item.id === hidden[0].id)?.alignedTexture).toBeUndefined();
  expect(texturedReopened.undo(texturedReopened.revision)).toBe(true);
  expect(texturedReopened.snapshot().regions.find(item => item.id === hidden[0].id)?.alignedTexture).toEqual(texturedRegion.alignedTexture);
  await texturedReopened.analyze({ settings: { inferHiddenGeometry: false } });
  expect(texturedReopened.snapshot().regions.find(item => item.id === hidden[0].id)?.alignedTexture).toEqual(texturedRegion.alignedTexture);
  await texturedReopened.close();
  const clearCurrent = await session.execute({ expectedRevision: session.revision, edits: [
    { op: 'region.setAlignedTexture', regionId: hidden[0].id, sourceId: null },
  ] });
  expect(clearCurrent.ok, JSON.stringify(clearCurrent)).toBe(true);
  const rejected = await session.execute({ expectedRevision: session.revision, edits: [
    { op: 'layer.rejectProposal', frontRegionId: front.id, backRegionId: back.id },
  ] });
  expect(rejected.ok, JSON.stringify(rejected)).toBe(true);
  await session.analyze();
  expect(session.snapshot().layers.find(item => item.frontRegionId === front.id && item.backRegionId === back.id)?.status).toBe('rejected');
  expect(session.snapshot().regions.filter(item => item.geometry.status === 'inferred' && item.generationStatus !== 'historical')).toHaveLength(0);
  const reopened = await DecompositionSession.openDocument(await session.saveDocument());
  expect(reopened.snapshot().layers.find(item => item.frontRegionId === front.id && item.backRegionId === back.id)?.status).toBe('rejected');
  const approval = await reopened.execute({ expectedRevision: reopened.revision, edits: [
    { op: 'layer.setRelation', frontRegionId: front.id, backRegionId: back.id, approved: true },
  ] });
  expect(approval.ok, JSON.stringify(approval)).toBe(true);
  await reopened.analyze();
  expect(reopened.snapshot().layers.find(item => item.frontRegionId === front.id && item.backRegionId === back.id)?.status).toBe('approved');
  expect(reopened.snapshot().regions.filter(item => item.geometry.status === 'inferred' && item.generationStatus !== 'historical')).toHaveLength(1);
  await reopened.close(); await session.close();
});
