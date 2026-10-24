import { encodePng } from './image';
import type { DecodedImage } from './image';
import type { Box, DecompositionDocumentV1, RegionMask } from './types';

export type DiagnosticTileView = 'source' | 'mask' | 'evidence';
export interface DiagnosticTileRequest {
  view: DiagnosticTileView;
  sourceId?: string;
  regionId?: string;
  /** Exact, unscaled source-pixel rectangle. Required when the default exceeds 512 pixels on either axis. */
  bounds?: Box;
}
export interface DiagnosticTile {
  sourceId: string;
  regionId?: string;
  view: DiagnosticTileView;
  bounds: Box;
  mime: 'image/png';
  bytes: Uint8Array;
}

/** Bounded source evidence for an agent or human; this is not a simulated Hyde render. */
export function renderDiagnosticTile(document: DecompositionDocumentV1, images: ReadonlyMap<string, DecodedImage>,
  masks: ReadonlyMap<string, RegionMask>, request: DiagnosticTileRequest): DiagnosticTile {
  if (!['source', 'mask', 'evidence'].includes(request.view)) throw new Error('INVALID_ARGUMENT: Unknown diagnostic tile view.');
  const region = request.regionId === undefined ? undefined : document.regions.find(item => item.id === request.regionId);
  if (request.regionId !== undefined && !region) throw new Error('TARGET_NOT_FOUND: Diagnostic region does not exist.');
  if (request.view !== 'source' && !region) throw new Error('INVALID_ARGUMENT: Mask and evidence tiles require a region ID.');
  const sourceId = request.sourceId ?? region?.sourceId ?? document.sources.find(item => item.role === 'primary')?.id;
  const source = document.sources.find(item => item.id === sourceId);
  if (!source) throw new Error('TARGET_NOT_FOUND: Diagnostic source does not exist.');
  if (region && region.sourceId !== source.id) throw new Error('INVALID_ARGUMENT: Region belongs to a different source.');
  const image = images.get(source.id);
  if (!image || image.width !== source.width || image.height !== source.height) throw new Error('DECODE_FAILURE: Canonical source pixels are unavailable.');
  const bounds = request.bounds ?? region?.bounds ?? { x: 0, y: 0, width: source.width, height: source.height };
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) || bounds.x < 0 || bounds.y < 0 ||
    bounds.width < 1 || bounds.height < 1 || bounds.width > 512 || bounds.height > 512 ||
    bounds.x + bounds.width > source.width || bounds.y + bounds.height > source.height)
    throw new Error('RESOURCE_LIMIT: Diagnostic tile must be an in-bounds rectangle of at most 512 × 512 source pixels.');
  const mask = region && request.view !== 'source' ? masks.get(region.maskId) : undefined;
  if (region && request.view !== 'source' && (!mask || mask.width !== region.bounds.width || mask.height !== region.bounds.height))
    throw new Error('INVALID_DOCUMENT: Region mask is missing or mismatched.');
  const inside = (x: number, y: number) => {
    const mx = x - region!.bounds.x, my = y - region!.bounds.y;
    return mx >= 0 && my >= 0 && mx < mask!.width && my < mask!.height && mask!.bytes[my * mask!.width + mx] !== 0;
  };
  const output = new Uint8Array(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y++) for (let x = 0; x < bounds.width; x++) {
    const sx = bounds.x + x, sy = bounds.y + y, at = (y * bounds.width + x) * 4;
    if (request.view !== 'mask') output.set(image.rgba.subarray((sy * image.width + sx) * 4, (sy * image.width + sx + 1) * 4), at);
    if (request.view === 'mask' && inside(sx, sy)) {
      const local = (sy - region!.bounds.y) * mask!.width + sx - region!.bounds.x;
      output.set([255, 255, 255, mask!.alpha?.[local] ?? 255], at);
    } else if (request.view === 'evidence' && inside(sx, sy) &&
      (!inside(sx - 1, sy) || !inside(sx + 1, sy) || !inside(sx, sy - 1) || !inside(sx, sy + 1)))
      output.set([255, 38, 38, 255], at);
  }
  return { sourceId: source.id, ...(region ? { regionId: region.id } : {}), view: request.view,
    bounds: { ...bounds }, mime: 'image/png', bytes: encodePng({ width: bounds.width, height: bounds.height, rgba: output }) };
}
