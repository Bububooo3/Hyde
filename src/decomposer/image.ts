import { Unzlib, zlibSync } from 'fflate';
import type { SourceInput } from './types';

export interface DecodedImage { width: number; height: number; rgba: Uint8Array }
export const MAX_IMAGE_PIXELS = 4_000_000;
const pngSignature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const equalPrefix = (bytes: Uint8Array, prefix: Uint8Array) => prefix.every((byte, index) => bytes[index] === byte);
const read32 = (bytes: Uint8Array, at: number) => ((bytes[at] * 0x1000000) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]) >>> 0;
const write32 = (bytes: Uint8Array, at: number, value: number) => {
  bytes[at] = value >>> 24; bytes[at + 1] = value >>> 16; bytes[at + 2] = value >>> 8; bytes[at + 3] = value;
};
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let step = 0; step < 8; step++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(12 + data.length);
  write32(result, 0, data.length);
  result.set(new TextEncoder().encode(type), 4);
  result.set(data, 8);
  write32(result, data.length + 8, crc32(result.subarray(4, data.length + 8)));
  return result;
}
function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, item) => sum + item.length, 0));
  let at = 0;
  for (const item of chunks) { out.set(item, at); at += item.length; }
  return out;
}

/** PNG encoder for source-authentic cropped texture patches; no canvas or server is needed. */
export function encodePng(image: DecodedImage): Uint8Array {
  const { width, height, rgba } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS || rgba.length !== width * height * 4) throw new Error('Invalid PNG dimensions or pixels.');
  const header = new Uint8Array(13);
  write32(header, 0, width); write32(header, 4, height);
  header[8] = 8; header[9] = 6;
  const scanlines = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) scanlines.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return concat([pngSignature, chunk('IHDR', header), chunk('IDAT', zlibSync(scanlines)), chunk('IEND', new Uint8Array())]);
}

/** Bounded, strict PNG decoder used in both Node and browser for reproducible pixels. */
export function decodePng(bytes: Uint8Array): DecodedImage {
  if (!equalPrefix(bytes, pngSignature)) throw new Error('PNG signature is invalid.');
  let at = 8, width = 0, height = 0, bitDepth = 0, colorType = -1;
  let palette: Uint8Array | undefined, transparency: Uint8Array | undefined;
  const compressed: Uint8Array[] = [];
  let ended = false;
  while (at + 12 <= bytes.length) {
    const size = read32(bytes, at), end = at + 12 + size;
    if (size > 128 * 1024 * 1024 || end > bytes.length) throw new Error('PNG chunk exceeds file bounds.');
    const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    if (crc32(bytes.subarray(at + 4, at + 8 + size)) !== read32(bytes, at + 8 + size)) throw new Error(`PNG ${type} CRC mismatch.`);
    const data = bytes.subarray(at + 8, at + 8 + size);
    if (type === 'IHDR') {
      if (width || size !== 13) throw new Error('Invalid PNG header.');
      width = read32(data, 0); height = read32(data, 4); bitDepth = data[8]; colorType = data[9];
      if (!width || !height || width * height > MAX_IMAGE_PIXELS) throw new Error('IMAGE_TOO_LARGE');
      if (bitDepth !== 8 || ![0, 2, 3, 4, 6].includes(colorType) || data[12] !== 0 || data[11] !== 0 || data[10] !== 0) throw new Error('Unsupported PNG color format or interlace.');
    } else if (type === 'PLTE') palette = Uint8Array.from(data);
    else if (type === 'tRNS') transparency = Uint8Array.from(data);
    else if (type === 'IDAT') compressed.push(Uint8Array.from(data));
    else if (type === 'IEND') { ended = true; break; }
    else if (type[0] === type[0].toUpperCase()) throw new Error(`Unsupported required PNG chunk ${type}.`);
    at = end;
  }
  if (!ended || !compressed.length || !width) throw new Error('PNG is incomplete.');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const stride = width * channels;
  const expectedLength = height * (stride + 1), inflated = new Uint8Array(expectedLength);
  let written = 0;
  const inflater = new Unzlib(chunk => {
    if (written + chunk.length > expectedLength) throw new Error('PNG expands beyond declared dimensions.');
    inflated.set(chunk, written); written += chunk.length;
  });
  const input = concat(compressed);
  for (let offset = 0; offset < input.length; offset += 65_536) inflater.push(input.subarray(offset, Math.min(input.length, offset + 65_536)), offset + 65_536 >= input.length);
  if (written !== expectedLength) throw new Error('PNG scanline length is invalid.');
  const rgba = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride), current = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const raw = inflated[y * (stride + 1) + 1 + x];
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >>> 1;
      else if (filter === 4) {
        const p = left + up - upperLeft;
        const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upperLeft);
        predictor = a <= b && a <= c ? left : b <= c ? up : upperLeft;
      } else if (filter !== 0) throw new Error('Unsupported PNG scanline filter.');
      current[x] = (raw + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const from = x * channels, to = (y * width + x) * 4;
      if (colorType === 6) rgba.set(current.subarray(from, from + 4), to);
      else if (colorType === 2) { rgba.set(current.subarray(from, from + 3), to); rgba[to + 3] = 255; }
      else if (colorType === 0) { rgba[to] = rgba[to + 1] = rgba[to + 2] = current[from]; rgba[to + 3] = 255; }
      else if (colorType === 4) { rgba[to] = rgba[to + 1] = rgba[to + 2] = current[from]; rgba[to + 3] = current[from + 1]; }
      else {
        const paletteIndex = current[from];
        if (!palette || paletteIndex * 3 + 2 >= palette.length) throw new Error('PNG palette index is invalid.');
        rgba.set(palette.subarray(paletteIndex * 3, paletteIndex * 3 + 3), to);
        rgba[to + 3] = transparency?.[paletteIndex] ?? 255;
      }
    }
    [previous, current] = [current, previous];
  }
  return { width, height, rgba };
}

