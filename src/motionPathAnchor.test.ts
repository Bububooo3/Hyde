import { describe, expect, it } from 'vitest';
import { createElement, createProject } from './model';
import { createMotionBehavior } from './motion';
import { motionPathLocalAnchor, motionPathWorldAnchor } from './motionPathAnchor';

describe('motion path guide anchoring', () => {
  it('keeps the path fixed while the same object has changing x keys', () => {
    const project = createProject('Path');
    const path = createMotionBehavior('followPath', 4);
    const element = createElement('rectangle', {
      id: 'moving', x: 100, y: 90, duration: 4, motionBehaviors: [path],
      tracks: [{ property: 'x', keyframes: [
        { id: 'start', time: 0, value: 100, easing: 'linear', direction: 'inOut', mode: 'smooth' },
        { id: 'end', time: 4, value: 400, easing: 'linear', direction: 'inOut', mode: 'smooth' },
      ] }],
    });
    project.elements = [element];
    expect(motionPathLocalAnchor(project, element, path)).toEqual({ x: 100, y: 90 });
    expect(motionPathWorldAnchor(motionPathLocalAnchor(project, element, path), null)).toEqual({ x: 100, y: 90 });
  });

  it('follows an animated parent without inheriting a child clip offset', () => {
    const project = createProject('Parent');
    const path = createMotionBehavior('followPath', 4);
    const parent = createElement('group', { id: 'parent', x: 50, y: 30, duration: 4 });
    const child = createElement('rectangle', { id: 'child', parentId: parent.id, x: 20, y: 10, duration: 4, motionBehaviors: [path] });
    project.elements = [parent, child];
    const local = motionPathLocalAnchor(project, child, path);
    expect(local.x).toBeCloseTo(20);
    expect(local.y).toBeCloseTo(10);
    expect(motionPathWorldAnchor(local, { ...parent, x: 150, y: 80 })).toEqual({ x: 170, y: 90 });
  });
});
