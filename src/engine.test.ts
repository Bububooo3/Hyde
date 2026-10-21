import { describe, expect, it } from 'vitest';
import { createElement, createProject, type EasingFamily, type Keyframe, type StoryElement } from './model';
import { ease, evaluateElement, evaluateProject, sourceTime, videoVisualExpired } from './engine';
import { createExampleProject } from './example';

const key = (time: number, value: number | string, patch: Partial<Keyframe> = {}): Keyframe => ({ id: `${time}-${value}`, time, value, easing: 'linear', direction: 'in', mode: 'smooth', ...patch });
const animated = (property: 'x' | 'rotation' | 'fill' | 'opacity', keys: Keyframe[], patch: Partial<StoryElement> = {}) => createElement('rectangle', { tracks: [{ property, keyframes: keys }], ...patch });

describe('easing families', () => {
  const families: EasingFamily[] = ['linear', 'sine', 'quad', 'cubic', 'quart', 'quint', 'expo', 'circ', 'back', 'bounce', 'elastic'];
  it.each(families)('%s is finite, endpoint-exact, and reflected for out', family => {
    for (const direction of ['in', 'out', 'inOut'] as const) {
      expect(ease(family, direction, 0)).toBe(0);
      expect(ease(family, direction, 1)).toBe(1);
      for (let i = 0; i <= 100; i++) expect(Number.isFinite(ease(family, direction, i / 100))).toBe(true);
    }
    expect(ease(family, 'out', .3)).toBeCloseTo(1 - ease(family, 'in', .7), 12);
    expect(ease(family, 'inOut', .5)).toBe(.5);
  });
  it('preserves overshoot while clamping input time', () => {
    expect(ease('back', 'out', .6)).toBeGreaterThan(1);
    expect(ease('elastic', 'in', -3)).toBe(0);
    expect(ease('quad', 'out', 4)).toBe(1);
  });
});

describe('local animation evaluation', () => {
  it('seeks using local time and holds endpoints without changing input order', () => {
    const element = animated('x', [key(4, 100), key(2, 20)], { start: 10, duration: 6 });
    const saved = JSON.stringify(element);
    expect(evaluateElement(element, 9.9)).toBeNull();
    expect(evaluateElement(element, 10)?.x).toBe(20);
    expect(evaluateElement(element, 13)?.x).toBe(60);
    expect(evaluateElement(element, 16)?.x).toBe(100);
    expect(evaluateElement(element, 16.001)).toBeNull();
    expect(evaluateElement(element, 13)?.x).toBe(60);
    expect(JSON.stringify(element)).toBe(saved);
  });
  it('switches held keys exactly at the next timestamp', () => {
    const element = animated('x', [key(0, 0, { mode: 'hold' }), key(2, 100)]);
    expect(evaluateElement(element, 1.999)?.x).toBe(0);
    expect(evaluateElement(element, 2)?.x).toBe(100);
  });
  it('crosses an interior smooth key without pausing, while preserving two-key easing', () => {
    const cubic = { easing: 'cubic' as const, direction: 'inOut' as const };
    const element = animated('x', [key(0, 0, cubic), key(1, 100, cubic), key(2, 200, cubic)]);
    const before = evaluateElement(element, .99)!.x;
    const at = evaluateElement(element, 1)!.x;
    const after = evaluateElement(element, 1.01)!.x;
    expect(at - before).toBeGreaterThan(.5);
    expect(after - at).toBeGreaterThan(.5);
    expect(at - before).toBeCloseTo(after - at, 1);

    const singleSpan = animated('x', [key(0, 0, cubic), key(1, 100)]);
    expect(evaluateElement(singleSpan, .25)?.x).toBeCloseTo(6.25, 6);
    const turn = animated('x', [key(0, 0, cubic), key(1, 100, cubic), key(2, 0, cubic)]);
    expect(evaluateElement(turn, .99)!.x).toBeLessThan(100);
    expect(evaluateElement(turn, 1.01)!.x).toBeLessThan(100);
    expect(100 - evaluateElement(turn, .99)!.x).toBeLessThan(.2);
  });
  it('uses step cadence per second without missing the endpoint', () => {
    const element = animated('x', [key(0, 0, { mode: 'stepped', steps: 4 }), key(2, 100)]);
    expect(evaluateElement(element, .49)?.x).toBe(12.5);
    expect(evaluateElement(element, .5)?.x).toBe(25);
    expect(evaluateElement(element, 2)?.x).toBe(100);
  });
  it('takes shortest angular paths and respects explicit complete turns', () => {
    expect(evaluateElement(animated('rotation', [key(0, 350), key(2, 10)]), 1)?.rotation).toBe(360);
    expect(evaluateElement(animated('rotation', [key(0, 0), key(2, 720)]), 1)?.rotation).toBe(360);
    const continued = animated('rotation', [key(0, 350), key(1, 10), key(2, 30)]);
    expect(evaluateElement(continued, .99)!.rotation).toBeLessThan(370);
    expect(evaluateElement(continued, 1)!.rotation).toBe(370);
    expect(evaluateElement(continued, 1.01)!.rotation).toBeGreaterThan(370);
  });
  it('interpolates color and clamps opacity under overshooting easing', () => {
    expect(evaluateElement(animated('fill', [key(0, '#000'), key(2, '#ffffff')]), 1)?.fill).toBe('#808080');
    expect(evaluateElement(animated('fill', [key(0, '#00000000'), key(2, '#ffffffff')]), 1)?.fill).toBe('rgba(128, 128, 128, 0.5)');
    const opacity = animated('opacity', [key(0, 0, { easing: 'back', direction: 'out' }), key(2, 1)]);
    expect(evaluateElement(opacity, 1.2)?.opacity).toBe(1);
  });
  it('handles duplicate keys, hidden elements, and invalid spans deterministically', () => {
    const element = animated('x', [key(0, 0), key(1, 10), key(1, 20)]);
    expect(evaluateElement(element, .5)?.x).toBe(10);
    expect(evaluateElement(element, 1)?.x).toBe(20);
    expect(evaluateElement({ ...element, hidden: true }, 1)).toBeNull();
    expect(evaluateElement({ ...element, duration: 0 }, 0)).toBeNull();
    expect(evaluateElement(element, NaN)).toBeNull();
  });
});

