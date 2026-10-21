import {describe, expect, it} from 'vitest';
import {createTextAnimation, textMotionAt} from './textMotion';

describe('text motion', () => {
  it('uses an independent unit-local interval and exact neutral endpoint', () => {
    const animation = createTextAnimation({effect: 'fade', easing: 'linear', easingDirection: 'in',
      start: 1, duration: 1, stagger: .25});
    expect(textMotionAt(animation, 1.1, 1, 3).alpha).toBe(0);
    expect(textMotionAt(animation, 1.75, 1, 3).alpha).toBe(.5);
    expect(textMotionAt(animation, 2.25, 1, 3)).toEqual({x: 0, y: 0, scale: 1, rotation: 0, alpha: 1, reveal: 1});
  });

  it('reverses exit stagger and clamps visible properties to their range', () => {
    const animation = createTextAnimation({effect: 'reveal', direction: 'out',
      easing: 'linear', easingDirection: 'in', start: 1, duration: 1, stagger: .2});
    expect(textMotionAt(animation, 1.2, 0, 3).reveal).toBe(1);
    expect(textMotionAt(animation, 1.2, 2, 3).reveal).toBeCloseTo(.8);
    expect(textMotionAt(animation, 2.4, 0, 3).reveal).toBe(0);
    const overshoot = createTextAnimation({effect: 'fade', easing: 'back', easingDirection: 'out'});
    expect(textMotionAt(overshoot, .6, 0, 1).alpha).toBeLessThanOrEqual(1);
  });

  it('applies easing to slide, scale, and rotate without altering the input', () => {
    const animation = createTextAnimation({effect: 'slide', easing: 'quad', easingDirection: 'in',
      duration: 1, distance: 40});
    const saved = JSON.stringify(animation);
    expect(textMotionAt(animation, .5, 0, 1).x).toBe(-30);
    expect(textMotionAt({...animation, effect: 'scale'}, .5, 0, 1).scale).toBeCloseTo(.775);
    expect(textMotionAt({...animation, effect: 'rotate'}, .5, 0, 1).rotation).toBe(-30);
    expect(textMotionAt({...animation, effect: 'rotate', direction: 'out'}, .5, 0, 1).rotation).toBe(10);
    expect(JSON.stringify(animation)).toBe(saved);
  });

  it('keeps wave motion inside its interval and returns to rest', () => {
    const animation = createTextAnimation({effect: 'wave', easing: 'linear', easingDirection: 'in',
      duration: 1, amplitude: 12, frequency: 1});
    expect(textMotionAt(animation, -.1, 0, 1).y).toBe(0);
    expect(textMotionAt(animation, .25, 0, 1).y).toBeCloseTo(9);
    expect(textMotionAt(animation, 1, 0, 1).y).toBe(0);
    expect(textMotionAt({...animation, direction: 'out'}, .25, 0, 1).y).toBeCloseTo(-3);
  });

  it('scatters deterministically per identity and assembles or disperses at boundaries', () => {
    const animation = createTextAnimation({effect: 'scatter', easing: 'linear', easingDirection: 'in',
      duration: 1, seed: 23, distance: 50});
    const first = textMotionAt(animation, .25, 2, 5, 'title');
    expect(first).toEqual(textMotionAt(animation, .25, 2, 5, 'title'));
    expect(first).not.toEqual(textMotionAt(animation, .25, 3, 5, 'title'));
    expect(first).not.toEqual(textMotionAt({...animation, seed: 24}, .25, 2, 5, 'title'));
    expect(first).not.toEqual(textMotionAt(animation, .25, 2, 5, 'other'));
    expect(textMotionAt(animation, 1.24, 2, 5, 'title')).toEqual({x: 0, y: 0, scale: 1, rotation: 0, alpha: 1, reveal: 1});
    const outgoing = {...animation, direction: 'out' as const, stagger: 0};
    expect(textMotionAt(outgoing, 0, 2, 5, 'title')).toEqual({x: 0, y: 0, scale: 1, rotation: 0, alpha: 1, reveal: 1});
    expect(textMotionAt(outgoing, 1, 2, 5, 'title').alpha).toBe(0);
  });
});
