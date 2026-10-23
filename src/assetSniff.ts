import { DOMParser as NodeDOMParser } from '@xmldom/xmldom';

export type AssetKind = 'image' | 'video' | 'audio' | 'font';

export function baseMime(mime: string): string { return mime.split(';', 1)[0].trim().toLowerCase(); }

export function kindForMime(mime: string): AssetKind | undefined {
  const category = baseMime(mime).split('/', 1)[0];
  return category === 'image' || category === 'video' || category === 'audio' || category === 'font' ? category : undefined;
}

/** Header recognition only: full decoding and media codec support are separate. */
export function sniffAssetMime(bytes: Uint8Array): string | undefined {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 8 && bytes.subarray(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (bytes.length >= 2 && bytes[0] === 255 && (bytes[1] & 0xf7) === 0xf1) return 'audio/aac';
  if (ascii(0, 3) === 'ID3' || bytes.length >= 2 && bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
    if (brand === 'M4A ') return 'audio/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand.startsWith('3gp')) return 'video/3gpp';
    return 'video/mp4';
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  if (ascii(0, 4) === 'wOFF') return 'font/woff';
  if (ascii(0, 4) === 'wOF2') return 'font/woff2';
  if (ascii(0, 4) === 'OTTO') return 'font/otf';
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) return 'font/ttf';
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096))).replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(prefix)) return 'image/svg+xml';
  return undefined;
}

export function resemblesActiveMarkup(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096))).replace(/^\uFEFF/, '').trimStart();
  return prefix.startsWith('<');
}

/** The same container header can legitimately carry audio or video tracks. */
export function headerMatchesMime(detected: string, declared: string): boolean {
  const mime = baseMime(declared);
  return detected === mime || detected === 'video/mp4' && mime === 'audio/mp4'
    || detected === 'video/webm' && mime === 'audio/webm'
    || detected === 'audio/ogg' && mime === 'video/ogg';
}

function safeCss(value: string): boolean {
  const css = value.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/@import\b|\\/i.test(css)) return false;
  for (const match of css.matchAll(/url\(\s*([^)]*)\)/gi)) {
    const target = match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!/^#[A-Za-z_][\w.:-]*$/.test(target)) return false;
  }
  return !/url\s*\(/i.test(css.replace(/url\(\s*[^)]*\)/gi, ''));
}

/** Reject executable SVG features and all nonlocal resource references. */
export function assertSafeSvg(bytes: Uint8Array): void {
  if (!bytes.byteLength || bytes.byteLength > 16 * 1024 * 1024) throw new Error('SVG is empty or exceeds the supported safety limit.');
  let svg: string;
  try { svg = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('SVG text is not valid UTF-8.'); }
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml(?:\s|\?>))/i.test(svg)) throw new Error('SVG contains unsupported declarations.');
  const parser = typeof DOMParser === 'undefined'
    ? new NodeDOMParser({ errorHandler: { warning: () => undefined, error: (message: string) => { throw new Error(message); }, fatalError: (message: string) => { throw new Error(message); } } })
    : new DOMParser();
  let document: Document;
  try { document = parser.parseFromString(svg, 'image/svg+xml') as Document; }
  catch { throw new Error('SVG contains malformed XML.'); }
  if (document.getElementsByTagName('parsererror').length || document.documentElement?.localName?.toLowerCase() !== 'svg') throw new Error('SVG must contain a valid svg root.');
  const stack: Element[] = [document.documentElement];
  let count = 0;
  while (stack.length) {
    const element = stack.pop()!;
    if (++count > 50000) throw new Error('SVG has too many elements.');
    const name = element.localName.toLowerCase();
    if (['script', 'foreignobject', 'iframe', 'object', 'embed', 'link', 'animate', 'animatemotion', 'animatetransform', 'set'].includes(name)) throw new Error('SVG contains executable or unsupported dynamic elements.');
    if (name === 'style' && !safeCss(element.textContent ?? '')) throw new Error('SVG contains an external or unsafe style.');
    for (const attribute of Array.from(element.attributes)) {
      const key = attribute.name.toLowerCase(), value = attribute.value.trim();
      if (key.startsWith('on') || key === 'xml:base') throw new Error('SVG contains executable or base-URL attributes.');
      if ((attribute.localName.toLowerCase() === 'href' || attribute.localName.toLowerCase() === 'src') && value && !/^#[A-Za-z_][\w.:-]*$/.test(value)) throw new Error('SVG contains an external resource reference.');
      if (!safeCss(value)) throw new Error('SVG contains an external or unsafe style reference.');
    }
    stack.push(...Array.from(element.childNodes).filter((child): child is Element => child.nodeType === 1));
  }
}

/** Newly staged bytes remain strict; historical archives may contain opaque media. */
export function validateStagedAsset(bytes: Uint8Array, mime: string, kind: AssetKind): void {
  const detected = sniffAssetMime(bytes);
  if (!detected || !headerMatchesMime(detected, mime) || kindForMime(mime) !== kind) throw new Error(`Asset MIME/kind mismatch: declared ${kind} ${mime}, detected ${detected ?? 'unknown'}.`);
  if (baseMime(mime) === 'image/svg+xml') assertSafeSvg(bytes);
}
