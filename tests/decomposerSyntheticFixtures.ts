import { encodePng } from '../src/decomposer/image';
import type { DecodedImage } from '../src/decomposer/image';
import type { SourceInput } from '../src/decomposer/types';

/** Original, procedurally authored test art. No external files, fonts, brands or trained models. */
export type SyntheticFixtureName =
  | 'simple-icon' | 'multicolor-prop' | 'articulated-character' | 'occlusion'
  | 'gradient-texture' | 'hole-islands' | 'pixel-art' | 'busy-input' | 'storybook-fox';

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

/** A larger, layered source illustration with subpixel edges and gentle paint
 * variation. The geometry is deliberately authored independently of Hyde. */
function storybookFox(): Raster {
  const art = new Raster(192, 160);
  type Paint = (x: number, y: number) => Color;
  const layers: { contains: (x: number, y: number) => boolean; paint: Paint }[] = [];
  const ellipse = (cx: number, cy: number, rx: number, ry: number, color: Color | Paint, rotation = 0) => {
    const c = Math.cos(rotation), s = Math.sin(rotation);
    layers.push({ contains: (x, y) => {
      const dx = x - cx, dy = y - cy;
      const localX = dx * c + dy * s, localY = -dx * s + dy * c;
      return (localX / rx) ** 2 + (localY / ry) ** 2 <= 1;
    }, paint: typeof color === 'function' ? color : () => color });
  };
  const polygon = (points: readonly (readonly [number, number])[], color: Color | Paint) => {
    layers.push({ contains: (x, y) => {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i], b = points[j];
        if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
      return inside;
    }, paint: typeof color === 'function' ? color : () => color });
  };
  const fur: Paint = (x, y) => [190 + Math.round((x - 85) * .12), 93 + Math.round((y - 80) * .11), 53];
  const dark: Color = [64, 54, 65], cream: Color = [244, 220, 170];
  // Tail and hind paw sit behind the torso; the cream tip is a separate paint region.
  polygon([[60, 103], [33, 72], [21, 59], [17, 80], [35, 119], [71, 132]], dark);
  polygon([[61, 103], [34, 74], [24, 66], [23, 81], [39, 114], [69, 125]], fur);
  polygon([[24, 66], [21, 59], [17, 80], [29, 105], [40, 113], [31, 84]], cream);
  ellipse(85, 128, 17, 12, dark, -.18);
  ellipse(85, 125, 14, 10, [170, 79, 53], -.18);
  // A dark edge is visible at the body silhouette; the main fur remains textured.
  ellipse(101, 97, 47, 38, dark, -.12);
  ellipse(101, 94, 43, 35, fur, -.12);
  ellipse(122, 104, 22, 26, cream, -.18);
  // Two ears overlap the head, with independent inner-ear patches.
  polygon([[109, 52], [112, 11], [132, 36], [136, 58]], dark);
  polygon([[114, 46], [115, 19], [128, 37], [130, 55]], fur);
  polygon([[119, 38], [117, 26], [126, 38]], [230, 151, 132]);
  polygon([[147, 51], [168, 16], [171, 61], [160, 70]], dark);
  polygon([[149, 52], [166, 26], [166, 60], [158, 67]], fur);
  polygon([[157, 48], [165, 34], [164, 55]], [230, 151, 132]);
  ellipse(141, 67, 35, 31, dark, -.12);
  ellipse(141, 66, 32, 28, fur, -.12);
  ellipse(151, 80, 22, 15, cream, -.18);
  ellipse(169, 80, 6, 5, dark);
  ellipse(134, 61, 3.2, 4.5, dark);
  ellipse(135, 59, 1, 1.4, [255, 249, 222]);
  // Two separate forelegs and paws remain plausible articulation candidates.
  polygon([[104, 113], [116, 115], [112, 140], [105, 146], [91, 142]], dark);
  polygon([[106, 114], [115, 116], [110, 139], [104, 143], [96, 140]], fur);
  polygon([[128, 112], [140, 111], [140, 140], [132, 146], [118, 141]], dark);
  polygon([[129, 114], [137, 113], [137, 138], [131, 142], [123, 139]], fur);
  const samples = 4;
  for (let y = 0; y < art.height; y++) for (let x = 0; x < art.width; x++) {
    let r = 0, g = 0, b = 0, count = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const px = x + (sx + .5) / samples, py = y + (sy + .5) / samples;
      let color: Color | undefined;
      for (const layer of layers) if (layer.contains(px, py)) color = layer.paint(px, py);
      if (!color) continue;
      r += color[0]; g += color[1]; b += color[2]; count++;
    }
    if (count) art.pixel(x, y, [Math.round(r / count), Math.round(g / count), Math.round(b / count), Math.round(count * 255 / (samples * samples))]);
  }
  return art;
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
      limitation = 'A flat enclosed front patch does not reveal hidden back geometry; its visible opening can be a native editable hole.';
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
    case 'storybook-fox':
      art = storybookFox();
      limitation = 'Antialiased, layered storybook art supplies visible parts but cannot prove hidden anatomy, hinge locations or joint limits.';
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
