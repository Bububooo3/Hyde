// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from './image';
import { compareNativeRender } from './quality';
import { defaultSettings } from './types';
import type { DecompositionDocumentV1 } from './types';

function pixels(width: number, height: number, filled: (x: number, y: number) => boolean, color: [number, number, number, number] = [210, 90, 30, 255]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (filled(x, y)) rgba.set(color, (y * width + x) * 4);
  return { width, height, rgba };
}

function document(width: number, height: number, regionPixels: number): DecompositionDocumentV1 {
  return {
    format: 'hyde-decomposition', schemaVersion: 1, id: 'document', name: 'Quality fixture',
    createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', algorithmVersion: 'test',
    mode: 'appearance', settings: defaultSettings('appearance'),
    sources: [{ id: 'source', role: 'primary', name: 'source.png', mime: 'image/png', byteHash: 'bytes', byteLength: 1,
      pixelHash: 'pixels', width, height, orientation: 'oriented', colorSpace: 'srgb-assumed', alphaFraction: regionPixels / (width * height) }],
    regions: [{ id: 'region', sourceId: 'source', maskId: 'mask', bounds: { x: 0, y: 0, width, height }, pixelCount: regionPixels,
      classification: 'foreground', color: '#d25a1e', colorVariance: 0,
      confidence: { kind: 'heuristic', reasons: [] }, provenance: { algorithmVersion: 'test', settingsFingerprint: 'test' },
      generationStatus: 'generated', locked: { mask: false, geometry: false, part: false },
      lineage: { parents: [], children: [] }, partId: 'part',
      geometry: { id: 'geometry', generatedPath: { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] },
        bounds: { x: 0, y: 0, width, height }, status: 'visible', quality: { maskIoU: 1, pathPointCount: 4, colorError: 0 }, texture: 'source-crop', locked: false },
      holeCount: 0, adjacency: [] }],
    parts: [{ id: 'part', name: 'Part', regionIds: ['region'], bounds: { x: 0, y: 0, width, height },
      pivot: { x: width / 2, y: height / 2 }, pivotLocked: false, attachmentApproved: false,
      hiddenGeometry: 'none', zOrder: 0, transformLocked: false }],
    correspondences: [], layers: [], diagnostics: [], history: [],
  };
}

