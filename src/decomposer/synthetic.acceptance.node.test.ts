// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeAssemblyBytes, decodeProjectBytes } from '../archive';
import { DecompositionSession } from './session';
import { makeMalformedPngFixture, makeRepeatedMultiviewFixture, makeSyntheticFixture, type SyntheticFixtureName } from '../../tests/decomposerSyntheticFixtures';

const names: SyntheticFixtureName[] = [
  'simple-icon', 'multicolor-prop', 'articulated-character', 'occlusion',
  'gradient-texture', 'hole-islands', 'pixel-art', 'busy-input',
];

async function analyze(name: SyntheticFixtureName, mode: 'appearance' | 'animation-ready' = 'appearance') {
  const fixture = makeSyntheticFixture(name);
  const session = await DecompositionSession.importSources([fixture.input], { mode });
  await session.analyze();
  return { fixture, session, document: session.snapshot() };
}

function reconstructedMask(session: DecompositionSession, sourceId: string, width: number, height: number): Uint8Array {
  const result = new Uint8Array(width * height);
  for (const region of session.snapshot().regions.filter(item => item.sourceId === sourceId && item.generationStatus !== 'historical')) {
    const mask = session.maskFor(region.maskId);
    for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) if (mask.bytes[y * mask.width + x]) result[(region.bounds.y + y) * width + region.bounds.x + x] = 1;
  }
  return result;
}

