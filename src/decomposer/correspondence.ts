import type { CorrespondenceRecord, DecompositionDiagnostic, Point, RegionRecord, SourceReference } from './types';

export interface CorrespondenceOptions {
  primarySource?: SourceReference;
  alternateSource?: SourceReference;
  /** Existing manual decisions are evidence and always take precedence. */
  manual?: readonly CorrespondenceRecord[];
  maxCandidatesPerRegion?: number;
}

export interface CorrespondenceRanking {
  candidates: CorrespondenceRecord[];
  diagnostics: DecompositionDiagnostic[];
}

const SAMPLES = 32;
const MAX_PAIRS = 20_000;
const MAX_PATH_VERTICES = 4096;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const center = (region: RegionRecord): Point => ({ x: region.bounds.x + region.bounds.width / 2, y: region.bounds.y + region.bounds.height / 2 });
const normalized = (value: number, scale = 1) => clamp01(Math.abs(value) / scale);

function rgb(color: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return [0, 0, 0];
  return [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16)) as [number, number, number];
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / Math.sqrt(3 * 255 * 255);
}

function pathContour(region: RegionRecord): Point[] {
  const path = region.geometry.manualPath ?? region.geometry.generatedPath;
  if (path.points.length < 3 || path.points.length > MAX_PATH_VERTICES) return [];
  const points: Point[] = [];
  for (let index = 0; index < path.points.length; index++) {
    const a = path.points[index], b = path.points[(index + 1) % path.points.length];
    const curved = Boolean(a.out || b.in);
    for (let step = 0; step < (curved ? 8 : 1); step++) {
      const t = step / (curved ? 8 : 1), u = 1 - t;
      const x = curved ? u ** 3 * a.x + 3 * u ** 2 * t * (a.out?.x ?? a.x) + 3 * u * t ** 2 * (b.in?.x ?? b.x) + t ** 3 * b.x : a.x;
      const y = curved ? u ** 3 * a.y + 3 * u ** 2 * t * (a.out?.y ?? a.y) + 3 * u * t ** 2 * (b.in?.y ?? b.y) + t ** 3 * b.y : a.y;
      points.push({ x: x * region.bounds.width, y: y * region.bounds.height });
    }
  }
  return points;
}

