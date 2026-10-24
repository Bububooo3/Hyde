import type { DecompositionDiagnostic, DecompositionDocumentV1, LayerRecord, RegionMask, RegionRecord } from './types';

export interface JunctionLayerProposals { layers: LayerRecord[]; diagnostics: DecompositionDiagnostic[] }

interface ContactRun { first: number; second: number; start: number; end: number; horizontal: boolean; fixed: number }
interface DirectedEvidence { front: number; back: number; run: ContactRun; stemDepth: number }

/**
 * A T-junction is suggested when a contiguous paint boundary ends against a
 * second region that continues on both sides. This is only a layer proposal:
 * contact in one flat view cannot establish the hidden contour or a joint.
 */
export function proposeJunctionLayers(document: DecompositionDocumentV1, masks: ReadonlyMap<string, RegionMask>, sourceId?: string): JunctionLayerProposals {
  const result: JunctionLayerProposals = { layers: [], diagnostics: [] };
  const source = sourceId ? document.sources.find(item => item.id === sourceId) : document.sources.find(item => item.role === 'primary');
  if (!source || source.role === 'mask-guide') return result;
  const regions = document.regions.filter(region => region.sourceId === source.id && region.generationStatus !== 'historical' && region.geometry.status === 'visible' && !region.suppressed)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (regions.length > 512) return result;
  const { width, height } = source;
  const owner = new Int32Array(width * height); owner.fill(-1);
  let overlaps = false;
  for (let id = 0; id < regions.length; id++) {
    const region = regions[id], mask = masks.get(region.maskId);
    if (!mask || mask.width !== region.bounds.width || mask.height !== region.bounds.height) return result;
    if (region.bounds.x < 0 || region.bounds.y < 0 || region.bounds.x + mask.width > width || region.bounds.y + mask.height > height) return result;
    for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
      if (!mask.bytes[y * mask.width + x]) continue;
      const index = (region.bounds.y + y) * width + region.bounds.x + x;
      if (index < 0 || index >= owner.length || owner[index] >= 0) { overlaps = true; continue; }
      owner[index] = id;
    }
  }
  if (overlaps) {
    result.diagnostics.push({ code: 'LAYER_CONFLICT', severity: 'info', sourceId: source.id,
      message: 'Visible masks overlap; automatic T-junction ordering is skipped.', suggestion: 'Review manual masks and front/back relations.' });
    return result;
  }
  const known = new Map<string, LayerRecord>();
  for (const layer of document.layers) if (layer.status !== 'conflict') known.set(`${layer.frontRegionId}:${layer.backRegionId}`, layer);
  const evidence = new Map<string, DirectedEvidence[]>();
  const contact = (run: ContactRun, sample: (at: number, side: 0 | 1) => number) => {
    if (run.end - run.start + 1 < 4 || run.start < 2) return;
    const tangentLength = run.horizontal ? width : height;
    if (run.end + 2 >= tangentLength) return;
    const extendsBoth = (id: number, side: 0 | 1) => sample(run.start - 1, side) === id && sample(run.start - 2, side) === id
      && sample(run.end + 1, side) === id && sample(run.end + 2, side) === id;
    const firstBar = extendsBoth(run.first, 0), secondBar = extendsBoth(run.second, 1);
    if (firstBar === secondBar) return;
    const front = firstBar ? run.first : run.second, back = firstBar ? run.second : run.first;
    const midpoint = Math.floor((run.start + run.end) / 2);
    const depth = (id: number, positive: boolean) => {
      let count = 0;
      for (let step = 1; step <= 4; step++) {
        const x = run.horizontal ? midpoint : run.fixed + (positive ? step : -step + 1);
        const y = run.horizontal ? run.fixed + (positive ? step : -step + 1) : midpoint;
        if (x < 0 || y < 0 || x >= width || y >= height || owner[y * width + x] !== id) break;
        count++;
      }
      return count;
    };
    const stemDepth = depth(back, back === run.second);
    if (stemDepth < 3) return;
    const [a, b] = front < back ? [front, back] : [back, front];
    const key = `${a}:${b}`, list = evidence.get(key) ?? [];
    list.push({ front, back, run, stemDepth }); evidence.set(key, list);
  };
  for (let y = 0; y < height - 1; y++) {
    const sample = (x: number, side: 0 | 1) => owner[(y + side) * width + x];
    for (let x = 0; x < width;) {
      const first = sample(x, 0), second = sample(x, 1);
      if (first < 0 || second < 0 || first === second) { x++; continue; }
      const start = x;
      while (x + 1 < width && sample(x + 1, 0) === first && sample(x + 1, 1) === second) x++;
      contact({ first, second, start, end: x, horizontal: true, fixed: y }, sample);
      x++;
    }
  }
  for (let x = 0; x < width - 1; x++) {
    const sample = (y: number, side: 0 | 1) => owner[y * width + x + side];
    for (let y = 0; y < height;) {
      const first = sample(y, 0), second = sample(y, 1);
      if (first < 0 || second < 0 || first === second) { y++; continue; }
      const start = y;
      while (y + 1 < height && sample(y + 1, 0) === first && sample(y + 1, 1) === second) y++;
      contact({ first, second, start, end: y, horizontal: false, fixed: x }, sample);
      y++;
    }
  }
  for (const runs of evidence.values()) {
    const directions = new Set(runs.map(run => `${run.front}:${run.back}`));
    if (directions.size > 1) {
      result.diagnostics.push({ code: 'LAYER_CONFLICT', severity: 'info', sourceId: source.id,
        message: 'Opposing T-junctions suggest conflicting layer directions.', suggestion: 'Set this front/back relationship manually after inspecting the source.' });
      continue;
    }
    const best = runs.sort((a, b) => (b.run.end - b.run.start) - (a.run.end - a.run.start) || a.run.fixed - b.run.fixed || a.run.start - b.run.start)[0];
    const front = regions[best.front], back = regions[best.back];
    if (known.has(`${front.id}:${back.id}`)) continue;
    if (known.has(`${back.id}:${front.id}`)) {
      result.diagnostics.push({ code: 'LAYER_CONFLICT', severity: 'info', sourceId: source.id, regionId: front.id,
        message: 'A T-junction conflicts with another front/back proposal.', suggestion: 'Review both layer directions before approving either.' });
      continue;
    }
    const boundary = best.run.horizontal ? 'horizontal' : 'vertical';
    const explanation = `${front.id} extends along both ends of a ${best.run.end - best.run.start + 1}-pixel ${boundary} contact; ${back.id} continues ${best.stemDepth} pixels away from it`;
    result.layers.push({ id: `${front.id}_front_${back.id}`, frontRegionId: front.id, backRegionId: back.id, origin: 'automatic', status: 'proposed',
      evidence: ['source-mask T-junction, not a proven physical overlap', explanation] });
    result.diagnostics.push({ code: 'OCCLUSION_UNDERCONSTRAINED', severity: 'info', sourceId: source.id, regionId: back.id, bounds: back.bounds,
      message: 'A visible T-junction suggests a front/back order, but gives no reliable hidden contour or attachment.',
      suggestion: 'Inspect the proposed order and add a manual hidden continuation only if needed.', evidence: [explanation] });
  }
  return result;
}
