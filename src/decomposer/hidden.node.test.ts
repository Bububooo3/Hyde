// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeProjectBytes } from '../archive';
import { encodePng } from './image';
import { exportNativeDecomposition } from './export';
import { DecompositionSession } from './session';
import { proposeHiddenContinuations } from './hidden';
import { makeSyntheticFixture } from '../../tests/decomposerSyntheticFixtures';
import type { DecompositionDocumentV1, RegionMask } from './types';

async function analyze(bytes: Uint8Array, mode: 'appearance' | 'animation-ready' = 'animation-ready') {
  const session = await DecompositionSession.importSources([{ bytes, name: 'occlusion.png', mime: 'image/png' }], { mode, settings: { inferHiddenGeometry: false } });
  await session.analyze();
  const document = session.snapshot();
  const masks = new Map<string, RegionMask>(document.regions.map(region => [region.maskId, session.maskFor(region.maskId)]));
  const rgba = session.sourcePixelsFor(document.sources[0].id).rgba;
  return { session, document, masks, rgba };
}

function maskAt(region: DecompositionDocumentV1['regions'][number], mask: RegionMask, x: number, y: number) {
  const localX = x - region.bounds.x, localY = y - region.bounds.y;
  return localX >= 0 && localY >= 0 && localX < mask.width && localY < mask.height && mask.bytes[localY * mask.width + localX] === 1;
}

