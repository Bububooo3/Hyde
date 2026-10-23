// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeAssemblyBytes, decodeProjectBytes } from '../archive';
import { evaluateProject } from '../engine';
import { encodePng, decodePng } from './image';
import { DecompositionSession } from './session';

function propPng(): Uint8Array {
  const width = 40, height = 32, rgba = new Uint8Array(width * height * 4);
  const rectangle = (x0: number, y0: number, x1: number, y1: number, color: [number, number, number]) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba.set([...color, 255], (y * width + x) * 4);
  };
  // An original small, multicolor prop: two touching but independently useful pieces.
  rectangle(4, 9, 20, 23, [181, 54, 39]);
  rectangle(20, 4, 33, 27, [30, 111, 188]);
  return encodePng({ width, height, rgba });
}

function texturedPng(withHole = false): Uint8Array {
  const width = 24, height = 24, rgba = new Uint8Array(width * height * 4);
  for (let y = 3; y < 21; y++) for (let x = 3; x < 21; x++) {
    if (withHole && x >= 9 && x < 15 && y >= 9 && y < 15) continue;
    const value = (x + y) % 2 ? 168 : 190;
    rgba.set([value, value, value, 255], (y * width + x) * 4);
  }
  return encodePng({ width, height, rgba });
}

describe('deterministic decomposition and native Hyde export', () => {
  it('groups adjacent paint into one editable part while retaining separate region paths', async () => {
    const width = 20, height = 12, rgba = new Uint8Array(width * height * 4);
    for (let y = 2; y < 10; y++) for (let x = 3; x < 17; x++)
      rgba.set(x < 10 ? [169, 80, 40, 255] : [206, 80, 40, 255], (y * width + x) * 4);
    const bytes = encodePng({ width, height, rgba });
    const session = await DecompositionSession.importSources([{ bytes, name: 'paint-panels.png', mime: 'image/png' }], { mode: 'appearance' });
    await session.analyze();
    const document = session.snapshot();
    expect(document.regions.filter(item => item.generationStatus !== 'historical')).toHaveLength(2);
    expect(document.parts).toHaveLength(1);
    expect(document.parts[0].regionIds).toEqual(document.regions.map(item => item.id));
    const native = decodeProjectBytes((await session.exportHyde({ format: 'hyde' })).bytes);
    expect(native.elements.filter(item => item.kind === 'polygon')).toHaveLength(2);
    await session.close();
  });

  it('reconstructs distinct editable regions, exports both native formats and reopens source evidence', async () => {
    const bytes = propPng();
    expect(decodePng(bytes).rgba.length).toBe(40 * 32 * 4);
    const input = { bytes, name: 'two-piece-prop.png', mime: 'image/png' };
    const first = await DecompositionSession.importSources([input], { mode: 'animation-ready' });
    const second = await DecompositionSession.importSources([input], { mode: 'animation-ready' });
    const result = await first.analyze(); await second.analyze();
    expect(result.regionCount).toBe(2);
    const document = first.snapshot(), again = second.snapshot();
    expect(document.regions.map(item => ({ id: item.id, path: item.geometry.generatedPath }))).toEqual(again.regions.map(item => ({ id: item.id, path: item.geometry.generatedPath })));
    expect(document.regions.every(item => item.geometry.quality.maskIoU > .9)).toBe(true);
    expect(document.regions.every(item => item.geometry.generatedPath.points.length >= 4)).toBe(true);
    expect(document.parts).toHaveLength(2);
    const projectResult = await first.exportHyde({ format: 'hyde' });
    const project = decodeProjectBytes(projectResult.bytes);
    expect(project.elements.filter(item => item.shapePath)).toHaveLength(2);
    const pose = evaluateProject(project, 0);
    for (const region of document.regions) {
      const element = pose.find(item => item.id === projectResult.mapping.regionIds[region.id]);
      expect(element?.x).toBeCloseTo(region.bounds.x + region.bounds.width / 2);
      expect(element?.y).toBeCloseTo(region.bounds.y + region.bounds.height / 2);
    }
    expect(project.elements.every(item => !item.tracks.length && !(item.assemblyClips?.length) && !(item.motionBehaviors?.length))).toBe(true);
    const assemblyResult = await first.exportHyde({ format: 'hyproj' });
    const assembly = decodeAssemblyBytes(assemblyResult.bytes);
    expect(assembly.elements.filter(item => item.shapePath)).toHaveLength(2);
    expect(assembly.elements.filter(item => item.kind === 'group').length).toBeGreaterThanOrEqual(2);
    const archive = await first.saveDocument();
    const reopened = await DecompositionSession.openDocument(archive);
    expect(reopened.snapshot().regions).toEqual(document.regions);
    expect(reopened.sourceBytesFor(document.sources[0].id)).toEqual(bytes);
    expect((await reopened.exportHyde({ format: 'hyde' })).project.elements.filter(item => item.shapePath)).toHaveLength(2);
  });

  it('keeps manual geometry, pivots and lineage through edits, undo and regeneration', async () => {
    const session = await DecompositionSession.importSources([{ bytes: propPng(), name: 'prop.png', mime: 'image/png' }]);
    await session.analyze();
    const before = session.snapshot(), first = before.regions[0], second = before.regions[1], part = before.parts[0];
    const path = structuredClone(first.geometry.generatedPath);
    path.points[0].x += .01;
    const edit = await session.execute({ expectedRevision: session.revision, edits: [
      { op: 'region.setPath', regionId: first.id, path },
      { op: 'part.rename', partId: part.id, name: 'Handle' },
      { op: 'part.setPivot', partId: part.id, x: 17, y: 15 },
      { op: 'annotation.lock', partId: part.id, target: 'pivot', locked: true },
    ] });
    expect(edit.ok).toBe(true);
    const changed = session.snapshot();
    expect(changed.regions[0].geometry.manualPath).toEqual(path);
    expect(changed.parts[0].pivot).toEqual({ x: 17, y: 15 });
    const split = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'region.split', regionId: second.id, axis: 'y', coordinate: second.bounds.y + 8 }] });
    expect(split.ok, JSON.stringify(split)).toBe(true);
    const splitDoc = session.snapshot();
    expect(splitDoc.regions.filter(item => item.lineage.parents.includes(second.id))).toHaveLength(2);
    expect(splitDoc.regions.find(item => item.id === second.id)?.generationStatus).toBe('historical');
    expect(session.undo(session.revision)).toBe(true);
    expect(session.snapshot().regions.filter(item => item.generationStatus !== 'historical')).toHaveLength(2);
    await session.analyze({ settings: { pathTolerance: 1.2 } });
    const regenerated = session.snapshot();
    expect(regenerated.regions.find(item => item.id === first.id)?.geometry.manualPath).toEqual(path);
    expect(regenerated.parts.find(item => item.id === part.id)?.pivot).toEqual({ x: 17, y: 15 });
    expect(regenerated.regions.find(item => item.id === first.id)?.partId).toBe(part.id);
    const reopened = await DecompositionSession.openDocument(await session.saveDocument());
    expect(reopened.snapshot().regions.find(item => item.id === first.id)?.geometry.manualPath).toEqual(path);
    expect(reopened.snapshot().parts.find(item => item.id === part.id)?.pivotLocked).toBe(true);
  });

  it('preserves last complete candidate on cancellation and reports incomplete structure', async () => {
    const session = await DecompositionSession.importSources([{ bytes: propPng(), name: 'prop.png', mime: 'image/png' }]);
    await session.analyze();
    const previous = session.snapshot(), revision = session.revision;
    const controller = new AbortController(); controller.abort();
    await expect(session.analyze({ signal: controller.signal })).rejects.toThrow('CANCELED');
    expect(session.revision).toBe(revision);
    expect(session.snapshot()).toEqual(previous);
    const empty = encodePng({ width: 8, height: 8, rgba: new Uint8Array(8 * 8 * 4) });
    const blank = await DecompositionSession.importSources([{ bytes: empty, name: 'blank.png', mime: 'image/png' }]);
    await blank.analyze();
    expect(blank.snapshot().diagnostics.map(item => item.code)).toContain('INSUFFICIENT_STRUCTURE');
    await expect(blank.exportHyde({ format: 'hyde' })).rejects.toThrow('INSUFFICIENT_STRUCTURE');
  });

  it('keeps alternate pose references as uncertain correspondence evidence without motion', async () => {
    const first = propPng(), second = propPng();
    const session = await DecompositionSession.importSources([
      { bytes: first, name: 'front.png', mime: 'image/png', role: 'primary' },
      { bytes: second, name: 'other-pose.png', mime: 'image/png', role: 'alternate-pose' },
    ]);
    await session.analyze();
    expect(session.snapshot().correspondences.length).toBeGreaterThan(0);
    expect(session.snapshot().correspondences.every(item => item.kind === 'possible-match' && item.accepted !== true)).toBe(true);
    const proposal = session.snapshot().correspondences[0];
    const rejected = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'reference.correspond', correspondence: { ...proposal, accepted: false, origin: 'manual', evidence: ['visually rejected by the user'] } }] });
    expect(rejected.ok).toBe(true);
    await session.analyze();
    expect(session.snapshot().correspondences.filter(item => item.id === proposal.id)).toEqual([{ ...proposal, accepted: false, origin: 'manual', evidence: ['visually rejected by the user'] }]);
    const native = await session.exportHyde({ format: 'hyde' });
    expect(native.project.elements.every(item => item.tracks.length === 0)).toBe(true);
  });

  it('retains authentic texture inside an editable native path and refuses an unapproved transparent hole', async () => {
    const textured = await DecompositionSession.importSources([{ bytes: texturedPng(), name: 'textured.png', mime: 'image/png' }]);
    await textured.analyze();
    const regions = textured.snapshot().regions.filter(item => item.generationStatus !== 'historical');
    expect(regions).toHaveLength(1);
    expect(regions[0].geometry.texture).toBe('source-crop');
    const native = await textured.exportHyde({ format: 'hyde' });
    const parsed = decodeProjectBytes(native.bytes);
    expect(parsed.assets).toHaveLength(1);
    expect(parsed.elements.find(item => item.shapePath)?.assetId).toBe(parsed.assets[0].id);
    const hole = await DecompositionSession.importSources([{ bytes: texturedPng(true), name: 'hole.png', mime: 'image/png' }]);
    await hole.analyze();
    expect(hole.snapshot().regions[0].holeCount).toBe(1);
    await expect(hole.exportHyde({ format: 'hyde' })).rejects.toThrow('HOLE_NOT_REPRESENTABLE');
    const approximated = await hole.exportHyde({ format: 'hyde', allowHoleApproximation: true });
    expect(approximated.warnings.map(item => item.code)).toContain('HOLE_NOT_REPRESENTABLE');
    expect(approximated.project.elements.find(item => item.shapePath)?.assetId).toBeTruthy();
  });

  it('merges adjacent pieces with lineage and preserves their colors as a masked texture', async () => {
    const session = await DecompositionSession.importSources([{ bytes: propPng(), name: 'prop.png', mime: 'image/png' }]);
    await session.analyze();
    const [a, b] = session.snapshot().regions;
    const joinedPart = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'part.assignRegion', regionId: b.id, partId: a.partId! }] });
    expect(joinedPart.ok).toBe(true);
    const merged = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'region.merge', firstId: a.id, secondId: b.id }] });
    expect(merged.ok, JSON.stringify(merged)).toBe(true);
    const surviving = session.snapshot().regions.find(item => item.generationStatus !== 'historical');
    expect(surviving?.lineage.parents).toEqual([a.id, b.id]);
    expect(surviving?.geometry.texture).toBe('source-crop');
    expect((await session.exportHyde({ format: 'hyde' })).project.assets).toHaveLength(1);
  });

  it('keeps the original evidence mask after a manual mask refinement and archive reopen', async () => {
    const session = await DecompositionSession.importSources([{ bytes: propPng(), name: 'prop.png', mime: 'image/png' }]);
    await session.analyze();
    const region = session.snapshot().regions[0];
    const original = session.maskFor(region.maskId);
    const refined = { ...original, bytes: Uint8Array.from(original.bytes) };
    refined.bytes[0] = refined.bytes[0] ? 0 : 1;
    const handle = session.stageMask(refined);
    const edit = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'region.refineMask', regionId: region.id, handle }] });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    const current = session.snapshot().regions.find(item => item.id === region.id)!;
    expect(current.originalMaskId).toBe(region.maskId);
    await session.analyze({ settings: { pathTolerance: 1.1 } });
    const regenerated = session.snapshot().regions.find(item => item.id === region.id)!;
    expect(regenerated.originalMaskId).toBe(region.maskId);
    expect(session.maskFor(regenerated.maskId)).toEqual(refined);
    const reopened = await DecompositionSession.openDocument(await session.saveDocument());
    expect(reopened.maskFor(regenerated.originalMaskId!)).toEqual(original);
    expect(reopened.maskFor(regenerated.maskId)).toEqual(refined);
  });
});
