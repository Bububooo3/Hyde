import { HydeAuthoringSession } from '../authoring';
import type { HydeCommand } from '../authoring';
import type { Project, ShapePath } from '../model';
import { decodeAssemblyBytes, decodeProjectBytes } from '../archive';
import { sha256 } from './codec';
import { encodePng } from './image';
import type { DecodedImage } from './image';
import type { DecompositionDiagnostic, DecompositionDocumentV1, HydeExportMapping, PartRecord, RegionMask, RegionRecord } from './types';

export interface HydeDecompositionExportOptions {
  format: 'hyproj' | 'hyde';
  name?: string;
  width?: number;
  height?: number;
  duration?: number;
  /** Explicit fallback only for source holes that exceed native contour fitting limits. */
  allowHoleApproximation?: boolean;
}

export interface HydeDecompositionExport {
  bytes: Uint8Array;
  warnings: DecompositionDiagnostic[];
  mapping: HydeExportMapping;
  project: Project;
}

function activeRegions(document: DecompositionDocumentV1): RegionRecord[] {
  const primary = document.sources.find(source => source.role === 'primary');
  if (!primary) throw new Error('Primary source is missing.');
  return document.regions.filter(region => region.sourceId === primary.id && region.generationStatus !== 'historical' && !region.suppressed);
}
function regionPath(region: RegionRecord): ShapePath { return region.geometry.manualPath ?? region.geometry.generatedPath; }

function cropTexture(region: RegionRecord, mask: RegionMask, image: DecodedImage): Uint8Array {
  const { bounds } = region;
  const rgba = new Uint8Array(bounds.width * bounds.height * 4);
  const sourceColor = region.geometry.texture === 'source-crop';
  const flat = [1, 3, 5].map(at => parseInt(region.color.slice(at, at + 2), 16));
  for (let y = 0; y < bounds.height; y++) for (let x = 0; x < bounds.width; x++) {
    const source = ((bounds.y + y) * image.width + bounds.x + x) * 4, target = (y * bounds.width + x) * 4;
    const useSourceColor = sourceColor && image.rgba[source + 3] > 0;
    rgba[target] = useSourceColor ? image.rgba[source] : flat[0];
    rgba[target + 1] = useSourceColor ? image.rgba[source + 1] : flat[1];
    rgba[target + 2] = useSourceColor ? image.rgba[source + 2] : flat[2];
    const pixel = y * bounds.width + x;
    const sourceAlpha = image.rgba[source + 3];
    // A manual brush may deliberately extend an editable region into a source
    // pixel with zero alpha. Use its part color and authored mask coverage there.
    const baseAlpha = sourceAlpha === 0 ? 255 : sourceAlpha;
    rgba[target + 3] = mask.bytes[pixel] ? Math.round(baseAlpha * (mask.alpha?.[pixel] ?? 255) / 255) : 0;
  }
  return encodePng({ width: bounds.width, height: bounds.height, rgba });
}

