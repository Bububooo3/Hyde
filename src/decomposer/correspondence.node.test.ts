// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { rankReferenceCorrespondences } from './correspondence';
import { encodePng } from './image';
import { DecompositionSession } from './session';
import { makeRepeatedMultiviewFixture } from '../../tests/decomposerSyntheticFixtures';
import type { CorrespondenceRecord, RegionRecord, SourceInput } from './types';

type Color = [number, number, number];
function raster(name: string, paint: (pixel: (x: number, y: number, color: Color) => void, rect: (x0: number, y0: number, x1: number, y1: number, color: Color) => void, disk: (cx: number, cy: number, radius: number, color: Color) => void) => void, role: 'primary' | 'alternate-pose'): SourceInput {
  const width = 72, height = 44, rgba = new Uint8Array(width * height * 4);
  const pixel = (x: number, y: number, color: Color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    rgba.set([...color, 255], (y * width + x) * 4);
  };
  const rect = (x0: number, y0: number, x1: number, y1: number, color: Color) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) pixel(x, y, color);
  };
  const disk = (cx: number, cy: number, radius: number, color: Color) => {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if ((x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 <= radius ** 2) pixel(x, y, color);
  };
  paint(pixel, rect, disk);
  return { bytes: encodePng({ width, height, rgba }), name, mime: 'image/png', role };
}

async function analyze(primaryInput: SourceInput, alternateInput: SourceInput) {
  const session = await DecompositionSession.importSources([primaryInput, alternateInput], { mode: 'appearance' });
  await session.analyze();
  const document = session.snapshot();
  const primary = document.regions.filter(region => region.sourceId === document.sources[0].id);
  const alternate = document.regions.filter(region => region.sourceId === document.sources[1].id);
  return { session, document, primary, alternate };
}

function byColor(regions: RegionRecord[], color: string): RegionRecord {
  const match = regions.find(region => region.color.toLowerCase() === color);
  if (!match) throw new Error(`Missing ${color} region.`);
  return match;
}

