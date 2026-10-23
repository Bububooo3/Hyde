import { unzipSync, zipSync } from 'fflate';
import type { DecompositionDocumentV1, RegionMask } from './types';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_MEMBER_BYTES = 128 * 1024 * 1024;
const MAX_MEMBERS = 20_000;
const safeId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function validateDecompositionDocument(document: unknown, sourceBytes?: Map<string, Uint8Array>, masks?: Map<string, RegionMask>, pixels?: Map<string, Uint8Array>): asserts document is DecompositionDocumentV1 {
  if (!record(document) || document.format !== 'hyde-decomposition' || document.schemaVersion !== 1) throw new Error('DOCUMENT_VERSION_UNSUPPORTED');
  if (!safeId(String(document.id)) || typeof document.name !== 'string' || !['appearance', 'animation-ready'].includes(String(document.mode)) || !record(document.settings)) throw new Error('Invalid decomposition metadata.');
  const settings = document.settings;
  for (const key of ['colorStep', 'alphaThreshold', 'minRegionPixels', 'pathTolerance', 'maxPathPoints', 'groupingStrength']) if (typeof settings[key] !== 'number' || !Number.isFinite(settings[key])) throw new Error(`Invalid setting ${key}.`);
  if (Number(settings.colorStep) < 1 || Number(settings.colorStep) > 128 || Number(settings.alphaThreshold) < 0 || Number(settings.alphaThreshold) > 255 || Number(settings.minRegionPixels) < 1 || Number(settings.minRegionPixels) > 100_000 || Number(settings.pathTolerance) < 0 || Number(settings.pathTolerance) > 32 || Number(settings.maxPathPoints) < 3 || Number(settings.maxPathPoints) > 4096 || Number(settings.groupingStrength) < 0 || Number(settings.groupingStrength) > 1) throw new Error('Reconstruction settings are outside safe bounds.');
  if (typeof settings.preserveTexture !== 'boolean' || typeof settings.inferHiddenGeometry !== 'boolean') throw new Error('Invalid reconstruction switches.');
  if (!Array.isArray(document.sources) || !Array.isArray(document.regions) || !Array.isArray(document.parts) || !Array.isArray(document.layers) || !Array.isArray(document.correspondences) || !Array.isArray(document.history) || !Array.isArray(document.diagnostics)) throw new Error('Decomposition arrays are missing.');
  if (document.sources.length > 32 || document.regions.length > 20_000 || document.parts.length > 20_000 || document.layers.length > 100_000) throw new Error('RESOURCE_LIMIT');
  const sourceIds = new Set<string>(), regionIds = new Set<string>(), partIds = new Set<string>(), maskIds = new Set<string>();
  for (const item of document.sources) {
    if (!record(item) || !safeId(String(item.id)) || sourceIds.has(String(item.id)) || !['primary', 'alternate-view', 'alternate-pose', 'detail', 'mask-guide'].includes(String(item.role)) || !['image/png', 'image/jpeg', 'image/webp'].includes(String(item.mime)) || !Number.isInteger(item.width) || !Number.isInteger(item.height) || Number(item.width) * Number(item.height) > 4_000_000 || typeof item.byteHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.byteHash) || typeof item.pixelHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.pixelHash) || !Number.isInteger(item.byteLength) || Number(item.byteLength) <= 0) throw new Error('Invalid source metadata.');
    sourceIds.add(String(item.id));
    if (sourceBytes && (!sourceBytes.has(String(item.id)) || sourceBytes.get(String(item.id))!.length !== item.byteLength)) throw new Error('Source bytes are missing or the wrong size.');
    if (pixels && (!pixels.has(String(item.id)) || pixels.get(String(item.id))!.length !== Number(item.width) * Number(item.height) * 4)) throw new Error('Canonical source pixels are missing or the wrong size.');
  }
  if (document.sources.length && document.sources.filter(item => item.role === 'primary').length !== 1) throw new Error('Exactly one primary source is required.');
  for (const item of document.regions) {
    if (!record(item) || !safeId(String(item.id)) || regionIds.has(String(item.id)) || !sourceIds.has(String(item.sourceId)) || !safeId(String(item.maskId)) || maskIds.has(String(item.maskId)) || !record(item.bounds) || !Number.isInteger(item.bounds.width) || !Number.isInteger(item.bounds.height) || Number(item.bounds.width) < 1 || Number(item.bounds.height) < 1 || !record(item.geometry)) throw new Error('Invalid region metadata.');
    regionIds.add(String(item.id)); maskIds.add(String(item.maskId));
    const source = document.sources.find(source => source.id === item.sourceId)!;
    if (!Number.isInteger(item.bounds.x) || !Number.isInteger(item.bounds.y) || Number(item.bounds.x) < 0 || Number(item.bounds.y) < 0 || Number(item.bounds.x) + Number(item.bounds.width) > source.width || Number(item.bounds.y) + Number(item.bounds.height) > source.height) throw new Error('Region bounds exceed the source image.');
    if (masks) {
      const mask = masks.get(String(item.maskId));
      if (!mask || mask.width !== item.bounds.width || mask.height !== item.bounds.height || mask.bytes.length !== mask.width * mask.height || mask.bytes.some(byte => byte !== 0 && byte !== 1)) throw new Error('Region mask is missing, malformed or the wrong size.');
      if (item.originalMaskId !== undefined && !masks.has(String(item.originalMaskId))) throw new Error('Original region mask evidence is missing.');
    }
    for (const path of [(item.geometry as Record<string, unknown>).generatedPath, (item.geometry as Record<string, unknown>).manualPath].filter(value => value !== undefined))
      if (!record(path) || !Array.isArray(path.points) || path.points.length < 3 || path.points.length > 4096 || path.points.some(point => !record(point) || typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new Error('Invalid region geometry.');
  }
  for (const item of document.parts) {
    if (!record(item) || !safeId(String(item.id)) || partIds.has(String(item.id)) || !Array.isArray(item.regionIds) || !record(item.pivot) || typeof item.pivot.x !== 'number' || typeof item.pivot.y !== 'number') throw new Error('Invalid part metadata.');
    partIds.add(String(item.id));
  }
  for (const item of document.regions) if (item.partId !== undefined && !partIds.has(item.partId)) throw new Error('Region has a missing part.');
  for (const item of document.parts) {
    for (const id of item.regionIds as string[]) if (!regionIds.has(id)) throw new Error('Part has a missing region.');
    if (item.parentId !== undefined && !partIds.has(item.parentId)) throw new Error('Part has a missing parent.');
    const seen = new Set<string>(); let parent = item.parentId;
    while (parent) {
      if (seen.has(parent) || parent === item.id) throw new Error('PART_PARENT_CYCLE');
      seen.add(parent); parent = document.parts.find(other => other.id === parent)?.parentId;
    }
    if (item.attachment && (!['fixed', 'hinge', 'slider'].includes(item.attachment.type) || !item.parentId || item.attachment.min !== undefined && !Number.isFinite(item.attachment.min) || item.attachment.max !== undefined && !Number.isFinite(item.attachment.max) || item.attachment.min !== undefined && item.attachment.max !== undefined && item.attachment.min > item.attachment.max)) throw new Error('INVALID_JOINT_LIMIT');
  }
  for (const item of document.layers) if (!regionIds.has(item.frontRegionId) || !regionIds.has(item.backRegionId)) throw new Error('Layer relation has a missing region.');
  const approved = new Map<string, string[]>();
  for (const item of document.layers.filter(item => item.status === 'approved')) {
    const neighbors = approved.get(item.frontRegionId) ?? []; neighbors.push(item.backRegionId); approved.set(item.frontRegionId, neighbors);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function walk(id: string): void {
    if (visiting.has(id)) throw new Error('LAYER_CONFLICT');
    if (visited.has(id)) return;
    visiting.add(id); for (const next of approved.get(id) ?? []) walk(next);
    visiting.delete(id); visited.add(id);
  }
  for (const id of approved.keys()) walk(id);
  const correspondenceIds = new Set<string>();
  for (const item of document.correspondences) {
    if (!record(item) || !safeId(String(item.id)) || correspondenceIds.has(String(item.id)) || !Array.isArray(item.sourceIds) || item.sourceIds.length !== 2 || item.sourceIds.some((id: string) => !sourceIds.has(id)) || item.regionIds !== undefined && (!Array.isArray(item.regionIds) || item.regionIds.length !== 2 || item.regionIds.some((id: string) => !regionIds.has(id))) || item.partIds !== undefined && (!Array.isArray(item.partIds) || item.partIds.length !== 2 || item.partIds.some((id: string) => !partIds.has(id)))) throw new Error('Correspondence has an invalid or missing reference.');
    correspondenceIds.add(String(item.id));
  }
}

interface Manifest {
  format: 'hydecomp-archive';
  version: 1;
  members: Record<string, { size: number; sha256: string; width?: number; height?: number }>;
}

export async function encodeDecompositionDocument(document: DecompositionDocumentV1, sourceBytes: Map<string, Uint8Array>, masks: Map<string, RegionMask>, pixels: Map<string, Uint8Array>): Promise<Uint8Array> {
  validateDecompositionDocument(document, sourceBytes, masks, pixels);
  const entries: Record<string, Uint8Array> = { 'document.json': encoder.encode(JSON.stringify(document)) };
  for (const source of document.sources) {
    const bytes = sourceBytes.get(source.id)!;
    if (await sha256(bytes) !== source.byteHash) throw new Error(`Source ${source.id} hash mismatch.`);
    entries[`references/${source.id}`] = bytes;
    const rgba = pixels.get(source.id)!;
    if (await sha256(rgba) !== source.pixelHash) throw new Error(`Canonical pixels for ${source.id} hash mismatch.`);
    entries[`pixels/${source.id}`] = rgba;
  }
  for (const [id, mask] of masks) {
    if (!safeId(id) || mask.bytes.length !== mask.width * mask.height) throw new Error('Invalid stored mask.');
    entries[`masks/${id}`] = mask.bytes;
  }
  const manifest: Manifest = { format: 'hydecomp-archive', version: 1, members: {} };
  for (const [name, bytes] of Object.entries(entries)) {
    if (bytes.length > MAX_MEMBER_BYTES) throw new Error('RESOURCE_LIMIT');
    const mask = name.startsWith('masks/') ? masks.get(name.slice('masks/'.length)) : undefined;
    manifest.members[name] = { size: bytes.length, sha256: await sha256(bytes), ...(mask ? { width: mask.width, height: mask.height } : {}) };
  }
  entries['manifest.json'] = encoder.encode(JSON.stringify(manifest));
  const archive = zipSync(entries, { level: 6, mtime: new Date('1980-01-02T00:00:00Z') });
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('RESOURCE_LIMIT');
  return archive;
}

export async function decodeDecompositionDocument(bytes: Uint8Array): Promise<{ document: DecompositionDocumentV1; sourceBytes: Map<string, Uint8Array>; masks: Map<string, RegionMask>; pixels: Map<string, Uint8Array> }> {
  if (!bytes.length || bytes.length > MAX_ARCHIVE_BYTES) throw new Error('RESOURCE_LIMIT');
  let declaredTotal = 0, declaredCount = 0;
  const seenNames = new Set<string>();
  const entries = unzipSync(bytes, { filter: file => {
    declaredTotal += file.originalSize; declaredCount++;
    if (file.originalSize > MAX_MEMBER_BYTES || declaredTotal > 512 * 1024 * 1024 || declaredTotal > Math.max(128 * 1024 * 1024, bytes.length * 500) || declaredCount > MAX_MEMBERS || seenNames.has(file.name) || file.name.includes('..') || file.name.startsWith('/') || file.name.includes('\\')) throw new Error('Unsafe decomposition archive member.');
    seenNames.add(file.name);
    return true;
  } });
  const names = Object.keys(entries);
  if (names.length > MAX_MEMBERS || names.some(name => name.includes('..') || name.startsWith('/') || name.includes('\\') || entries[name].length > MAX_MEMBER_BYTES)) throw new Error('Unsafe decomposition archive.');
  if (!entries['manifest.json'] || !entries['document.json']) throw new Error('Decomposition archive is missing its manifest or document.');
  const manifest: unknown = JSON.parse(decoder.decode(entries['manifest.json']));
  if (!record(manifest) || manifest.format !== 'hydecomp-archive' || manifest.version !== 1 || !record(manifest.members)) throw new Error('DOCUMENT_VERSION_UNSUPPORTED');
  if (names.length !== Object.keys(manifest.members).length + 1) throw new Error('Archive has undeclared members.');
  for (const [name, descriptor] of Object.entries(manifest.members)) {
    if (!record(descriptor) || !entries[name] || descriptor.size !== entries[name].length || descriptor.sha256 !== await sha256(entries[name])) throw new Error(`Archive member ${name} failed size/hash validation.`);
  }
  const document: unknown = JSON.parse(decoder.decode(entries['document.json']));
  if (!record(document) || !Array.isArray(document.sources) || !Array.isArray(document.regions)) throw new Error('Invalid decomposition document.');
  const sourceBytes = new Map<string, Uint8Array>(), masks = new Map<string, RegionMask>(), pixels = new Map<string, Uint8Array>();
  for (const source of document.sources) if (record(source)) {
    const member = entries[`references/${source.id}`]; if (!member) throw new Error(`Missing original source ${source.id}.`);
    if (await sha256(member) !== source.byteHash) throw new Error(`Original source ${source.id} was changed.`);
    sourceBytes.set(String(source.id), member);
    const pixelMember = entries[`pixels/${source.id}`];
    if (!pixelMember || await sha256(pixelMember) !== source.pixelHash) throw new Error(`Canonical pixels for ${source.id} failed validation.`);
    pixels.set(String(source.id), pixelMember);
  }
  for (const [name, descriptor] of Object.entries(manifest.members)) if (name.startsWith('masks/')) {
    if (!record(descriptor)) throw new Error('Invalid mask manifest entry.');
    const id = name.slice('masks/'.length);
    const region = document.regions.find((item: unknown) => record(item) && item.maskId === id);
    const bounds = record(region) && record(region.bounds) ? region.bounds : undefined;
    const width = descriptor.width ?? bounds?.width, height = descriptor.height ?? bounds?.height;
    if (!safeId(id) || !Number.isInteger(width) || !Number.isInteger(height) || Number(width) < 1 || Number(height) < 1 || Number(width) * Number(height) !== entries[name].length) throw new Error(`Invalid mask dimensions for ${id}.`);
    masks.set(id, { width: Number(width), height: Number(height), bytes: entries[name] });
  }
  validateDecompositionDocument(document, sourceBytes, masks, pixels);
  return { document, sourceBytes, masks, pixels };
}