describe('conservative hidden continuation proposals', () => {
  it('keeps user-split inferred children without regenerating their historical parent', async () => {
    const fixture = makeSyntheticFixture('occlusion');
    const session = await DecompositionSession.importSources([fixture.input], { mode: 'animation-ready' });
    await session.analyze();
    const hidden = session.snapshot().regions.find(region => region.geometry.status === 'inferred')!;
    const split = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'region.split', regionId: hidden.id, axis: 'x', coordinate: hidden.bounds.x + hidden.bounds.width / 2 }] });
    expect(split.ok).toBe(true);
    const children = session.snapshot().regions.filter(region => region.lineage.parents.includes(hidden.id));
    expect(children).toHaveLength(2);
    expect(children.every(region => region.geometry.status === 'inferred' && region.generationStatus === 'manual')).toBe(true);
    await session.analyze();
    const after = session.snapshot();
    expect(after.regions.find(region => region.id === hidden.id)?.generationStatus).toBe('historical');
    expect(after.regions.filter(region => region.geometry.status === 'inferred' && region.generationStatus !== 'historical')).toHaveLength(2);
    expect(children.every(region => after.layers.some(layer => layer.backRegionId === region.id))).toBe(true);
    expect((await session.exportHyde({ format: 'hyde', allowHoleApproximation: true })).project.elements.filter(element => element.shapePath)).toHaveLength(4);
    await session.close();
  });

  it('suppresses one inferred region reversibly without discarding its source document evidence', async () => {
    const fixture = makeSyntheticFixture('occlusion');
    const session = await DecompositionSession.importSources([fixture.input], { mode: 'animation-ready' });
    await session.analyze();
    const hidden = session.snapshot().regions.find(region => region.geometry.status === 'inferred')!;
    const originalMask = session.maskFor(hidden.maskId);
    const suppress = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'region.setSuppressed', regionId: hidden.id, suppressed: true }] });
    expect(suppress.ok).toBe(true);
    expect(session.snapshot().regions.find(region => region.id === hidden.id)?.suppressed).toBe(true);
    expect((session.inspect({ target: 'regions' }) as { items: unknown[] }).items).toHaveLength(2);
    expect(session.snapshot().parts.find(part => part.id === hidden.partId)?.regionIds).not.toContain(hidden.id);
    expect((await session.exportHyde({ format: 'hyde', allowHoleApproximation: true })).project.elements.filter(element => element.shapePath)).toHaveLength(2);
    await session.analyze();
    expect(session.snapshot().regions.find(region => region.id === hidden.id)?.suppressed).toBe(true);
    expect(session.snapshot().layers.some(layer => layer.backRegionId === hidden.id)).toBe(true);
    const reopened = await DecompositionSession.openDocument(await session.saveDocument());
    expect(reopened.maskFor(hidden.maskId)).toEqual(originalMask);
    const restore = await reopened.execute({ expectedRevision: reopened.revision, edits: [{ op: 'region.setSuppressed', regionId: hidden.id, suppressed: false }] });
    expect(restore.ok).toBe(true);
    expect(reopened.snapshot().parts.find(part => part.id === hidden.partId)?.regionIds).toContain(hidden.id);
    expect((await reopened.exportHyde({ format: 'hyde', allowHoleApproximation: true })).project.elements.filter(element => element.shapePath)).toHaveLength(3);
    await reopened.close();
    await session.close();
  });

  it('integrates, preserves user correction, and round-trips the uncertain editable proposal', async () => {
    const fixture = makeSyntheticFixture('occlusion');
    const session = await DecompositionSession.importSources([fixture.input], { mode: 'animation-ready' });
    await session.analyze();
    const first = session.snapshot();
    const hidden = first.regions.find(region => region.geometry.status === 'inferred')!;
    expect(hidden).toBeDefined();
    expect(first.settings.inferHiddenGeometry).toBe(true);
    expect(first.regions.filter(region => region.generationStatus !== 'historical')).toHaveLength(3);
    expect(first.parts.find(part => part.id === hidden.partId)?.hiddenGeometry).toBe('inferred');
    expect(first.layers.some(layer => layer.backRegionId === hidden.id && layer.status === 'proposed')).toBe(true);
    const originalMask = session.maskFor(hidden.maskId);
    const corrected = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'region.setPath', regionId: hidden.id, path: hidden.geometry.generatedPath }] });
    expect(corrected.ok).toBe(true);
    await session.analyze({ settings: { inferHiddenGeometry: false } });
    const retained = session.snapshot();
    expect(retained.regions.find(region => region.id === hidden.id)?.geometry.manualPath).toEqual(hidden.geometry.generatedPath);
    expect(retained.regions.find(region => region.id === hidden.id)?.generationStatus).not.toBe('historical');
    expect(retained.parts.find(part => part.id === hidden.partId)?.hiddenGeometry).toBe('user-authored');
    expect(retained.layers.some(layer => layer.backRegionId === hidden.id)).toBe(true);
    expect(session.maskFor(hidden.maskId)).toEqual(originalMask);
    const reopened = await DecompositionSession.openDocument(await session.saveDocument());
    expect(reopened.snapshot().regions.find(region => region.id === hidden.id)).toEqual(retained.regions.find(region => region.id === hidden.id));
    expect(reopened.maskFor(hidden.maskId)).toEqual(originalMask);
    const native = await reopened.exportHyde({ format: 'hyde', allowHoleApproximation: true });
    expect(native.mapping.regionIds[hidden.id]).toBeDefined();
    expect(native.project.elements.every(element => !element.tracks.length && !element.assemblyClips?.length)).toBe(true);
    await reopened.close();
    await session.close();
  });

  it('adds independently editable unseen geometry only beneath the opaque enclosed front region', async () => {
    const fixture = makeSyntheticFixture('occlusion');
    const { session, document, masks, rgba } = await analyze(fixture.bytes);
    const before = session.snapshot(), originalMasks = structuredClone([...masks]);
    const first = proposeHiddenContinuations(document, masks, rgba);
    const second = proposeHiddenContinuations(document, masks, rgba);
    expect(first).toEqual(second);
    expect(first.regions).toHaveLength(1);
    expect(first.layers).toHaveLength(1);
    expect(first.diagnostics.map(item => item.code)).toContain('HIDDEN_GEOMETRY_INFERRED');
    const hidden = first.regions[0];
    const front = document.regions.find(region => region.holeCount === 0)!;
    const back = document.regions.find(region => region.holeCount > 0)!;
    const hiddenMask = first.masks.get(hidden.maskId)!;
    const frontMask = masks.get(front.maskId)!;
    const backMask = masks.get(back.maskId)!;
    expect(hidden.geometry.status).toBe('inferred');
    expect(hidden.partId).toBe(back.partId);
    expect(hidden.geometry.generatedPath.points.length).toBeGreaterThanOrEqual(4);
    expect(hidden.geometry.quality.maskIoU).toBeGreaterThan(.98);
    expect(first.layers[0]).toMatchObject({ frontRegionId: front.id, backRegionId: hidden.id, status: 'proposed' });
    expect(hidden.confidence.reasons.join(' ')).toContain('no source pixel reveals');
    for (let y = hidden.bounds.y; y < hidden.bounds.y + hidden.bounds.height; y++) for (let x = hidden.bounds.x; x < hidden.bounds.x + hidden.bounds.width; x++) {
      if (!maskAt(hidden, hiddenMask, x, y)) continue;
      expect(maskAt(front, frontMask, x, y)).toBe(true);
      expect(maskAt(back, backMask, x, y)).toBe(false);
      expect(rgba[(y * fixture.image.width + x) * 4 + 3]).toBe(255);
    }
    expect(session.snapshot()).toEqual(before);
    expect([...masks]).toEqual(originalMasks);
    const combined = structuredClone(document);
    combined.regions.push(...first.regions);
    combined.layers.push(...first.layers);
    combined.diagnostics.push(...first.diagnostics);
    const part = combined.parts.find(item => item.id === hidden.partId)!;
    part.regionIds.push(hidden.id);
    part.hiddenGeometry = 'inferred';
    const native = await exportNativeDecomposition(combined, new Map([...masks, ...first.masks]),
      new Map([[document.sources[0].id, fixture.image]]), { format: 'hyde', allowHoleApproximation: true });
    const project = decodeProjectBytes(native.bytes);
    expect(project.elements.filter(item => item.shapePath)).toHaveLength(3);
    expect(native.mapping.regionIds[hidden.id]).toBeDefined();
    expect(project.elements.findIndex(item => item.id === native.mapping.regionIds[hidden.id])).toBeLessThan(project.elements.findIndex(item => item.id === native.mapping.regionIds[front.id]));
    await session.close();
  });

  it('returns no invented continuation for a simple icon, an appearance preset, or a translucent foreground', async () => {
    const icon = makeSyntheticFixture('simple-icon');
    const simple = await analyze(icon.bytes);
    expect(proposeHiddenContinuations(simple.document, simple.masks, simple.rgba).regions).toHaveLength(0);
    await simple.session.close();
    const opaque = makeSyntheticFixture('occlusion');
    const appearance = await analyze(opaque.bytes, 'appearance');
    expect(proposeHiddenContinuations(appearance.document, appearance.masks, appearance.rgba).regions).toHaveLength(0);
    await appearance.session.close();
    const manual = await analyze(opaque.bytes);
    const edited = structuredClone(manual.document);
    const front = edited.regions.find(region => region.holeCount === 0)!;
    front.geometry.manualPath = structuredClone(front.geometry.generatedPath);
    expect(proposeHiddenContinuations(edited, manual.masks, manual.rgba).regions).toHaveLength(0);
    await manual.session.close();
    const translucent = Uint8Array.from(opaque.image.rgba);
    for (let y = 18; y < 42; y++) for (let x = 23; x < 43; x++) translucent[(y * opaque.image.width + x) * 4 + 3] = 160;
    const source = encodePng({ width: opaque.image.width, height: opaque.image.height, rgba: translucent });
    const alpha = await analyze(source);
    expect(proposeHiddenContinuations(alpha.document, alpha.masks, alpha.rgba).regions).toHaveLength(0);
    await alpha.session.close();
  });

  it('rejects an enclosed region separated from the back surface by a transparent gap', async () => {
    const fixture = makeSyntheticFixture('occlusion');
    const rgba = Uint8Array.from(fixture.image.rgba);
    for (let y = 17; y < 43; y++) for (let x = 22; x < 44; x++) if (x === 22 || x === 43 || y === 17 || y === 42) rgba[(y * fixture.image.width + x) * 4 + 3] = 0;
    const source = encodePng({ width: fixture.image.width, height: fixture.image.height, rgba });
    const gap = await analyze(source);
    expect(gap.document.regions.length).toBeGreaterThanOrEqual(2);
    expect(proposeHiddenContinuations(gap.document, gap.masks, gap.rgba).regions).toHaveLength(0);
    await gap.session.close();
  });
});