describe('rights-clear synthetic decomposer acceptance inventory', () => {
  it('gives stable IDs, paths and source masks on all eight deterministic primary fixtures', async () => {
    for (const name of names) {
      const mode = name === 'articulated-character' || name === 'multicolor-prop' ? 'animation-ready' : 'appearance';
      const fixture = makeSyntheticFixture(name);
      const first = await DecompositionSession.importSources([fixture.input], { mode });
      const second = await DecompositionSession.importSources([fixture.input], { mode });
      await first.analyze(); await second.analyze();
      const a = first.snapshot(), b = second.snapshot();
      expect(a.sources.map(item => [item.id, item.byteHash, item.pixelHash]), name).toEqual(b.sources.map(item => [item.id, item.byteHash, item.pixelHash]));
      expect(a.regions, name).toEqual(b.regions);
      expect(a.parts, name).toEqual(b.parts);
      expect(a.layers, name).toEqual(b.layers);
      expect(a.diagnostics, name).toEqual(b.diagnostics);
      for (const region of a.regions) expect(first.maskFor(region.maskId), `${name}:${region.id}`).toEqual(second.maskFor(region.maskId));
      await first.close(); await second.close();
    }
  });

  it('keeps every visible foreground pixel assigned to an inspectable editable region mask', async () => {
    for (const name of names) {
      const { fixture, session, document } = await analyze(name);
      const reconstructed = reconstructedMask(session, document.sources[0].id, fixture.image.width, fixture.image.height);
      const expected = Uint8Array.from({ length: fixture.image.width * fixture.image.height }, (_, index) => Number(fixture.image.rgba[index * 4 + 3] >= document.settings.alphaThreshold));
      expect(reconstructed, name).toEqual(expected);
      for (const region of document.regions) {
        expect(region.geometry.generatedPath.points.length, `${name}:${region.id}`).toBeGreaterThanOrEqual(3);
        expect(region.geometry.generatedPath.points.length, `${name}:${region.id}`).toBeLessThanOrEqual(document.settings.maxPathPoints);
        expect(region.pixelCount, `${name}:${region.id}`).toBeGreaterThan(0);
      }
      await session.close();
    }
  });

  it('keeps a simple icon compact and separates visible prop and character pieces without inventing joints or motion', async () => {
    const icon = await analyze('simple-icon');
    expect(icon.document.regions).toHaveLength(1);
    expect(icon.document.parts).toHaveLength(1);
    expect(icon.document.regions[0].geometry.quality.maskIoU).toBeGreaterThan(0.9);
    const prop = await analyze('multicolor-prop', 'animation-ready');
    expect(prop.document.regions).toHaveLength(2);
    expect(prop.document.parts).toHaveLength(2);
    const character = await analyze('articulated-character', 'animation-ready');
    expect(character.document.regions.length).toBeGreaterThanOrEqual(5);
    expect(character.document.parts.length).toBeGreaterThanOrEqual(5);
    expect(character.document.diagnostics.map(item => item.code)).toContain('OCCLUSION_UNDERCONSTRAINED');
    expect(character.document.parts.every(item => !item.attachmentApproved && !item.attachment)).toBe(true);
    const native = decodeProjectBytes((await character.session.exportHyde({ format: 'hyde' })).bytes);
    expect(native.elements.filter(item => item.shapePath).length).toBe(character.document.regions.length);
    expect(native.elements.every(item => item.tracks.length === 0 && !item.assemblyClips?.length && !item.clipInstances?.length && !item.motionBehaviors?.length)).toBe(true);
    await icon.session.close(); await prop.session.close(); await character.session.close();
  });

  it('persists a guided character pivot, approved hinge and manual path while retaining native editability', async () => {
    const { session, document } = await analyze('articulated-character', 'animation-ready');
    const [parent, child] = document.parts;
    const region = document.regions.find(item => item.partId === child.id)!;
    const manualPath = structuredClone(region.geometry.generatedPath);
    manualPath.points[0].x += 0.01;
    const dry = await session.execute({ expectedRevision: session.revision, dryRun: true, edits: [
      { op: 'part.reparent', partId: child.id, parentId: parent.id },
      { op: 'part.setAttachment', partId: child.id, type: 'hinge', min: -35, max: 35, approved: true },
      { op: 'part.setPivot', partId: child.id, x: child.pivot.x + 1, y: child.pivot.y },
      { op: 'region.setPath', regionId: region.id, path: manualPath },
    ] });
    expect(dry.ok, JSON.stringify(dry)).toBe(true);
    expect(session.snapshot()).toEqual(document);
    const committed = await session.execute({ expectedRevision: session.revision, edits: [
      { op: 'part.reparent', partId: child.id, parentId: parent.id },
      { op: 'part.setAttachment', partId: child.id, type: 'hinge', min: -35, max: 35, approved: true },
      { op: 'part.setPivot', partId: child.id, x: child.pivot.x + 1, y: child.pivot.y },
      { op: 'region.setPath', regionId: region.id, path: manualPath },
    ] });
    expect(committed.ok, JSON.stringify(committed)).toBe(true);
    const edited = session.snapshot();
    expect(edited.regions.find(item => item.id === region.id)?.geometry.manualPath).toEqual(manualPath);
    expect(edited.parts.find(item => item.id === child.id)).toMatchObject({ parentId: parent.id, attachment: { type: 'hinge', min: -35, max: 35 }, attachmentApproved: true });
    const reopened = await DecompositionSession.openDocument(await session.saveDocument());
    expect(reopened.snapshot().regions.find(item => item.id === region.id)?.geometry.manualPath).toEqual(manualPath);
    expect(reopened.sourceBytesFor(document.sources[0].id)).toEqual(makeSyntheticFixture('articulated-character').bytes);
    const assembly = decodeAssemblyBytes((await reopened.exportHyde({ format: 'hyproj' })).bytes);
    expect(assembly.elements.find(item => item.name === child.name)?.attachment).toMatchObject({ type: 'hinge', min: -35, max: 35 });
    expect(assembly.elements.find(item => item.id.endsWith(region.id))?.shapePath).toEqual(manualPath);
    expect(assembly.elements.every(item => item.tracks.length === 0 && !item.assemblyClips?.length && !item.clipInstances?.length)).toBe(true);
    await reopened.close(); await session.close();
  });

  it('exports representable holes as native contours and discloses any residual fallback', async () => {
    for (const name of ['occlusion', 'hole-islands', 'pixel-art'] as const) {
      const { session, document } = await analyze(name);
      expect(document.regions.some(item => item.holeCount > 0), name).toBe(true);
      const unresolved = document.regions.filter(region => region.holeCount > (region.geometry.generatedPath.holes?.length ?? 0));
      if (unresolved.length) await expect(session.exportHyde({ format: 'hyde' }), name).rejects.toThrow('HOLE_NOT_REPRESENTABLE');
      const allowed = await session.exportHyde({ format: 'hyde', allowHoleApproximation: true });
      const native = decodeProjectBytes(allowed.bytes);
      expect(allowed.warnings.filter(item => item.code === 'HOLE_NOT_REPRESENTABLE').length, name).toBe(unresolved.length);
      for (const region of document.regions.filter(item => item.holeCount > 0)) {
        const element = native.elements.find(item => item.id === allowed.mapping.regionIds[region.id]);
        expect(element?.shapePath?.holes?.length ?? 0, name).toBe(region.geometry.generatedPath.holes?.length ?? 0);
      }
      expect(native.elements.filter(item => item.shapePath).length, name).toBe(document.regions.length);
      await session.close();
    }
  });

  it('retains source-authentic high-frequency color as a texture inside an editable native path', async () => {
    const { session, document, fixture } = await analyze('gradient-texture');
    expect(document.regions).toHaveLength(1);
    expect(document.regions[0].geometry.texture).toBe('source-crop');
    const exported = await session.exportHyde({ format: 'hyde' });
    const native = decodeProjectBytes(exported.bytes);
    expect(native.assets).toHaveLength(1);
    expect(native.elements.find(item => item.shapePath)?.assetId).toBe(native.assets[0].id);
    expect(native.elements.find(item => item.shapePath)?.shapePath?.points.length).toBeGreaterThanOrEqual(4);
    const reopened = await DecompositionSession.openDocument(await session.saveDocument());
    expect(reopened.sourceBytesFor(document.sources[0].id)).toEqual(fixture.bytes);
    expect(reopened.maskFor(document.regions[0].maskId)).toEqual(session.maskFor(document.regions[0].maskId));
    await reopened.close(); await session.close();
  });

  it('marks repeated multi-view matches ambiguous and preserves an explicit manual correspondence', async () => {
    const pair = makeRepeatedMultiviewFixture();
    const session = await DecompositionSession.importSources([pair.primary.input, pair.alternate.input], { mode: 'animation-ready' });
    await session.analyze();
    const first = session.snapshot();
    expect(first.regions.filter(item => item.sourceId === first.sources[0].id)).toHaveLength(2);
    expect(first.regions.filter(item => item.sourceId === first.sources[1].id)).toHaveLength(2);
    expect(first.correspondences.length).toBeGreaterThanOrEqual(4);
    expect(first.correspondences.every(item => item.kind === 'possible-match' && item.origin === 'automatic' && item.accepted === undefined)).toBe(true);
    expect(first.correspondences.some(item => item.ambiguity)).toBe(true);
    const chosen = first.correspondences[0];
    const correction = { ...chosen, accepted: true, origin: 'manual' as const, evidence: ['accepted by fixture author after inspecting source pair'] };
    const edit = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'reference.correspond', correspondence: correction }] });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    await session.analyze();
    const reopened = await DecompositionSession.openDocument(await session.saveDocument());
    expect(reopened.snapshot().correspondences.find(item => item.id === chosen.id)).toEqual(correction);
    expect(reopened.snapshot().sources).toHaveLength(2);
    const native = decodeProjectBytes((await reopened.exportHyde({ format: 'hyde' })).bytes);
    expect(native.elements.every(item => item.tracks.length === 0 && !item.assemblyClips?.length && !item.motionBehaviors?.length)).toBe(true);
    await reopened.close(); await session.close();
  });

  it('flags a busy input and refuses a misleading fragment-based native export', async () => {
    const { session, document } = await analyze('busy-input');
    expect(document.regions.length).toBeGreaterThan(500);
    expect(document.parts.length).toBeGreaterThan(500);
    expect(document.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['BACKGROUND_AMBIGUOUS', 'AMBIGUOUS_REGION', 'INSUFFICIENT_STRUCTURE']));
    await expect(session.exportHyde({ format: 'hyde' })).rejects.toThrow('INSUFFICIENT_STRUCTURE');
    expect(session.snapshot()).toEqual(document);
    await session.close();
  });

  it('rejects malformed PNG data without changing the last complete editable document', async () => {
    const baseline = await analyze('simple-icon');
    const before = baseline.session.snapshot(), revision = baseline.session.revision;
    const { badSignature, badCrc } = makeMalformedPngFixture();
    await expect(DecompositionSession.importSources([{ bytes: badSignature, name: 'bad.png', mime: 'image/png' }])).rejects.toThrow('signature');
    await expect(DecompositionSession.importSources([{ bytes: badCrc, name: 'bad.png', mime: 'image/png' }])).rejects.toThrow('CRC mismatch');
    expect(baseline.session.snapshot()).toEqual(before);
    expect(baseline.session.revision).toBe(revision);
    await baseline.session.close();
  });
});
