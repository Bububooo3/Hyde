import type { InspectRequest } from './authoring';
import type { Asset, Project } from './model';

type Inspection = { revision: number; error?: { code: string; message: string }; asset?: unknown; items?: unknown[]; [key: string]: unknown };

function assetBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Asset data URL is malformed.');
  const value = dataUrl.slice(comma + 1);
  return dataUrl.slice(0, comma).toLowerCase().endsWith(';base64')
    ? Uint8Array.from(atob(value), char => char.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(value));
}

function imageDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } | undefined {
  const ascii = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
  const be16 = (at: number) => bytes[at] * 256 + bytes[at + 1];
  const le16 = (at: number) => bytes[at] + bytes[at + 1] * 256;
  let width = 0, height = 0;
  if (mime === 'image/png' && bytes.length >= 24 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR') {
    width = (bytes[16] * 0x1000000 + bytes[17] * 65536 + bytes[18] * 256 + bytes[19]) >>> 0;
    height = (bytes[20] * 0x1000000 + bytes[21] * 65536 + bytes[22] * 256 + bytes[23]) >>> 0;
  } else if (mime === 'image/gif' && bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) {
    width = le16(6); height = le16(8);
  } else if (mime === 'image/webp' && bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8X') {
      width = 1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536;
      height = 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536;
    } else if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      width = 1 + bytes[21] + (bytes[22] & 0x3f) * 256;
      height = 1 + (bytes[22] >> 6) + bytes[23] * 4 + (bytes[24] & 0x0f) * 1024;
    } else if (chunk === 'VP8 ' && ascii(23, 3) === '\x9d\x01\x2a') {
      width = le16(26) & 0x3fff; height = le16(28) & 0x3fff;
    }
  } else if (mime === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at++] !== 0xff) break;
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (at + 2 > bytes.length) break;
      const length = be16(at);
      if (length < 2 || at + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        height = be16(at + 3); width = be16(at + 5); break;
      }
      at += length;
    }
  }
  return width > 0 && height > 0 && width <= 100_000 && height <= 100_000 ? { width, height } : undefined;
}

function wanted(query: InspectRequest, field: string): boolean {
  if (query.fields === undefined) return true;
  const fields = typeof query.fields === 'string' ? query.fields.split(',').map(item => item.trim()) : query.fields;
  return fields.includes(field);
}

async function assetMetadata(asset: Asset, query: InspectRequest): Promise<Record<string, unknown>> {
  const { dataUrl, ...metadata } = asset;
  const needBytes = ['byteLength', 'contentSha256', 'width', 'height'].some(field => wanted(query, field));
  const bytes = needBytes ? assetBytes(dataUrl) : undefined;
  const dimensions = bytes && asset.kind === 'image' && (wanted(query, 'width') || wanted(query, 'height'))
    ? imageDimensions(bytes, asset.mime.split(';', 1)[0].toLowerCase()) : undefined;
  const hash = bytes && wanted(query, 'contentSha256')
    ? await crypto.subtle.digest('SHA-256', bytes as BufferSource) : undefined;
  const full = {
    ...metadata,
    ...(bytes && wanted(query, 'byteLength') ? { byteLength: bytes.length } : {}),
    ...(hash ? { contentSha256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') } : {}),
    ...dimensions,
  };
  return Object.fromEntries(Object.entries(full).filter(([field]) => wanted(query, field)));
}

/** Add portable byte metadata only for the requested page; never expose media bytes. */
export async function enrichAssetInspection(project: Project, query: InspectRequest, result: Inspection): Promise<Inspection> {
  if (result.error || query.target !== 'asset' && query.target !== 'assets') return result;
  if (query.target === 'asset') {
    const asset = project.assets.find(item => item.id === query.id);
    return asset ? { ...result, asset: await assetMetadata(asset, query) } : result;
  }
  const ordered = [...project.assets].sort((a, b) => a.id.localeCompare(b.id));
  const page = ordered.slice(query.cursor ?? 0, (query.cursor ?? 0) + (query.limit ?? 25));
  const items: Record<string, unknown>[] = [];
  for (const asset of page) items.push(await assetMetadata(asset, query));
  return { ...result, items };
}
