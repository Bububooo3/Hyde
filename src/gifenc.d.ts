declare module 'gifenc' {
  export type Palette = number[][];
  export interface GIFWriter {
    writeFrame(index: Uint8Array, width: number, height: number, options: {
      palette: Palette;
      delay: number;
      repeat: number;
      dispose?: number;
    }): void;
    finish(): void;
    bytesView(): Uint8Array;
  }
  export function GIFEncoder(options?: { initialCapacity?: number }): GIFWriter;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: { format?: 'rgb565' | 'rgb444' }): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: 'rgb565' | 'rgb444'): Uint8Array;
}
