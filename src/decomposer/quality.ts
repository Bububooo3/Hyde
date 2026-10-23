import { decodePng, encodePng, MAX_IMAGE_PIXELS } from './image';
import type { DecodedImage } from './image';
import type { DecompositionDocumentV1 } from './types';

export interface NativeRenderComparisonOptions {
  /** Pixel alpha at or above this byte value counts as foreground. Defaults to the document setting. */
  alphaThreshold?: number;
  /** Exact Euclidean distance in pixel centers; defaults to 1.5 pixels. */
  boundaryTolerancePixels?: number;
  /** Mean absolute straight sRGB channel error in [0, 1]; defaults to 0.1. */
  colorResidualThreshold?: number;
}

export interface ReconstructionQualityReport {
  width: number;
  height: number;
  interpretation: {
    colorSpace: 'srgb-assumed';
    alpha: 'straight';
    colorMetric: 'alpha-weighted mean absolute gamma-encoded sRGB channel difference on overlapping foreground';
    boundaryMetric: 'symmetric Euclidean distance between four-neighbor foreground boundary pixel centers';
    silhouetteThreshold: number;
  };
  silhouette: {
    sourcePixels: number;
    renderedPixels: number;
    intersectionPixels: number;
    unionPixels: number;
    iou: number;
  };
  boundary: {
    sourcePixels: number;
    renderedPixels: number;
    /** Null means only one image has a measurable boundary. */
    meanDistancePixels: number | null;
    maxDistancePixels: number | null;
    disagreementPixels: number;
    disagreementFraction: number | null;
    tolerancePixels: number;
  };
  color: {
    overlapPixels: number;
    /** Null means there are no pixels with foreground in both images. */
    meanAbsoluteSrgbChannelError: number | null;
    meanAbsoluteAlphaError: number;
    residualPixels: number;
    threshold: number;
  };
  coverage: {
    uncoveredPixels: number;
    uncoveredFraction: number | null;
    excessPixels: number;
    /** Excess rendered pixels within the boundary tolerance of the source silhouette. */
    haloPixels: number;
    distantExcessPixels: number;
  };
  complexity: {
    activeRegionCount: number;
    activePartCount: number;
    unassignedRegionCount: number;
    pathPointCount: number;
    meanPathPointsPerRegion: number;
    textureBackedRegionCount: number;
    inferredRegionCount: number;
    tinyRegionCount: number;
    largestRegionSourceFraction: number | null;
  };
  /** Transparent where no thresholded residual was found. Colors are diagnostic labels, not a composite. */
  residualOverlayPng: Uint8Array;
  overlayLegend: {
    uncovered: '#ff3030';
    halo: '#00d2ff';
    distantExcess: '#3250ff';
    contour: '#ff00ff';
    color: '#ffd000';
  };
}

function validateImage(image: DecodedImage, label: string): void {
  const { width, height, rgba } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS || !(rgba instanceof Uint8Array) || rgba.length !== width * height * 4) {
    throw new Error(`${label} must be a bounded RGBA image with four bytes per pixel.`);
  }
}

/** Four-neighbor pixel-center boundary, including edges touching the canvas. */
function boundaryOf(mask: Uint8Array, width: number, height: number): { mask: Uint8Array; count: number } {
  const result = new Uint8Array(mask.length);
  let count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * width + x;
    if (!mask[at]) continue;
    if (x === 0 || x === width - 1 || y === 0 || y === height - 1 || !mask[at - 1] || !mask[at + 1] || !mask[at - width] || !mask[at + width]) {
      result[at] = 1;
      count++;
    }
  }
  return { mask: result, count };
}

/** Exact one-dimensional squared Euclidean distance transform. */
function transformLine(values: Float64Array, out: Float64Array, length: number, sites: Int32Array, cuts: Float64Array): void {
  let last = 0;
  sites[0] = 0;
  cuts[0] = -Infinity;
  cuts[1] = Infinity;
  for (let at = 1; at < length; at++) {
    let cross = 0;
    while (true) {
      const site = sites[last];
      cross = ((values[at] + at * at) - (values[site] + site * site)) / (2 * (at - site));
      if (cross > cuts[last] || last === 0) break;
      last--;
    }
    last++;
    sites[last] = at;
    cuts[last] = cross;
    cuts[last + 1] = Infinity;
  }
  last = 0;
  for (let at = 0; at < length; at++) {
    while (cuts[last + 1] < at) last++;
    const delta = at - sites[last];
    out[at] = delta * delta + values[sites[last]];
  }
}

