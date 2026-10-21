import type { PinRect } from './projectivePin';

/** The media plane moves independently of its containing shape. Offsets are
 * element-local pixels, and scaling/rotation pivot at the media plane's center. */
export interface MediaTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}

export const DEFAULT_MEDIA_TRANSFORM: Readonly<MediaTransform> = {
  x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0,
};

/** The untransformed source rectangle in element-local pixels. It may extend
 * outside the element for Fill; the element's mask does the cropping. */
export function mediaPlaneRect(
  fit: 'fill' | 'fit' | 'stretch',
  elementWidth: number,
  elementHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): PinRect | null {
  if (![elementWidth, elementHeight, sourceWidth, sourceHeight].every(value => Number.isFinite(value) && value > 0)) return null;
  let width = elementWidth, height = elementHeight;
  if (fit !== 'stretch') {
    const ratio = fit === 'fit'
      ? Math.min(elementWidth / sourceWidth, elementHeight / sourceHeight)
      : Math.max(elementWidth / sourceWidth, elementHeight / sourceHeight);
    width = sourceWidth * ratio;
    height = sourceHeight * ratio;
  }
  return { x: (elementWidth - width) / 2, y: (elementHeight - height) / 2, width, height };
}

/** Transform a point of the fitted media plane without moving its mask. */
export function mediaPlanePoint(
  point: { x: number; y: number }, elementWidth: number, elementHeight: number,
  transform: Readonly<MediaTransform> = DEFAULT_MEDIA_TRANSFORM,
): { x: number; y: number } {
  const dx = (point.x - elementWidth / 2) * transform.scaleX;
  const dy = (point.y - elementHeight / 2) * transform.scaleY;
  const angle = transform.rotation * Math.PI / 180;
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  return {
    x: elementWidth / 2 + transform.x + dx * cosine - dy * sine,
    y: elementHeight / 2 + transform.y + dx * sine + dy * cosine,
  };
}