/** Uniform contour sampling removes dependence on authored path-point count/start. */
function shapeSignature(region: RegionRecord): Float32Array {
  const contour = pathContour(region), signature = new Float32Array(SAMPLES);
  if (contour.length < 3) return signature;
  const lengths = new Float64Array(contour.length + 1);
  for (let index = 0; index < contour.length; index++) {
    const next = contour[(index + 1) % contour.length];
    lengths[index + 1] = lengths[index] + Math.hypot(contour[index].x - next.x, contour[index].y - next.y);
  }
  const perimeter = lengths[contour.length];
  if (!perimeter) return signature;
  const sampled: Point[] = [];
  let edge = 0;
  for (let index = 0; index < SAMPLES; index++) {
    const distance = perimeter * index / SAMPLES;
    while (edge + 1 < contour.length && lengths[edge + 1] < distance) edge++;
    const span = lengths[edge + 1] - lengths[edge], t = span ? (distance - lengths[edge]) / span : 0;
    const a = contour[edge], b = contour[(edge + 1) % contour.length];
    sampled.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  const cx = sampled.reduce((sum, point) => sum + point.x, 0) / SAMPLES;
  const cy = sampled.reduce((sum, point) => sum + point.y, 0) / SAMPLES;
  let square = 0;
  for (let index = 0; index < SAMPLES; index++) {
    const radius = Math.hypot(sampled[index].x - cx, sampled[index].y - cy);
    signature[index] = radius; square += radius ** 2;
  }
  const scale = Math.sqrt(square / SAMPLES) || 1;
  for (let index = 0; index < SAMPLES; index++) signature[index] /= scale;
  return signature;
}

function shapeDistance(a: Float32Array, b: Float32Array): number {
  let best = Infinity;
  for (const reverse of [false, true]) for (let shift = 0; shift < SAMPLES; shift++) {
    let square = 0;
    for (let index = 0; index < SAMPLES; index++) {
      const other = b[reverse ? (shift - index + SAMPLES) % SAMPLES : (shift + index) % SAMPLES];
      square += (a[index] - other) ** 2;
    }
    best = Math.min(best, Math.sqrt(square / SAMPLES));
  }
  return clamp01(best / .6);
}

interface Descriptor { region: RegionRecord; color: [number, number, number]; shape: Float32Array; neighborColors: [number, number, number][] }

function descriptors(regions: RegionRecord[]): Descriptor[] {
  const byId = new Map(regions.map(region => [region.id, region]));
  return regions.map(region => ({ region, color: rgb(region.color), shape: shapeSignature(region), neighborColors: region.adjacency
    .map(edge => byId.get(edge.regionId)).filter((value): value is RegionRecord => Boolean(value)).map(neighbor => rgb(neighbor.color)) }));
}

function neighborhoodDistance(a: Descriptor, b: Descriptor): number {
  const left = a.neighborColors, right = b.neighborColors;
  if (!left.length && !right.length) return 0;
  if (!left.length || !right.length) return 1;
  const nearest = (from: [number, number, number][], to: [number, number, number][]) => from.reduce((sum, color) => sum + Math.min(...to.map(other => colorDistance(color, other))), 0) / from.length;
  return clamp01(.65 * (nearest(left, right) + nearest(right, left)) / 2 + .35 * Math.abs(left.length - right.length) / Math.max(left.length, right.length));
}

function alignedDistance(primary: RegionRecord, alternate: RegionRecord, primarySource?: SourceReference, alternateSource?: SourceReference): number | undefined {
  const transform = alternateSource?.transformToPrimary;
  if (!transform || !primarySource) return undefined;
  const p = center(primary), q = center(alternate);
  const mapped = { x: transform[0] * q.x + transform[2] * q.y + transform[4], y: transform[1] * q.x + transform[3] * q.y + transform[5] };
  return clamp01(Math.hypot(mapped.x - p.x, mapped.y - p.y) / Math.hypot(primarySource.width, primarySource.height));
}

function anchorEvidence(primary: RegionRecord, alternate: RegionRecord, anchors: Map<string, string>): { supported: number; contradicted: number } {
  let supported = 0, contradicted = 0;
  const primaryNeighbors = new Set(primary.adjacency.map(edge => edge.regionId));
  const alternateNeighbors = new Set(alternate.adjacency.map(edge => edge.regionId));
  for (const [alternateId, primaryId] of anchors) {
    if (alternateId === alternate.id || primaryId === primary.id) continue;
    const a = alternateNeighbors.has(alternateId), b = primaryNeighbors.has(primaryId);
    if (a && b) supported++; else if (a !== b) contradicted++;
  }
  return { supported, contradicted };
}

interface ScoredPair { primary: Descriptor; alternate: Descriptor; score: number; color: number; shape: number; area: number; aspect: number; neighborhood: number; position?: number; anchors: { supported: number; contradicted: number } }

function scorePair(primary: Descriptor, alternate: Descriptor, options: CorrespondenceOptions, anchors: Map<string, string>): ScoredPair {
  const a = primary.region, b = alternate.region;
  const color = colorDistance(primary.color, alternate.color);
  const shape = shapeDistance(primary.shape, alternate.shape);
  const primaryScale = options.primarySource ? options.primarySource.width * options.primarySource.height : 1;
  const alternateScale = options.alternateSource ? options.alternateSource.width * options.alternateSource.height : 1;
  const area = Math.min(normalized(Math.log(Math.max(1, a.pixelCount) / Math.max(1, b.pixelCount)), 1.5),
    normalized(Math.log((Math.max(1, a.pixelCount) / primaryScale) / (Math.max(1, b.pixelCount) / alternateScale)), 1.5));
  const aspect = normalized(Math.log((a.bounds.width / a.bounds.height) / (b.bounds.width / b.bounds.height)), 1.2);
  const neighborhood = neighborhoodDistance(primary, alternate);
  const position = alignedDistance(a, b, options.primarySource, options.alternateSource);
  const anchor = anchorEvidence(a, b, anchors);
  let score = .38 * color + .28 * shape + .12 * area + .08 * aspect + .14 * neighborhood;
  if (position !== undefined) score = .78 * score + .22 * position;
  score = clamp01(score - Math.min(anchor.supported, 2) * .06 + Math.min(anchor.contradicted, 2) * .1);
  return { primary, alternate, score, color, shape, area, aspect, neighborhood, position, anchors: anchor };
}

/**
 * Deterministic region correspondence ranking. A manually accepted pair owns
 * its endpoints; a manually rejected pair is omitted, without erasing other
 * candidates. Scores are heuristic distances, never calibrated probabilities.
 * No pose, keyframe, clip or motion is generated.
 */
export function rankReferenceCorrespondences(primary: RegionRecord[], alternate: RegionRecord[], options: CorrespondenceOptions = {}): CorrespondenceRanking {
  const result: CorrespondenceRanking = { candidates: [], diagnostics: [] };
  if (!primary.length || !alternate.length) return result;
  if (primary.length * alternate.length > MAX_PAIRS) {
    result.diagnostics.push({ code: 'RESOURCE_LIMIT', severity: 'warning', sourceId: alternate[0].sourceId,
      message: 'Automatic correspondence would compare too many fragmented region pairs.', suggestion: 'Group meaningful regions or provide manual matches.' });
    return result;
  }
  const manual = options.manual?.filter(item => item.origin === 'manual' && item.regionIds) ?? [];
  const manualPairs = new Set(manual.map(item => `${item.regionIds![0]}:${item.regionIds![1]}`));
  const acceptedPrimary = new Set<string>(), acceptedAlternate = new Set<string>(), anchors = new Map<string, string>();
  for (const item of manual) if (item.accepted) {
    acceptedPrimary.add(item.regionIds![0]); acceptedAlternate.add(item.regionIds![1]);
    anchors.set(item.regionIds![1], item.regionIds![0]);
  }
  const p = descriptors(primary.filter(region => region.generationStatus !== 'historical' && region.geometry.status === 'visible' && !acceptedPrimary.has(region.id)));
  const a = descriptors(alternate.filter(region => region.generationStatus !== 'historical' && region.geometry.status === 'visible' && !acceptedAlternate.has(region.id)));
  const ranked = new Map<string, ScoredPair[]>(), reciprocal = new Map<string, ScoredPair[]>();
  for (const alt of a) {
    const choices = p.filter(item => !manualPairs.has(`${item.region.id}:${alt.region.id}`)).map(item => scorePair(item, alt, options, anchors))
      .filter(item => item.score <= .75).sort((left, right) => left.score - right.score || left.primary.region.id.localeCompare(right.primary.region.id));
    ranked.set(alt.region.id, choices);
    for (const choice of choices) {
      const others = reciprocal.get(choice.primary.region.id) ?? []; others.push(choice); reciprocal.set(choice.primary.region.id, others);
    }
  }
  for (const choices of reciprocal.values()) choices.sort((left, right) => left.score - right.score || left.alternate.region.id.localeCompare(right.alternate.region.id));
  const limit = Math.max(1, Math.min(5, Math.floor(options.maxCandidatesPerRegion ?? 3)));
  for (const alt of a) {
    const choices = ranked.get(alt.region.id) ?? [];
    if (!choices.length) continue;
    const margin = choices.length > 1 ? choices[1].score - choices[0].score : 1;
    const ambiguous = margin < (options.alternateSource?.transformToPrimary ? .05 : .1);
    if (ambiguous) result.diagnostics.push({ code: 'CORRESPONDENCE_AMBIGUOUS', severity: 'info', sourceId: alt.region.sourceId, regionId: alt.region.id,
      message: 'Several primary regions have similar shape, color and neighborhood evidence for this reference region.', suggestion: 'Inspect the ranked candidates and confirm or reject the intended part correspondence.' });
    for (const [index, item] of choices.slice(0, limit).entries()) {
      const unique = index === 0 && !ambiguous && margin >= (item.position === undefined ? .14 : .05)
        && reciprocal.get(item.primary.region.id)?.[0] === item && item.score <= .12
        && item.color < .08 && item.shape < .16 && item.area < .3 && item.aspect < .3 && item.neighborhood < .35
        && item.anchors.contradicted === 0;
      const evidence = [
        `normalized contour distance ${item.shape.toFixed(3)}`,
        `sRGB color distance ${item.color.toFixed(3)}`,
        `relative area/aspect distances ${item.area.toFixed(3)}/${item.aspect.toFixed(3)}`,
        `adjacent-region color distance ${item.neighborhood.toFixed(3)}`,
      ];
      if (item.position !== undefined) evidence.push(`declared source-transform center distance ${item.position.toFixed(3)}`);
      if (item.anchors.supported || item.anchors.contradicted) evidence.push(`manual landmark-adjacency support/conflict ${item.anchors.supported}/${item.anchors.contradicted}`);
      evidence.push(`combined heuristic distance ${item.score.toFixed(3)}`);
      result.candidates.push({ id: `${alt.region.id}_match_${item.primary.region.id}`, sourceIds: [item.primary.region.sourceId, alt.region.sourceId],
        regionIds: [item.primary.region.id, alt.region.id], kind: unique ? 'same-part' : 'possible-match', origin: 'automatic',
        accepted: unique ? true : undefined, evidence,
        ambiguity: ambiguous ? 'Competing primary regions have similar evidence; identity requires a manual choice.' : undefined });
    }
  }
  return result;
}
