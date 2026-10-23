import { encodePng } from '../src/decomposer/image';
import type { DecodedImage } from '../src/decomposer/image';
import type { SourceInput } from '../src/decomposer/types';

/** Original, procedurally authored test art. No external files, fonts, brands or trained models. */
export type SyntheticFixtureName =
  | 'simple-icon' | 'multicolor-prop' | 'articulated-character' | 'occlusion'
  | 'gradient-texture' | 'hole-islands' | 'pixel-art' | 'busy-input';

export interface SyntheticFixture {
  name: SyntheticFixtureName;
  image: DecodedImage;
  bytes: Uint8Array;
  input: SourceInput;
  /** A fixture-specific interpretation boundary, not a fidelity verdict. */
  limitation: string;
}

type Color = readonly [number, number, number, number?];

class Raster {
  readonly rgba: Uint8Array;
  constructor(readonly width: number, readonly height: number) { this.rgba = new Uint8Array(width * height * 4); }
  pixel(x: number, y: number, color: Color): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.rgba.set([color[0], color[1], color[2], color[3] ?? 255], (y * this.width + x) * 4);
  }
  rect(x0: number, y0: number, x1: number, y1: number, color: Color): void {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.pixel(x, y, color);
  }
  disk(cx: number, cy: number, radius: number, color: Color): void {
    for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(this.height - 1, Math.ceil(cy + radius)); y++)
      for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(this.width - 1, Math.ceil(cx + radius)); x++)
        if ((x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 <= radius ** 2) this.pixel(x, y, color);
  }
  image(): DecodedImage { return { width: this.width, height: this.height, rgba: Uint8Array.from(this.rgba) }; }
}

export function makeSyntheticFixture(name: SyntheticFixtureName): SyntheticFixture {
  let art: Raster;
  let limitation: string;
  switch (name) {
    case 'simple-icon':
      art = new Raster(48, 48);
      art.disk(24, 24, 16, [210, 65, 49]);
      limitation = 'A single isolated silhouette has no evidence for articulation or hidden surfaces.';
      break;
    case 'multicolor-prop':
      art = new Raster(56, 40);
      art.rect(5, 14, 28, 29, [181, 54, 39]);
      art.rect(28, 6, 48, 35, [30, 111, 188]);
      limitation = 'Two visible paint regions are independently editable; contact alone does not prove a joint.';
      break;
    case 'articulated-character':
      art = new Raster(64, 72);
      art.rect(25, 22, 39, 48, [54, 108, 181]);
      art.disk(32, 15, 9, [239, 192, 119]);
      art.rect(14, 26, 25, 31, [212, 82, 69]);
      art.rect(39, 26, 50, 31, [212, 82, 69]);
      art.rect(26, 48, 31, 64, [87, 69, 151]);
      art.rect(33, 48, 38, 64, [87, 69, 151]);
      limitation = 'Visible limbs can become parts; pivot locations and joint types still need review and approval.';
      break;
    case 'occlusion':
      art = new Raster(64, 64);
      art.rect(9, 9, 55, 55, [194, 79, 61]);
      art.rect(23, 18, 43, 42, [61, 125, 196]);
      limitation = 'A flat enclosed front patch does not reveal hidden back geometry; the obscured area is a native-path hole approximation.';
      break;
    case 'gradient-texture':
      art = new Raster(48, 48);
      for (let y = 5; y < 43; y++) for (let x = 5; x < 43; x++) {
        const dark = (x + y) % 2 === 0;
        art.pixel(x, y, dark ? [48, 72, 96] : [71, 95, 119]);
      }
      limitation = 'Authentic high-frequency color needs a raster crop inside an editable path; color texture is not vectorized.';
      break;
    case 'hole-islands':
      art = new Raster(64, 64);
      art.rect(7, 7, 42, 42, [71, 163, 111]);
      art.rect(18, 18, 31, 31, [0, 0, 0, 0]);
      art.rect(48, 20, 59, 31, [71, 163, 111]);
      limitation = 'One Hyde path cannot express an interior transparent hole; the island remains a separate region.';
      break;
    case 'pixel-art':
      art = new Raster(32, 32);
      art.rect(8, 4, 24, 27, [32, 39, 69]);
      art.rect(10, 7, 22, 22, [242, 203, 129]);
      art.rect(11, 11, 14, 14, [28, 45, 66]);
      art.rect(18, 11, 21, 14, [28, 45, 66]);
      art.rect(13, 17, 19, 19, [182, 63, 66]);
      limitation = 'Crisp pixel boundaries are visible evidence; contour simplification may still change corner pixels in the native render.';
      break;
    case 'busy-input':
      art = new Raster(26, 26);
      for (let y = 0; y < 26; y++) for (let x = 0; x < 26; x++) art.pixel(x, y, (x + y) % 2 ? [231, 231, 231] : [24, 24, 24]);
      limitation = 'Hundreds of single-pixel pieces are not useful parts; a bounded exporter should diagnose this rather than flatten it.';
      break;
  }
  const image = art.image(), bytes = encodePng(image);
  return { name, image, bytes, input: { bytes, name: `${name}.png`, mime: 'image/png', role: 'primary' }, limitation };
}

export function makeRepeatedMultiviewFixture(): { primary: SyntheticFixture; alternate: SyntheticFixture } {
  const make = (name: 'primary' | 'alternate') => {
    const art = new Raster(64, 40);
    const centers = name === 'primary' ? [17, 47] : [20, 44];
    for (const x of centers) art.disk(x, 20, 8, [192, 70, 61]);
    const image = art.image(), bytes = encodePng(image);
    return { name: 'simple-icon' as const, image, bytes,
      input: { bytes, name: `repeated-${name}.png`, mime: 'image/png', role: name === 'primary' ? 'primary' as const : 'alternate-view' as const },
      limitation: 'Two nearly identical repeated regions admit multiple correspondence candidates; their identity cannot be inferred reliably.' };
  };
  return { primary: make('primary'), alternate: make('alternate') };
}

export function makeMalformedPngFixture(): { badSignature: Uint8Array; badCrc: Uint8Array } {
  const good = makeSyntheticFixture('simple-icon').bytes;
  const badSignature = Uint8Array.from(good), badCrc = Uint8Array.from(good);
  badSignature[0] ^= 0xff;
  badCrc[20] ^= 0xff;
  return { badSignature, badCrc };
}