/** The deterministic PNG decoder keeps encoded channel values; it does not
 * apply embedded ICC or gamma/chromaticity transforms. Surface that limit. */
export function unsupportedPngColorMetadata(bytes: Uint8Array): string | undefined {
  if (!equalPrefix(bytes, pngSignature)) return undefined;
  let at = pngSignature.length, icc = false, gamma = false, chromaticity = false, srgb = false;
  while (at + 12 <= bytes.length) {
    const length = read32(bytes, at), next = at + 12 + length;
    if (length > 128 * 1024 * 1024 || next > bytes.length) break;
    const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    if (type === 'iCCP') icc = true;
    if (type === 'gAMA') gamma = true;
    if (type === 'cHRM') chromaticity = true;
    if (type === 'sRGB') srgb = true;
    if (type === 'IEND') break;
    at = next;
  }
  if (icc) return 'Embedded PNG ICC profile is retained in the original bytes but is not applied to canonical analysis pixels.';
  if (!srgb && (gamma || chromaticity)) return 'PNG gamma/chromaticity metadata is retained in the original bytes but is not applied to canonical analysis pixels.';
  return undefined;
}

export async function decodeSource(input: SourceInput): Promise<DecodedImage> {
  if (!input.bytes.byteLength || input.bytes.byteLength > 128 * 1024 * 1024) throw new Error('IMAGE_TOO_LARGE');
  if (input.mime === 'image/png') return decodePng(input.bytes);
  if (input.mime !== 'image/jpeg' && input.mime !== 'image/webp') throw new Error('UNSUPPORTED_SOURCE');
  const jpeg = input.bytes[0] === 0xff && input.bytes[1] === 0xd8;
  const webp = new TextDecoder().decode(input.bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(input.bytes.subarray(8, 12)) === 'WEBP';
  if (!(input.mime === 'image/jpeg' ? jpeg : webp)) throw new Error('DECODE_FAILURE');
  if (input.decoded) {
    const { width, height, rgba } = input.decoded;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS || rgba.length !== width * height * 4) throw new Error('DECODE_FAILURE');
    return { width, height, rgba: Uint8Array.from(rgba) };
  }
  if (typeof createImageBitmap !== 'function' || (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined'))
    throw new Error('DECODE_FAILURE: JPEG/WebP needs a browser canvas decoder or caller-supplied pixels.');
  const bitmap = await createImageBitmap(new Blob([input.bytes as BlobPart], { type: input.mime }), { imageOrientation: 'from-image', colorSpaceConversion: 'default' });
  try {
    if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) throw new Error('IMAGE_TOO_LARGE');
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) throw new Error('DECODE_FAILURE: Canvas 2D is unavailable.');
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, rgba: Uint8Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data) };
  } finally { bitmap.close(); }
}