/** Two separable passes give squared Euclidean distances in O(width × height). */
function distanceToBoundary(boundary: Uint8Array, width: number, height: number): Float64Array {
  const count = width * height;
  // Finite sentinel avoids Infinity-Infinity in parabola intersections. It exceeds
  // every possible in-image squared distance, including extreme aspect ratios.
  const sentinel = width * width + height * height + 1;
  const rows = new Float64Array(count), result = new Float64Array(count);
  const longest = Math.max(width, height);
  const input = new Float64Array(longest), output = new Float64Array(longest);
  const sites = new Int32Array(longest), cuts = new Float64Array(longest + 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) input[x] = boundary[y * width + x] ? 0 : sentinel;
    transformLine(input, output, width, sites, cuts);
    rows.set(output.subarray(0, width), y * width);
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) input[y] = rows[y * width + x];
    transformLine(input, output, height, sites, cuts);
    for (let y = 0; y < height; y++) result[y * width + x] = output[y];
  }
  return result;
}

function complexity(document: DecompositionDocumentV1, foregroundPixels: number): ReconstructionQualityReport['complexity'] {
  const primaryId = document.sources.find(source => source.role === 'primary')?.id;
  const regions = document.regions.filter(region => region.sourceId === primaryId && region.classification === 'foreground' && region.generationStatus !== 'historical');
  const partIds = new Set(regions.map(region => region.partId).filter((id): id is string => Boolean(id)));
  const pathPointCount = regions.reduce((sum, region) => sum + (region.geometry.manualPath ?? region.geometry.generatedPath).points.length, 0);
  const largest = regions.reduce((size, region) => Math.max(size, region.pixelCount), 0);
  return {
    activeRegionCount: regions.length,
    activePartCount: document.parts.filter(part => partIds.has(part.id)).length,
    unassignedRegionCount: regions.filter(region => !region.partId).length,
    pathPointCount,
    meanPathPointsPerRegion: regions.length ? pathPointCount / regions.length : 0,
    textureBackedRegionCount: regions.filter(region => region.geometry.texture === 'source-crop').length,
    inferredRegionCount: regions.filter(region => region.geometry.status === 'inferred').length,
    tinyRegionCount: regions.filter(region => region.pixelCount < document.settings.minRegionPixels).length,
    largestRegionSourceFraction: foregroundPixels ? largest / foregroundPixels : null,
  };
}

/**
 * Compare canonical source RGBA with a PNG obtained from HydeRenderHost.renderFrame.
 * This is measured, resolution-matched pixel evidence, not a perceptual or
 * subjective quality score. The PNG must be rendered on a transparent Hyde
 * background at exactly the source dimensions and neutral reference pose.
 */