describe('multi-reference correspondence ranking', () => {
  it('accepts two obvious reciprocal identities after positions swap, without generating motion', async () => {
    const red: Color = [200, 60, 50], blue: Color = [40, 120, 200];
    const first = raster('front.png', (_, rect, disk) => { disk(16, 22, 8, red); rect(47, 12, 62, 32, blue); }, 'primary');
    const second = raster('pose.png', (_, rect, disk) => { disk(55, 22, 8, red); rect(9, 12, 24, 32, blue); }, 'alternate-pose');
    const { session, document, primary, alternate } = await analyze(first, second);
    const ranked = rankReferenceCorrespondences(primary, alternate, { primarySource: document.sources[0], alternateSource: document.sources[1] });
    expect(ranked.candidates.filter(item => item.accepted)).toHaveLength(2);
    expect(ranked.candidates.filter(item => item.accepted).every(item => item.kind === 'same-part')).toBe(true);
    for (const item of ranked.candidates.filter(item => item.accepted)) {
      const [a, b] = item.regionIds!;
      expect(primary.find(region => region.id === a)?.color).toBe(alternate.find(region => region.id === b)?.color);
      expect(item.evidence.some(text => text.includes('contour'))).toBe(true);
    }
    expect(ranked.candidates.every(item => !item.evidence.some(text => /keyframe|motion|clip/i.test(text)))).toBe(true);
    await session.close();
  });

  it('ranks changed positions by normalized contour when same-color regions have different silhouettes', async () => {
    const red: Color = [190, 75, 65];
    const first = raster('shape-front.png', (_, rect, disk) => { disk(17, 22, 9, red); rect(48, 13, 63, 31, red); }, 'primary');
    const second = raster('shape-pose.png', (_, rect, disk) => { rect(9, 13, 24, 31, red); disk(55, 22, 9, red); }, 'alternate-pose');
    const { session, document, primary, alternate } = await analyze(first, second);
    const ranked = rankReferenceCorrespondences(primary, alternate, { primarySource: document.sources[0], alternateSource: document.sources[1] });
    const bestPerAlternate = ranked.candidates.filter((candidate, index, all) => all.findIndex(item => item.regionIds![1] === candidate.regionIds![1]) === index);
    expect(bestPerAlternate).toHaveLength(2);
    for (const candidate of bestPerAlternate) {
      const [a, b] = candidate.regionIds!;
      const p = primary.find(region => region.id === a)!, q = alternate.find(region => region.id === b)!;
      expect(Math.abs(p.pixelCount - q.pixelCount)).toBe(0);
    }
    await session.close();
  });

  it('keeps repeated identical shapes ambiguous, with explicit manual rejection and acceptance precedence', async () => {
    const pair = makeRepeatedMultiviewFixture();
    const { session, document, primary, alternate } = await analyze(pair.primary.input, pair.alternate.input);
    const initial = rankReferenceCorrespondences(primary, alternate, { primarySource: document.sources[0], alternateSource: document.sources[1] });
    expect(initial.candidates).toHaveLength(4);
    expect(initial.candidates.every(item => item.kind === 'possible-match' && !item.accepted && item.ambiguity)).toBe(true);
    expect(initial.diagnostics.map(item => item.code)).toContain('CORRESPONDENCE_AMBIGUOUS');
    const rejected: CorrespondenceRecord = { ...initial.candidates[0], origin: 'manual', accepted: false };
    const afterRejection = rankReferenceCorrespondences(primary, alternate, { manual: [rejected] });
    expect(afterRejection.candidates.some(item => item.id === rejected.id)).toBe(false);
    expect(afterRejection.candidates.some(item => item.regionIds![1] === rejected.regionIds![1])).toBe(true);
    const accepted: CorrespondenceRecord = { ...initial.candidates[1], origin: 'manual', accepted: true };
    const afterAcceptance = rankReferenceCorrespondences(primary, alternate, { manual: [rejected, accepted] });
    expect(afterAcceptance.candidates.every(item => item.regionIds![0] !== accepted.regionIds![0] && item.regionIds![1] !== accepted.regionIds![1])).toBe(true);
    const reverse = (item: CorrespondenceRecord): CorrespondenceRecord => ({ ...item,
      sourceIds: [item.sourceIds[1], item.sourceIds[0]], regionIds: [item.regionIds![1], item.regionIds![0]] });
    const afterReverse = rankReferenceCorrespondences(primary, alternate, { manual: [reverse(rejected), reverse(accepted)] });
    expect(afterReverse.candidates.map(item => item.id)).toEqual(afterAcceptance.candidates.map(item => item.id));
    await session.close();
  });

  it('does not treat front/back or alignment annotations as identity decisions', async () => {
    const pair = makeRepeatedMultiviewFixture();
    const { session, document, primary, alternate } = await analyze(pair.primary.input, pair.alternate.input);
    try {
      const options = { primarySource: document.sources[0], alternateSource: document.sources[1] };
      const initial = rankReferenceCorrespondences(primary, alternate, options);
      const [first, second] = initial.candidates;
      const annotations: CorrespondenceRecord[] = [
        { ...first, id: 'manual-layer-evidence', kind: 'front-back-evidence', origin: 'manual', accepted: true },
        { ...second, id: 'manual-alignment', kind: 'source-alignment', origin: 'manual', accepted: false },
      ];
      const ranked = rankReferenceCorrespondences(primary, alternate, { ...options, manual: annotations });
      expect(ranked.candidates.map(item => item.id)).toEqual(initial.candidates.map(item => item.id));
      expect(ranked.candidates.every(item => item.kind === 'possible-match' && item.accepted === undefined)).toBe(true);
    } finally { await session.close(); }
  });

  it('does not infer part identity from a detail or mask-guide source role', async () => {
    const red: Color = [200, 60, 50], blue: Color = [40, 120, 200];
    const first = raster('front.png', (_, rect, disk) => { disk(16, 22, 8, red); rect(47, 12, 62, 32, blue); }, 'primary');
    const second = raster('detail.png', (_, rect, disk) => { disk(55, 22, 8, red); rect(9, 12, 24, 32, blue); }, 'alternate-pose');
    const { session, document, primary, alternate } = await analyze(first, second);
    const detail = rankReferenceCorrespondences(primary, alternate, { primarySource: document.sources[0],
      alternateSource: { ...document.sources[1], role: 'detail' } });
    expect(detail.candidates.length).toBeGreaterThanOrEqual(2);
    expect(detail.candidates.every(item => item.kind === 'possible-match' && !item.accepted)).toBe(true);
    const guide = rankReferenceCorrespondences(primary, alternate, { primarySource: document.sources[0],
      alternateSource: { ...document.sources[1], role: 'mask-guide' } });
    expect(guide.candidates).toEqual([]);
    await session.close();
  });

  it('uses a declared source transform to distinguish repeated positions while retaining evidence', async () => {
    const pair = makeRepeatedMultiviewFixture();
    const { session, document, primary, alternate } = await analyze(pair.primary.input, pair.alternate.input);
    const aligned = rankReferenceCorrespondences(primary, alternate, { primarySource: document.sources[0],
      alternateSource: { ...document.sources[1], transformToPrimary: [1, 0, 0, 1, 0, 0] } });
    expect(aligned.candidates.filter(item => item.accepted)).toHaveLength(2);
    expect(aligned.candidates.filter(item => item.accepted).every(item => item.evidence.some(text => text.includes('source-transform')))).toBe(true);
    await session.close();
  });

  it('uses adjacent paint colors and manually accepted neighboring landmarks as ranking evidence', async () => {
    const red: Color = [190, 70, 60], blue: Color = [30, 100, 210], green: Color = [55, 175, 80];
    const first = raster('parts-front.png', (_, rect) => { rect(8, 12, 18, 30, red); rect(18, 14, 24, 28, blue); rect(47, 12, 57, 30, red); rect(57, 14, 63, 28, green); }, 'primary');
    const second = raster('parts-pose.png', (_, rect) => { rect(8, 12, 18, 30, red); rect(18, 14, 24, 28, green); rect(47, 12, 57, 30, red); rect(57, 14, 63, 28, blue); }, 'alternate-pose');
    const { session, document, primary, alternate } = await analyze(first, second);
    const pBlue = byColor(primary, '#1e64d2'), aBlue = byColor(alternate, '#1e64d2');
    const landmark: CorrespondenceRecord = { id: 'manual-blue-landmark', sourceIds: [pBlue.sourceId, aBlue.sourceId], regionIds: [pBlue.id, aBlue.id], kind: 'landmark', origin: 'manual', accepted: true, evidence: ['user-confirmed paint adjacency'],
      landmarkPoints: [{ x: pBlue.bounds.x + pBlue.bounds.width / 2, y: pBlue.bounds.y + pBlue.bounds.height / 2 }, { x: aBlue.bounds.x + aBlue.bounds.width / 2, y: aBlue.bounds.y + aBlue.bounds.height / 2 }] };
    const ranked = rankReferenceCorrespondences(primary, alternate, { primarySource: document.sources[0], alternateSource: document.sources[1], manual: [landmark] });
    const aRedNextToBlue = alternate.find(region => region.color === '#be463c' && region.adjacency.some(edge => edge.regionId === aBlue.id))!;
    const pRedNextToBlue = primary.find(region => region.color === '#be463c' && region.adjacency.some(edge => edge.regionId === pBlue.id))!;
    const best = ranked.candidates.find(item => item.regionIds![1] === aRedNextToBlue.id);
    expect(best?.regionIds![0]).toBe(pRedNextToBlue.id);
    expect(best?.evidence.some(text => text.includes('manual landmark-adjacency support'))).toBe(true);
    expect(ranked.candidates.every(item => item.regionIds![0] !== pBlue.id && item.regionIds![1] !== aBlue.id)).toBe(true);
    await session.close();
  });

  it('uses paired point landmarks without region assignments as bounded evidence for repeated shapes', async () => {
    const pair = makeRepeatedMultiviewFixture();
    const { session, document, primary, alternate } = await analyze(pair.primary.input, pair.alternate.input);
    const [primaryLeft, primaryRight] = [...primary].sort((a, b) => a.bounds.x - b.bounds.x);
    const [alternateLeft, alternateRight] = [...alternate].sort((a, b) => a.bounds.x - b.bounds.x);
    const landmark: CorrespondenceRecord = { id: 'landmark_near_left', kind: 'landmark', origin: 'manual', accepted: true,
      sourceIds: [document.sources[1].id, document.sources[0].id],
      landmarkPoints: [{ x: 9, y: 20 }, { x: 6, y: 20 }], evidence: ['two user-paired points on the background'] };
    const options = { primarySource: document.sources[0], alternateSource: document.sources[1] };
    const ranked = rankReferenceCorrespondences(primary, alternate, { ...options, manual: [landmark] });
    const firstFor = (regionId: string) => ranked.candidates.find(item => item.regionIds?.[1] === regionId);
    expect(firstFor(alternateLeft.id)?.regionIds?.[0]).toBe(primaryLeft.id);
    expect(firstFor(alternateRight.id)?.regionIds?.[0]).toBe(primaryRight.id);
    expect(firstFor(alternateRight.id)?.evidence.some(item => item.includes('point-landmark radial distance'))).toBe(true);
    expect(ranked.candidates.every(item => item.kind === 'possible-match' && item.accepted === undefined)).toBe(true);
    const rejected = rankReferenceCorrespondences(primary, alternate, { ...options, manual: [{ ...landmark, accepted: false }] });
    expect(rejected.candidates.every(item => item.evidence.every(text => !text.includes('point-landmark radial distance')))).toBe(true);
    await session.close();
  });

  it('uses source-pixel contact length to rank repeated regions with identically colored neighbors', async () => {
    const red: Color = [190, 70, 60], blue: Color = [30, 100, 210];
    const first = raster('contact-front.png', (_, rect) => {
      rect(8, 8, 20, 36, red); rect(20, 14, 25, 30, blue);
      rect(43, 8, 55, 36, red); rect(55, 20, 60, 25, blue);
    }, 'primary');
    const second = raster('contact-alternate.png', (_, rect) => {
      rect(8, 8, 20, 36, red); rect(20, 20, 25, 25, blue);
      rect(43, 8, 55, 36, red); rect(55, 14, 60, 30, blue);
    }, 'alternate-pose');
    const { session, document, primary, alternate } = await analyze(first, second);
    const redPrimary = primary.filter(region => region.color === '#be463c').sort((a, b) => a.bounds.x - b.bounds.x);
    const redAlternate = alternate.filter(region => region.color === '#be463c').sort((a, b) => a.bounds.x - b.bounds.x);
    expect(redPrimary).toHaveLength(2);
    expect(redAlternate).toHaveLength(2);
    expect(redPrimary[0].adjacency[0]?.sharedBoundary).toBeGreaterThan(redPrimary[1].adjacency[0]?.sharedBoundary);
    const ranked = rankReferenceCorrespondences(primary, alternate, { primarySource: document.sources[0], alternateSource: document.sources[1] });
    const firstFor = (regionId: string) => ranked.candidates.find(item => item.regionIds?.[1] === regionId);
    expect(firstFor(redAlternate[0].id)?.regionIds?.[0]).toBe(redPrimary[1].id);
    expect(firstFor(redAlternate[1].id)?.regionIds?.[0]).toBe(redPrimary[0].id);
    expect(firstFor(redAlternate[1].id)?.evidence.some(item => item.includes('color/contact distance'))).toBe(true);
    expect(firstFor(redAlternate[1].id)?.ambiguity).toBeTruthy();
    await session.close();
  });
});
