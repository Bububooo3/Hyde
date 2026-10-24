// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { encodePng } from './image';
import { DecompositionSession } from './session';

function illustration(barExtends: boolean) {
  const width = 64, height = 64, rgba = new Uint8Array(width * height * 4);
  const rect = (x0: number, y0: number, x1: number, y1: number, color: [number, number, number]) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba.set([...color, 255], (y * width + x) * 4);
  };
  rect(barExtends ? 10 : 27, 20, barExtends ? 54 : 37, 28, [202, 70, 53]);
  rect(27, 28, 37, 56, [49, 113, 188]);
  return { bytes: encodePng({ width, height, rgba }), name: 'junction-art.png', mime: 'image/png' };
}

describe('source-mask T-junction layer evidence', () => {
  it('proposes a reviewable front/back order without inventing hidden pixels or motion', async () => {
    const session = await DecompositionSession.importSources([illustration(true)], { mode: 'animation-ready', settings: { inferHiddenGeometry: false } });
    try {
      await session.analyze();
      const document = session.snapshot();
      expect(document.regions.filter(region => region.generationStatus !== 'historical')).toHaveLength(2);
      const [bar, stem] = [document.regions.find(region => region.color === '#ca4635')!, document.regions.find(region => region.color === '#3171bc')!];
      expect(bar && stem).toBeTruthy();
      const relation = document.layers.find(layer => layer.frontRegionId === bar.id && layer.backRegionId === stem.id);
      expect(relation).toMatchObject({ origin: 'automatic', status: 'proposed' });
      expect(relation!.evidence.join(' ')).toMatch(/T-junction/);
      expect(document.diagnostics.find(item => item.regionId === stem.id && item.code === 'OCCLUSION_UNDERCONSTRAINED')?.evidence?.join(' ')).toMatch(/contact/);
      expect(document.regions.every(region => region.geometry.status === 'visible')).toBe(true);
      const saved = await session.saveDocument();
      const reopened = await DecompositionSession.openDocument(saved);
      expect(reopened.snapshot().layers).toEqual(document.layers);
      const native = await reopened.exportHyde({ format: 'hyde' });
      expect(native.project.elements.every(element => !element.tracks.length && !element.assemblyClips?.length && !element.motionBehaviors?.length)).toBe(true);
      await reopened.close();
    } finally { await session.close(); }
  });

  it('does not invent a direction when both contacting shapes end at the same x coordinates', async () => {
    const session = await DecompositionSession.importSources([illustration(false)], { settings: { inferHiddenGeometry: false } });
    try {
      await session.analyze();
      expect(session.snapshot().layers).toEqual([]);
    } finally { await session.close(); }
  });

  it('lets a user reverse a heuristic order and preserves that decision through reanalysis', async () => {
    const session = await DecompositionSession.importSources([illustration(true)], { mode: 'animation-ready', settings: { inferHiddenGeometry: false } });
    try {
      await session.analyze();
      const proposed = session.snapshot().layers.find(layer => layer.evidence.some(reason => reason.includes('T-junction')))!;
      const override = await session.execute({ expectedRevision: session.revision, edits: [{ op: 'layer.setRelation',
        frontRegionId: proposed.backRegionId, backRegionId: proposed.frontRegionId, approved: true }] });
      expect(override.ok, JSON.stringify(override)).toBe(true);
      expect(session.snapshot().layers).toEqual([expect.objectContaining({ origin: 'manual', status: 'approved',
        frontRegionId: proposed.backRegionId, backRegionId: proposed.frontRegionId })]);
      await session.analyze();
      expect(session.snapshot().layers).toEqual([expect.objectContaining({ origin: 'manual', status: 'approved',
        frontRegionId: proposed.backRegionId, backRegionId: proposed.frontRegionId })]);
      const reopened = await DecompositionSession.openDocument(await session.saveDocument());
      expect(reopened.snapshot().layers).toEqual(session.snapshot().layers);
      await reopened.close();
    } finally { await session.close(); }
  });

  it('keeps alternate-view junction evidence in that view without imposing its order on the primary pose', async () => {
    const session = await DecompositionSession.importSources([
      { ...illustration(false), name: 'primary.png', role: 'primary' },
      { ...illustration(true), name: 'alternate.png', role: 'alternate-view' },
    ], { settings: { inferHiddenGeometry: false } });
    try {
      await session.analyze();
      const document = session.snapshot(), alternate = document.sources.find(source => source.role === 'alternate-view')!;
      expect(document.layers).toHaveLength(1);
      expect(document.layers[0].frontRegionId).toMatch(new RegExp(`^${alternate.id}_`));
      expect(document.layers[0].backRegionId).toMatch(new RegExp(`^${alternate.id}_`));
      const native = await session.exportHyde({ format: 'hyde' });
      expect(native.project.elements.filter(element => element.shapePath)).toHaveLength(2);
      const reopened = await DecompositionSession.openDocument(await session.saveDocument());
      expect(reopened.snapshot().layers).toEqual(document.layers);
      await reopened.close();
    } finally { await session.close(); }
  });
});
