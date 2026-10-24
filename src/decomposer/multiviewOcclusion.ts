import { ALGORITHM_VERSION, fitMaskGeometry } from './analysis';
import { coveredInSourcePose, erodedInterior, stableId } from './hidden';
import type { CorrespondenceRecord, DecompositionDiagnostic, DecompositionDocumentV1, LayerRecord, RegionMask, RegionRecord } from './types';

const MAX_MATCHES = 16;
const MAX_PIXELS_PER_MATCH = 100_000;
const MAX_TOTAL_PIXELS = 500_000;

function contains(region: RegionRecord, mask: RegionMask, x: number, y: number): boolean {
  const dx = x - region.bounds.x, dy = y - region.bounds.y;
  return dx >= 0 && dy >= 0 && dx < mask.width && dy < mask.height && mask.bytes[dy * mask.width + dx] !== 0;
}

/** Reviewable coverage evidence from explicitly matched, aligned stills. Inferred regions remain under the opaque primary foreground. */
export function proposeCrossViewOcclusion(document: DecompositionDocumentV1, masks: ReadonlyMap<string, RegionMask>,
  manual: readonly CorrespondenceRecord[], sourceRgba: Uint8Array, priorLayers: readonly LayerRecord[] = []):
  { regions: RegionRecord[]; masks: Map<string, RegionMask>; layers: LayerRecord[]; diagnostics: DecompositionDiagnostic[] } {
  const regionsProposed: RegionRecord[] = [], inferredMasks = new Map<string, RegionMask>();
  const layers: LayerRecord[] = [], diagnostics: DecompositionDiagnostic[] = [];
  const result = { regions: regionsProposed, masks: inferredMasks, layers, diagnostics };
  if (document.mode !== 'animation-ready') return result;
  const primary = document.sources.find(source => source.role === 'primary');
  if (!primary || sourceRgba.length !== primary.width * primary.height * 4) return result;
  const regions = new Map(document.regions.filter(region => region.generationStatus !== 'historical' && !region.suppressed && region.geometry.status === 'visible')
    .map(region => [region.id, region]));
  const primaryRegions = [...regions.values()].filter(region => region.sourceId === primary.id && region.classification === 'foreground');
  const matches = manual.filter(item => item.origin === 'manual' && item.kind === 'same-part' && item.accepted && item.regionIds);
  let processed = 0, inspected = 0;
  for (const match of matches) {
    if (processed >= MAX_MATCHES || inspected >= MAX_TOTAL_PIXELS) {
      diagnostics.push({ code: 'RESOURCE_LIMIT', severity: 'info', sourceId: primary.id,
        message: 'Aligned cross-reference coverage reached its bounded comparison budget.', suggestion: 'Review the remaining manually matched parts separately.' });
      break;
    }
    const pair = match.regionIds!;
    const first = regions.get(pair[0]), second = regions.get(pair[1]);
    const back = first?.sourceId === primary.id ? first : second?.sourceId === primary.id ? second : undefined;
    const alternate = back === first ? second : first;
    if (!back || !alternate || alternate.sourceId === primary.id || back.classification !== 'foreground') continue;
    const source = document.sources.find(item => item.id === alternate.sourceId), transform = source?.transformToPrimary;
    if (!transform || alternate.pixelCount > MAX_PIXELS_PER_MATCH || inspected + alternate.pixelCount > MAX_TOTAL_PIXELS) continue;
    const altMask = masks.get(alternate.maskId), backMask = masks.get(back.maskId);
    if (!altMask || !backMask) continue;
    inspected += alternate.pixelCount; processed++;
    const candidates = primaryRegions.filter(region => region.id !== back.id)
      .map(region => ({ region, mask: masks.get(region.maskId)! })).filter(item => item.mask);
    let visibleSupport = 0, missing = 0;
    const covered = new Map<string, number>();
    for (let y = 0; y < altMask.height; y++) for (let x = 0; x < altMask.width; x++) {
      if (!altMask.bytes[y * altMask.width + x]) continue;
      const ax = alternate.bounds.x + x + .5, ay = alternate.bounds.y + y + .5;
      const px = Math.floor(transform[0] * ax + transform[2] * ay + transform[4]);
      const py = Math.floor(transform[1] * ax + transform[3] * ay + transform[5]);
      if (px < 0 || py < 0 || px >= primary.width || py >= primary.height) continue;
      if (contains(back, backMask, px, py)) { visibleSupport++; continue; }
      missing++;
      for (const front of candidates) if (contains(front.region, front.mask, px, py))
        covered.set(front.region.id, (covered.get(front.region.id) ?? 0) + 1);
    }
    if (visibleSupport < 16 || visibleSupport < Math.min(back.pixelCount, alternate.pixelCount) * .5 || missing < 9) continue;
    const ranked = [...covered].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const best = ranked[0];
    if (!best || best[1] < 9 || best[1] / missing < .7 || ranked[1] && ranked[1][1] >= best[1] * .8) continue;
    const front = regions.get(best[0])!;
    if (priorLayers.some(layer => layer.origin === 'manual' && layer.status === 'rejected' &&
      (layer.frontRegionId === front.id && layer.backRegionId === back.id || layer.frontRegionId === back.id && layer.backRegionId === front.id))) continue;
    const evidence = [
      `manual identity ${match.id} matches primary ${back.id} to alternate ${alternate.id}`,
      `declared affine alignment maps ${visibleSupport} alternate pixels onto the visible primary region`,
      `${best[1]} of ${missing} aligned pixels absent from the primary region are covered by ${front.id}`,
      'the alternate still may depict a changed pose or view; unseen shape and texture remain unknown',
    ];
    const existing = document.layers.find(layer => layer.frontRegionId === front.id && layer.backRegionId === back.id);
    if (existing?.origin === 'automatic') {
      if (!existing.evidence.some(item => item.startsWith('manual identity '))) existing.evidence.push(...evidence);
    } else if (!existing) layers.push({ id: `crossview_${front.id}_front_${back.id}`, frontRegionId: front.id, backRegionId: back.id,
      origin: 'automatic', status: 'proposed', evidence });
    diagnostics.push({ code: 'OCCLUSION_UNDERCONSTRAINED', severity: 'info', sourceId: primary.id, regionId: back.id,
      message: 'An aligned alternate still supports a possible front/back relation in the primary pose.',
      suggestion: 'Review the mapped coverage and approve or reject the layer relation; unseen surface detail remains uncertain.', evidence });
    if (!document.settings.inferHiddenGeometry || back.holeCount || regionsProposed.length >= 16) continue;
    const frontMask = masks.get(front.maskId)!;
    if (frontMask.alpha && frontMask.alpha.some((value, index) => frontMask.bytes[index] && value !== 255)) continue;
    const interior = erodedInterior(front, frontMask, sourceRgba, primary.width);
    if (!interior) continue;
    const bytes = new Uint8Array(interior.mask.bytes.length);
    for (let y = 0; y < altMask.height; y++) for (let x = 0; x < altMask.width; x++) {
      if (!altMask.bytes[y * altMask.width + x]) continue;
      const ax = alternate.bounds.x + x + .5, ay = alternate.bounds.y + y + .5;
      const px = Math.floor(transform[0] * ax + transform[2] * ay + transform[4]);
      const py = Math.floor(transform[1] * ax + transform[3] * ay + transform[5]);
      if (px < interior.bounds.x || py < interior.bounds.y || px >= interior.bounds.x + interior.bounds.width || py >= interior.bounds.y + interior.bounds.height || contains(back, backMask, px, py)) continue;
      const index = (py - interior.bounds.y) * interior.mask.width + px - interior.bounds.x;
      if (interior.mask.bytes[index]) bytes[index] = 1;
    }
    const count = bytes.reduce((sum, value) => sum + value, 0);
    if (count < 9) continue;
    const mask: RegionMask = { width: interior.mask.width, height: interior.mask.height, bytes };
    const id = stableId(back.id, front.id);
    if (document.regions.some(region => region.id === id) || regionsProposed.some(region => region.id === id)) continue;
    let fitted: ReturnType<typeof fitMaskGeometry>;
    try { fitted = fitMaskGeometry(id, mask, interior.bounds, { ...document.settings, pathTolerance: Math.min(document.settings.pathTolerance, .5) }, 'flat'); }
    catch { continue; }
    if (fitted.holeCount || fitted.geometry.quality.maskIoU < .98) continue;
    const hidden: RegionRecord = {
      id, sourceId: primary.id, maskId: `${id}_mask`, bounds: interior.bounds, pixelCount: count,
      classification: 'foreground', color: back.color, colorVariance: back.colorVariance,
      confidence: { kind: 'heuristic', reasons: [
        `manually matched alternate region ${alternate.id} projects under opaque foreground ${front.id}`,
        'continuation is inset two pixels and cannot change the primary source pose',
        'unseen texture and exact contour remain uncertain; color estimates the visible primary part',
      ] },
      provenance: { algorithmVersion: ALGORITHM_VERSION, settingsFingerprint: back.provenance.settingsFingerprint },
      generationStatus: 'generated', locked: { mask: false, geometry: false, part: false },
      lineage: { parents: [], children: [] }, partId: back.partId,
      geometry: { ...fitted.geometry, status: 'inferred' }, holeCount: 0, adjacency: [],
    };
    if (!coveredInSourcePose(hidden, front, frontMask, sourceRgba, primary.width)) continue;
    regionsProposed.push(hidden); inferredMasks.set(hidden.maskId, mask);
    layers.push({ id: `${id}_layer`, frontRegionId: front.id, backRegionId: hidden.id, origin: 'automatic', status: 'proposed',
      evidence: [...evidence, 'inset inferred contour is fully covered by the opaque primary foreground'] });
    diagnostics.push({ code: 'HIDDEN_GEOMETRY_INFERRED', severity: 'warning', sourceId: primary.id, regionId: hidden.id, bounds: hidden.bounds,
      message: 'An alternate still supports a small hidden continuation under the primary foreground; its shape and color need review.',
      suggestion: 'Inspect, edit or suppress this inferred region before articulation.', evidence });
  }
  return result;
}