export function compareNativeRender(
  source: DecodedImage,
  renderedPng: Uint8Array,
  document: DecompositionDocumentV1,
  options: NativeRenderComparisonOptions = {},
): ReconstructionQualityReport {
  validateImage(source, 'Source');
  const rendered = decodePng(renderedPng);
  validateImage(rendered, 'Rendered PNG');
  if (source.width !== rendered.width || source.height !== rendered.height) throw new Error('Source and Hyde render dimensions must match exactly; request a render at the primary source resolution.');
  const primary = document.sources.find(reference => reference.role === 'primary');
  if (!primary || primary.width !== source.width || primary.height !== source.height) throw new Error('Source RGBA dimensions must match the document primary reference.');
  const alphaThreshold = options.alphaThreshold ?? document.settings.alphaThreshold;
  const tolerance = options.boundaryTolerancePixels ?? 1.5;
  const colorThreshold = options.colorResidualThreshold ?? 0.1;
  if (!Number.isInteger(alphaThreshold) || alphaThreshold < 1 || alphaThreshold > 255) throw new Error('Alpha threshold must be an integer from 1 to 255.');
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('Boundary tolerance must be a finite nonnegative pixel distance.');
  if (!Number.isFinite(colorThreshold) || colorThreshold < 0 || colorThreshold > 1) throw new Error('Color residual threshold must be between 0 and 1.');
  const { width, height } = source, pixels = width * height;
  const sourceMask = new Uint8Array(pixels), renderMask = new Uint8Array(pixels);
  let sourcePixels = 0, renderedPixels = 0, intersectionPixels = 0, unionPixels = 0;
  let uncoveredPixels = 0, excessPixels = 0, overlapPixels = 0, alphaError = 0;
  let weightedRgbError = 0, rgbWeight = 0, residualPixels = 0;
  const colorResidual = new Uint8Array(pixels);
  for (let index = 0; index < pixels; index++) {
    const at = index * 4, sourceAlpha = source.rgba[at + 3], renderAlpha = rendered.rgba[at + 3];
    const a = sourceAlpha >= alphaThreshold, b = renderAlpha >= alphaThreshold;
    sourceMask[index] = Number(a); renderMask[index] = Number(b);
    sourcePixels += Number(a); renderedPixels += Number(b);
    intersectionPixels += Number(a && b); unionPixels += Number(a || b);
    uncoveredPixels += Number(a && !b); excessPixels += Number(!a && b);
    alphaError += Math.abs(sourceAlpha - renderAlpha) / 255;
    if (a && b) {
      overlapPixels++;
      const difference = (Math.abs(source.rgba[at] - rendered.rgba[at]) + Math.abs(source.rgba[at + 1] - rendered.rgba[at + 1]) + Math.abs(source.rgba[at + 2] - rendered.rgba[at + 2])) / (3 * 255);
      const weight = Math.min(sourceAlpha, renderAlpha) / 255;
      weightedRgbError += difference * weight; rgbWeight += weight;
      if (difference > colorThreshold) { colorResidual[index] = 1; residualPixels++; }
    }
  }
  const sourceBoundary = boundaryOf(sourceMask, width, height);
  const renderBoundary = boundaryOf(renderMask, width, height);
  const sourceDistance = sourceBoundary.count ? distanceToBoundary(sourceBoundary.mask, width, height) : undefined;
  const renderDistance = renderBoundary.count ? distanceToBoundary(renderBoundary.mask, width, height) : undefined;
  const comparable = Boolean(sourceDistance && renderDistance);
  const toleranceSquared = tolerance * tolerance;
  let distanceTotal = 0, maxDistance = 0, disagreementPixels = 0, haloPixels = 0;
  if (comparable) {
    for (let index = 0; index < pixels; index++) {
      if (sourceBoundary.mask[index]) {
        const distance = Math.sqrt(renderDistance![index]);
        distanceTotal += distance; maxDistance = Math.max(maxDistance, distance);
        if (renderDistance![index] > toleranceSquared) disagreementPixels++;
      }
      if (renderBoundary.mask[index]) {
        const distance = Math.sqrt(sourceDistance![index]);
        distanceTotal += distance; maxDistance = Math.max(maxDistance, distance);
        if (sourceDistance![index] > toleranceSquared) disagreementPixels++;
      }
    }
  } else if (sourceBoundary.count || renderBoundary.count) disagreementPixels = sourceBoundary.count + renderBoundary.count;
  for (let index = 0; index < pixels; index++) if (!sourceMask[index] && renderMask[index] && sourceDistance && sourceDistance[index] <= toleranceSquared) haloPixels++;

  const overlay = new Uint8Array(pixels * 4);
  const paint = (index: number, r: number, g: number, b: number, alpha: number) => {
    const at = index * 4;
    overlay[at] = r; overlay[at + 1] = g; overlay[at + 2] = b; overlay[at + 3] = alpha;
  };
  for (let index = 0; index < pixels; index++) {
    if (sourceMask[index] && !renderMask[index]) paint(index, 255, 48, 48, 210);
    else if (!sourceMask[index] && renderMask[index]) {
      if (sourceDistance && sourceDistance[index] <= toleranceSquared) paint(index, 0, 210, 255, 200);
      else paint(index, 50, 80, 255, 200);
    } else if (sourceMask[index] && renderMask[index]) {
      const contour = comparable && (sourceBoundary.mask[index] && renderDistance![index] > toleranceSquared || renderBoundary.mask[index] && sourceDistance![index] > toleranceSquared);
      if (contour) paint(index, 255, 0, 255, 225);
      else if (colorResidual[index]) paint(index, 255, 208, 0, 190);
    }
  }
  const boundaryCount = sourceBoundary.count + renderBoundary.count;
  return {
    width, height,
    interpretation: {
      colorSpace: 'srgb-assumed', alpha: 'straight',
      colorMetric: 'alpha-weighted mean absolute gamma-encoded sRGB channel difference on overlapping foreground',
      boundaryMetric: 'symmetric Euclidean distance between four-neighbor foreground boundary pixel centers',
      silhouetteThreshold: alphaThreshold,
    },
    silhouette: { sourcePixels, renderedPixels, intersectionPixels, unionPixels, iou: unionPixels ? intersectionPixels / unionPixels : 1 },
    boundary: {
      sourcePixels: sourceBoundary.count, renderedPixels: renderBoundary.count,
      meanDistancePixels: comparable ? distanceTotal / boundaryCount : sourceBoundary.count || renderBoundary.count ? null : 0,
      maxDistancePixels: comparable ? maxDistance : sourceBoundary.count || renderBoundary.count ? null : 0,
      disagreementPixels,
      disagreementFraction: boundaryCount ? disagreementPixels / boundaryCount : null,
      tolerancePixels: tolerance,
    },
    color: {
      overlapPixels,
      meanAbsoluteSrgbChannelError: rgbWeight ? weightedRgbError / rgbWeight : null,
      meanAbsoluteAlphaError: alphaError / pixels,
      residualPixels,
      threshold: colorThreshold,
    },
    coverage: {
      uncoveredPixels,
      uncoveredFraction: sourcePixels ? uncoveredPixels / sourcePixels : null,
      excessPixels,
      haloPixels,
      distantExcessPixels: excessPixels - haloPixels,
    },
    complexity: complexity(document, sourcePixels),
    residualOverlayPng: encodePng({ width, height, rgba: overlay }),
    overlayLegend: { uncovered: '#ff3030', halo: '#00d2ff', distantExcess: '#3250ff', contour: '#ff00ff', color: '#ffd000' },
  };
}