describe('native Hyde render quality comparison', () => {
  it('reports exact agreement and an empty diagnostic overlay for identical RGBA', () => {
    const source = pixels(5, 5, (x, y) => x >= 1 && x <= 3 && y >= 1 && y <= 3);
    const report = compareNativeRender(source, encodePng(source), document(5, 5, 9));
    expect(report.silhouette).toEqual({ sourcePixels: 9, renderedPixels: 9, intersectionPixels: 9, unionPixels: 9, iou: 1 });
    expect(report.boundary).toMatchObject({ sourcePixels: 8, renderedPixels: 8, meanDistancePixels: 0, maxDistancePixels: 0, disagreementPixels: 0 });
    expect(report.color).toMatchObject({ overlapPixels: 9, meanAbsoluteSrgbChannelError: 0, meanAbsoluteAlphaError: 0, residualPixels: 0 });
    expect(report.coverage).toEqual({ uncoveredPixels: 0, uncoveredFraction: 0, excessPixels: 0, haloPixels: 0, distantExcessPixels: 0 });
    expect(report.complexity).toMatchObject({ activeRegionCount: 1, activePartCount: 1, pathPointCount: 4, textureBackedRegionCount: 1, largestRegionSourceFraction: 1 });
    expect(decodePng(report.residualOverlayPng).rgba.every(byte => byte === 0)).toBe(true);
  });

  it('separates missing coverage from a one-pixel silhouette halo', () => {
    const source = pixels(5, 5, (x, y) => x >= 1 && x <= 3 && y >= 1 && y <= 3);
    const shifted = pixels(5, 5, (x, y) => x >= 2 && x <= 4 && y >= 1 && y <= 3);
    const report = compareNativeRender(source, encodePng(shifted), document(5, 5, 9));
    expect(report.silhouette.iou).toBe(0.5);
    expect(report.coverage).toEqual({ uncoveredPixels: 3, uncoveredFraction: 1 / 3, excessPixels: 3, haloPixels: 3, distantExcessPixels: 0 });
    expect(report.boundary.meanDistancePixels).toBeGreaterThan(0);
    const overlay = decodePng(report.residualOverlayPng).rgba;
    expect([...overlay.subarray((2 * 5 + 1) * 4, (2 * 5 + 1) * 4 + 4)]).toEqual([255, 48, 48, 210]);
    expect([...overlay.subarray((2 * 5 + 4) * 4, (2 * 5 + 4) * 4 + 4)]).toEqual([0, 210, 255, 200]);
  });

  it('uses exact diagonal boundary distance and labels a distant excess pixel', () => {
    const source = pixels(3, 3, (x, y) => x === 0 && y === 0);
    const diagonal = pixels(3, 3, (x, y) => x === 1 && y === 1);
    const report = compareNativeRender(source, encodePng(diagonal), document(3, 3, 1), { boundaryTolerancePixels: 1 });
    expect(report.boundary.meanDistancePixels).toBeCloseTo(Math.SQRT2, 9);
    expect(report.boundary.maxDistancePixels).toBeCloseTo(Math.SQRT2, 9);
    expect(report.boundary.disagreementPixels).toBe(2);
    expect(report.coverage).toMatchObject({ uncoveredPixels: 1, excessPixels: 1, haloPixels: 0, distantExcessPixels: 1 });
    const overlay = decodePng(report.residualOverlayPng).rgba;
    expect([...overlay.subarray((1 * 3 + 1) * 4, (1 * 3 + 1) * 4 + 4)]).toEqual([50, 80, 255, 200]);
  });

  it('compares straight gamma-encoded sRGB only on overlapping foreground and reports alpha separately', () => {
    const source = pixels(1, 1, () => true, [255, 0, 0, 200]);
    const rendered = pixels(1, 1, () => true, [128, 0, 0, 100]);
    const report = compareNativeRender(source, encodePng(rendered), document(1, 1, 1), { colorResidualThreshold: 0.1 });
    expect(report.color.meanAbsoluteSrgbChannelError).toBeCloseTo(127 / (3 * 255), 9);
    expect(report.color.meanAbsoluteAlphaError).toBeCloseTo(100 / 255, 9);
    expect(report.color.residualPixels).toBe(1);
    expect(report.interpretation.colorMetric).toContain('gamma-encoded sRGB');
    expect([...decodePng(report.residualOverlayPng).rgba]).toEqual([255, 208, 0, 190]);
  });

  it('rejects resolution mismatch and treats two empty silhouettes explicitly', () => {
    const empty = pixels(2, 2, () => false);
    expect(() => compareNativeRender(empty, encodePng(pixels(1, 1, () => false)), document(2, 2, 0))).toThrow('dimensions must match');
    const report = compareNativeRender(empty, encodePng(empty), document(2, 2, 0));
    expect(report.silhouette).toMatchObject({ unionPixels: 0, iou: 1 });
    expect(report.boundary).toMatchObject({ sourcePixels: 0, renderedPixels: 0, meanDistancePixels: 0, disagreementFraction: null });
    expect(report.color.meanAbsoluteSrgbChannelError).toBeNull();
    expect(report.coverage.uncoveredFraction).toBeNull();
    expect(report.complexity.largestRegionSourceFraction).toBeNull();
  });

  it('matches a brute-force symmetric Euclidean contour comparison on irregular small masks', () => {
    const width = 7, height = 6;
    const left = pixels(width, height, (x, y) => x >= 1 && x <= 4 && y >= 1 && y <= 3 || x === 4 && y === 4);
    const right = pixels(width, height, (x, y) => x >= 2 && x <= 5 && y >= 1 && y <= 4 && !(x === 3 && y === 3));
    const mask = (image: ReturnType<typeof pixels>) => Array.from({ length: width * height }, (_, at) => image.rgba[at * 4 + 3] > 0);
    const edges = (foreground: boolean[]) => foreground.flatMap((on, at) => {
      if (!on) return [];
      const x = at % width, y = Math.floor(at / width);
      return x === 0 || x === width - 1 || y === 0 || y === height - 1 || !foreground[at - 1] || !foreground[at + 1] || !foreground[at - width] || !foreground[at + width] ? [{ x, y }] : [];
    });
    const a = edges(mask(left)), b = edges(mask(right));
    const distances = [...a.map(point => Math.min(...b.map(other => Math.hypot(point.x - other.x, point.y - other.y)))),
      ...b.map(point => Math.min(...a.map(other => Math.hypot(point.x - other.x, point.y - other.y))))];
    const report = compareNativeRender(left, encodePng(right), document(width, height, mask(left).filter(Boolean).length), { boundaryTolerancePixels: 0.5 });
    expect(report.boundary.meanDistancePixels).toBeCloseTo(distances.reduce((sum, value) => sum + value, 0) / distances.length, 9);
    expect(report.boundary.maxDistancePixels).toBeCloseTo(Math.max(...distances), 9);
    expect(report.boundary.disagreementPixels).toBe(distances.filter(value => value > 0.5).length);
  });
});