describe('assembly transforms and attachment limits', () => {
  it('resolves out-of-order descendants and composes world position, rotation, scale, opacity', () => {
    const parent = createElement('group', { id: 'parent', x: 100, y: 200, rotation: 90, scaleX: 2, scaleY: 2, opacity: .5 });
    const child = createElement('rectangle', { id: 'child', parentId: 'parent', x: 10, y: 5, rotation: 15, opacity: .8 });
    const project = { ...createProject(), elements: [child, parent] };
    const evaluated = evaluateProject(project, 1)[0];
    expect(evaluated.x).toBeCloseTo(90);
    expect(evaluated.y).toBeCloseTo(220);
    expect(evaluated.rotation).toBe(105);
    expect(evaluated.scaleX).toBe(2);
    expect(evaluated.opacity).toBeCloseTo(.4);
    expect(project.elements[0].x).toBe(10);
  });
  it('hinge pins position and clamps angle; slider pins rotation and perpendicular axis', () => {
    const parent = createElement('group', { id: 'root', x: 0, y: 0 });
    const hinge = createElement('rectangle', { id: 'hinge', x: 20, y: 30, attachment: { type: 'hinge', parentId: 'root', min: -90, max: 90 }, tracks: [{ property: 'x', keyframes: [key(0, 900)] }, { property: 'rotation', keyframes: [key(0, 120)] }] });
    const slider = createElement('rectangle', { id: 'slider', x: 10, y: 40, rotation: 20, attachment: { type: 'slider', parentId: 'root', min: 0, max: 50 }, tracks: [{ property: 'x', keyframes: [key(0, 200)] }, { property: 'y', keyframes: [key(0, 999)] }, { property: 'rotation', keyframes: [key(0, 100)] }] });
    const result = evaluateProject({ ...createProject(), elements: [parent, hinge, slider] }, 0);
    expect(result[1]).toMatchObject({ x: 20, y: 30, rotation: 90 });
    expect(result[2]).toMatchObject({ x: 60, y: 40, rotation: 20 });
  });
  it('suppresses cyclic, missing, and inactive parent branches while retaining unrelated objects', () => {
    const a = createElement('group', { id: 'a', parentId: 'b' });
    const b = createElement('group', { id: 'b', parentId: 'a' });
    const missing = createElement('rectangle', { parentId: 'missing' });
    const hidden = createElement('group', { id: 'hidden', hidden: true });
    const hiddenChild = createElement('rectangle', { parentId: 'hidden' });
    const good = createElement('rectangle', { id: 'good' });
    expect(evaluateProject({ ...createProject(), elements: [a, b, missing, hidden, hiddenChild, good] }, 1).map(element => element.id)).toEqual(['good']);
  });
});

describe('media timing and example integrity', () => {
  it('maps trimmed, retimed media and loops within the remaining source range', () => {
    const element = createElement('video', { start: 4, duration: 8, sourceOffset: 2, speed: 2 });
    expect(sourceTime(element, 3)).toBe(2);
    expect(sourceTime(element, 6)).toBe(6);
    expect(sourceTime(element, 20)).toBe(18);
    expect(sourceTime(element, 10, 10)).toBe(10);
    expect(sourceTime({ ...element, loop: true }, 9, 10)).toBe(4);
  });
  it('holds a finished video by default and hides it only on request', () => {
    const video = createElement('video', {start:4,duration:8,sourceOffset:2,speed:2});
    expect(videoVisualExpired(video,8,10)).toBe(false);
    const hidden = {...video,videoEndBehavior:'hide' as const};
    expect(videoVisualExpired(hidden,7.99,10)).toBe(false);
    expect(videoVisualExpired(hidden,8,10)).toBe(true);
    expect(videoVisualExpired({...hidden,loop:true},9,10)).toBe(false);
    expect(videoVisualExpired(hidden,8,Number.NaN)).toBe(false);
  });
  it('ships a self-contained example with a real hinge and reversible state', () => {
    const project = createExampleProject();
    const first = evaluateProject(project, 0);
    const middle = evaluateProject(project, 3);
    expect(middle.find(element => element.id === 'box-lid')?.rotation).toBe(-90);
    expect(first.find(element => element.id === 'box-lid')?.x).toBe(555);
    expect(evaluateProject(project, 0)).toEqual(first);
    const assets = new Set(project.assets.map(asset => asset.id));
    expect(project.elements.every(element => !element.assetId || assets.has(element.assetId))).toBe(true);
    expect(project.assets.every(asset => asset.dataUrl.startsWith('data:'))).toBe(true);
  });
});