function validateGraphs(document: DecompositionDocumentV1, regions: RegionRecord[]): void {
  const parts = new Map(document.parts.map(part => [part.id, part]));
  const byRegion = new Map(regions.map(region => [region.id, region]));
  for (const part of document.parts) {
    const seen = new Set([part.id]); let parent = part.parentId;
    while (parent) { if (seen.has(parent)) throw new Error('PART_PARENT_CYCLE'); seen.add(parent); parent = parts.get(parent)?.parentId; }
    if (part.attachment && !part.parentId) throw new Error('INVALID_JOINT_LIMIT: Attachment needs a parent part.');
    if (part.attachment?.min !== undefined && part.attachment.max !== undefined && part.attachment.min > part.attachment.max) throw new Error('INVALID_JOINT_LIMIT');
  }
  const edges = new Map<string, string[]>();
  for (const layer of document.layers.filter(item => item.status === 'approved')) {
    if (!byRegion.has(layer.frontRegionId) || !byRegion.has(layer.backRegionId)) continue;
    const list = edges.get(layer.frontRegionId) ?? []; list.push(layer.backRegionId); edges.set(layer.frontRegionId, list);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function walk(id: string) {
    if (visiting.has(id)) throw new Error('LAYER_CONFLICT: Approved front/back relations form a cycle.');
    if (visited.has(id)) return;
    visiting.add(id); for (const next of edges.get(id) ?? []) walk(next);
    visiting.delete(id); visited.add(id);
  }
  for (const id of edges.keys()) walk(id);
}

function orderedRegions(document: DecompositionDocumentV1, regions: RegionRecord[], warnings: DecompositionDiagnostic[]): RegionRecord[] {
  const partById = new Map(document.parts.map(part => [part.id, part]));
  const base = regions.slice().sort((a, b) => (partById.get(a.partId ?? '')?.zOrder ?? 0) - (partById.get(b.partId ?? '')?.zOrder ?? 0) || a.id.localeCompare(b.id));
  const rank = new Map(base.map((region, index) => [region.id, index]));
  const byId = new Map(base.map(region => [region.id, region]));
  const sort = (includeProposals: boolean): RegionRecord[] | null => {
    const frontByBack = new Map<string, Set<string>>(), indegree = new Map(base.map(region => [region.id, 0]));
    for (const layer of document.layers) {
      if (layer.status === 'conflict' || layer.status === 'rejected' || !includeProposals && layer.status !== 'approved' || !byId.has(layer.frontRegionId) || !byId.has(layer.backRegionId)) continue;
      const fronts = frontByBack.get(layer.backRegionId) ?? new Set<string>();
      if (!fronts.has(layer.frontRegionId)) { fronts.add(layer.frontRegionId); indegree.set(layer.frontRegionId, (indegree.get(layer.frontRegionId) ?? 0) + 1); }
      frontByBack.set(layer.backRegionId, fronts);
    }
    const ready = base.filter(region => indegree.get(region.id) === 0), result: RegionRecord[] = [];
    while (ready.length) {
      ready.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
      const item = ready.shift()!; result.push(item);
      for (const front of frontByBack.get(item.id) ?? []) {
        indegree.set(front, indegree.get(front)! - 1);
        if (indegree.get(front) === 0) ready.push(byId.get(front)!);
      }
    }
    return result.length === base.length ? result : null;
  };
  const withProposals = sort(true);
  if (withProposals) return withProposals;
  warnings.push({ code: 'LAYER_CONFLICT', severity: 'warning', message: 'Automatic layer proposals conflict; native export uses only approved relations.', suggestion: 'Review front/back relationships in the decomposition document.' });
  return sort(false) ?? base;
}

/** The only native conversion path is a typed SDK transaction and canonical export. */
export async function exportNativeDecomposition(document: DecompositionDocumentV1, masks: Map<string, RegionMask>, images: Map<string, DecodedImage>, options: HydeDecompositionExportOptions): Promise<HydeDecompositionExport> {
  const primary = document.sources.find(source => source.role === 'primary');
  if (!primary) throw new Error('No primary reference exists.');
  const image = images.get(primary.id);
  if (!image) throw new Error('Primary source pixels are unavailable.');
  const regions = activeRegions(document), activeIds = new Set(regions.map(region => region.id));
  if (!regions.length) throw new Error('INSUFFICIENT_STRUCTURE: No editable foreground regions exist.');
  if (regions.length > 300 && regions.filter(region => region.pixelCount < document.settings.minRegionPixels).length / regions.length >= .7)
    throw new Error('INSUFFICIENT_STRUCTURE: Native export would consist mostly of tiny fragments; crop the source or merge meaningful regions first.');
  validateGraphs(document, regions);
  const warnings: DecompositionDiagnostic[] = [];
  for (const region of regions) {
    const path = regionPath(region), represented = path.holes?.length ?? 0;
    if (represented < region.holeCount && !options.allowHoleApproximation)
      throw new Error(`HOLE_NOT_REPRESENTABLE: Region ${region.id} has ${region.holeCount - represented} source hole(s) without editable native contours; approve raster-alpha fallback explicitly.`);
    if (represented < region.holeCount) warnings.push({ code: 'HOLE_NOT_REPRESENTABLE', severity: 'warning', regionId: region.id, bounds: region.bounds,
      message: `${region.holeCount - represented} interior source hole(s) remain raster-alpha approximations; ${represented} are editable Hyde contours.` });
    if (region.geometry.status === 'inferred') warnings.push({ code: 'HIDDEN_GEOMETRY_INFERRED', severity: 'warning', regionId: region.id, bounds: region.bounds, message: 'This editable geometry includes an inferred hidden area.' });
    if (path.points.length > 4096 || represented > 64 || path.holes?.some(hole => hole.points.length > 4096) ||
      path.points.length + (path.holes?.reduce((sum, hole) => sum + hole.points.length, 0) ?? 0) > 16384)
      throw new Error(`PATH_TOO_COMPLEX: Region ${region.id} exceeds Hyde's contour limit.`);
  }
  const projectName = options.name ?? document.name;
  const sdk = HydeAuthoringSession.create(projectName);
  const width = options.width ?? primary.width, height = options.height ?? primary.height;
  const duration = options.duration ?? 8;
  const commands: HydeCommand[] = [
    { op: 'project.updateMetadata', args: { name: projectName, width, height, duration, background: 'transparent' } },
    { op: 'scene.retime', args: { id: sdk.snapshot().sequences[0].id, duration } },
  ];
  const rootId = `hc_${document.id}_root`;
  commands.push({ op: 'element.create', args: { id: rootId, kind: 'group', properties: { name: `${projectName} assembly`, x: 0, y: 0, width: 0, height: 0, pivotX: 0, pivotY: 0, fill: 'transparent', start: 0, duration } } });
  const partIds: Record<string, string> = {}, regionIds: Record<string, string> = {}, geometryIds: Record<string, string> = {};
  const parts: PartRecord[] = document.parts.filter(part => part.regionIds.some(id => activeIds.has(id)));
  for (const part of parts) {
    const id = `hc_${part.id}`; partIds[part.id] = id;
    commands.push({ op: 'element.create', args: { id, kind: 'group', properties: { name: part.name, x: part.pivot.x, y: part.pivot.y, width: 0, height: 0, pivotX: 0, pivotY: 0, fill: 'transparent', start: 0, duration } } });
  }
  const partById = new Map(parts.map(part => [part.id, part]));
  for (const part of parts) {
    const parentId = part.parentId && partIds[part.parentId] ? partIds[part.parentId] : rootId;
    const attachment = part.attachmentApproved && part.attachment ? part.attachment : { type: 'fixed' as const };
    commands.push({ op: 'assembly.attach', args: { id: partIds[part.id], parentId, type: attachment.type, min: attachment.min, max: attachment.max, preserveWorldPose: Boolean(part.parentId && partById.has(part.parentId)), timeSeconds: 0 } });
  }
  const ordered = orderedRegions(document, regions, warnings);
  for (const region of ordered) {
    const mask = masks.get(region.maskId);
    if (!mask) throw new Error(`Region ${region.id} mask is missing.`);
    const id = `hc_${region.id}`; regionIds[region.id] = id; geometryIds[region.geometry.id] = id;
    const part = partById.get(region.partId ?? '');
    const texture = region.geometry.texture === 'source-crop' || region.holeCount > (regionPath(region).holes?.length ?? 0) || Boolean(mask.alpha);
    let assetId: string | undefined;
    if (texture) {
      const bytes = cropTexture(region, mask, image);
      const handle = sdk.stageAsset(bytes, 'image/png', 'image');
      assetId = `hc_${region.id}_texture`;
      commands.push({ op: 'asset.add', args: { id: assetId, name: `${region.id} texture.png`, handle } });
      warnings.push({ code: 'TEXTURE_APPROXIMATION', severity: 'info', regionId: region.id, bounds: region.bounds,
        message: mask.alpha ? 'Editable soft-mask coverage is stored as texture alpha inside a Hyde path.' : 'Authentic source pixels are retained inside an editable Hyde path.' });
    }
    const { bounds } = region;
    commands.push({ op: 'element.create', args: { id, kind: 'polygon', properties: {
      name: `${part?.name ?? region.id} · region`, x: bounds.x + bounds.width / 2 - (part?.pivot.x ?? 0), y: bounds.y + bounds.height / 2 - (part?.pivot.y ?? 0),
      width: bounds.width, height: bounds.height, pivotX: .5, pivotY: .5,
      fill: texture ? 'transparent' : region.color, stroke: 'transparent', strokeWidth: 0, assetId, start: 0, duration,
    } } });
    commands.push({ op: 'shape.setPath', args: { id, path: regionPath(region) } });
    commands.push({ op: 'assembly.attach', args: { id, parentId: part ? partIds[part.id] : rootId, type: 'fixed' } });
  }
  const dry = await sdk.execute({ protocolVersion: 1, expectedRevision: 0, commands, dryRun: true });
  if (!dry.ok) throw new Error(`EXPORT_VALIDATION_FAILED: ${dry.errors.map(item => item.message).join('; ')}`);
  const commit = await sdk.execute({ protocolVersion: 1, expectedRevision: 0, commands });
  if (!commit.ok) throw new Error(`EXPORT_VALIDATION_FAILED: ${commit.errors.map(item => item.message).join('; ')}`);
  const bytes = options.format === 'hyproj' ? sdk.exportAssembly(rootId, 0) : sdk.exportProject();
  // Read through the native codec as an extra adapter boundary check.
  if (options.format === 'hyproj') decodeAssemblyBytes(bytes); else decodeProjectBytes(bytes);
  const sourceSnapshot = structuredClone(document);
  delete sourceSnapshot.exportMapping;
  const maskHashes = [];
  for (const [id, mask] of [...masks].sort(([a], [b]) => a.localeCompare(b)))
    maskHashes.push([id, await sha256(mask.bytes), mask.alpha ? await sha256(mask.alpha) : null]);
  const sourceFingerprint = await sha256(new TextEncoder().encode(JSON.stringify({ document: sourceSnapshot, maskHashes })));
  const mapping: HydeExportMapping = {
    sdkVersion: sdk.capabilities().sdkVersion, nativeSchemaVersion: 1, format: options.format,
    partIds, regionIds, geometryIds,
    options: { name: projectName, width, height, duration, allowHoleApproximation: Boolean(options.allowHoleApproximation) },
    warnings: warnings.map(item => item.code), sourceFingerprint, outputFingerprint: await sha256(bytes),
  };
  return { bytes, warnings, mapping, project: sdk.snapshot() };
}
