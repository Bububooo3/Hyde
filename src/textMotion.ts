import type {TextAnimation} from './model';
import {ease} from './engine';

export interface TextMotion {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  alpha: number;
  /** Fraction of the unit visible through a left-to-right clipping wipe. */
  reveal: number;
}

const neutral: TextMotion = {x: 0, y: 0, scale: 1, rotation: 0, alpha: 1, reveal: 1};
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;

export function createTextAnimation(patch: Partial<TextAnimation> = {}): TextAnimation {
  return {
    unit: 'word', effect: 'fade', direction: 'in',
    start: 0, duration: .8, stagger: .12,
    easing: 'sine', easingDirection: 'inOut',
    distance: 32, seed: 1, amplitude: 14, frequency: 2,
    ...patch,
  };
}

/** Stable across seeking, export, and browser sessions. No global random state. */
function random(seed: number, stableId: string, unitIndex: number, salt: number): number {
  let hash = (2166136261 ^ (Math.trunc(finite(seed, 1)) >>> 0)) >>> 0;
  const value = `${stableId}\u0000${unitIndex}\u0000${salt}`;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash / 4294967296;
}

/** Evaluate one laid-out word or line at element-local time, without changing project data. */
export function textMotionAt(
  animation: TextAnimation,
  elementTime: number,
  unitIndex: number,
  unitCount: number,
  stableId = '',
): TextMotion {
  const count = Math.max(1, Math.floor(finite(unitCount, 1)));
  const index = Math.max(0, Math.min(count - 1, Math.floor(finite(unitIndex, 0))));
  // Exit order is reversed, so the last displayed word or line departs first.
  const order = animation.direction === 'out' ? count - 1 - index : index;
  const begin = finite(animation.start, 0) + order * Math.max(0, finite(animation.stagger, 0));
  const duration = Math.max(0, finite(animation.duration, 0));
  const elapsed = finite(elementTime, 0) - begin;
  const progress = duration > 0 ? clamp01(elapsed / duration) : (elapsed < 0 ? 0 : 1);
  const eased = ease(animation.easing, animation.easingDirection, progress);
  const outward = animation.direction === 'out';
  const displaced = outward ? eased : 1 - eased;
  const visible = clamp01(outward ? 1 - eased : eased);
  const distance = finite(animation.distance, 32);

  switch (animation.effect) {
    case 'reveal': return {...neutral, reveal: visible};
    case 'fade': return {...neutral, alpha: visible};
    case 'slide': return {...neutral, x: (outward ? 1 : -1) * distance * displaced, alpha: visible};
    case 'scale': return {...neutral, scale: Math.max(.01, 1 - .3 * displaced), alpha: visible};
    case 'rotate': return {...neutral, rotation: (outward ? 1 : -1) * distance * displaced, alpha: visible};
    case 'wave': {
      if (progress <= 0 || progress >= 1) return {...neutral, alpha: visible};
      const frequency = Math.max(0, finite(animation.frequency, 2));
      const amplitude = finite(animation.amplitude, 14);
      // The envelope reaches zero at both ends; the in motion damps while
      // the out motion swells before the unit disappears.
      const envelope = outward ? progress : 1 - progress;
      const phase = outward ? 1 - progress : progress;
      return {...neutral, y: amplitude * Math.sin(2 * Math.PI * frequency * phase) * envelope, alpha: visible};
    }
    case 'scatter': {
      if (displaced === 0) return {...neutral, alpha: visible};
      const angle = random(animation.seed, stableId, index, 0) * 2 * Math.PI;
      const radius = distance * (.65 + .35 * random(animation.seed, stableId, index, 1));
      const rotation = (random(animation.seed, stableId, index, 2) - .5) * 60;
      return {...neutral, x: Math.cos(angle) * radius * displaced, y: Math.sin(angle) * radius * displaced,
        rotation: rotation * displaced, alpha: visible};
    }
  }
}
