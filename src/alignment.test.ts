import { describe, expect, it } from 'vitest';
import { alignSelection } from './alignment';
import { createElement, createProject } from './model';

describe('alignSelection', () => {
  it('aligns visual bounds and shifts authored position keys with the object', () => {
    const project = createProject();
    const first = createElement('rectangle', { x: 100, y: 100, width: 100, height: 50 });
    const second = createElement('rectangle', { x: 300, y: 200, width: 80, height: 60,
      tracks: [{ property: 'x', keyframes: [
        { id: 'a', time: 0, value: 300, easing: 'linear', direction: 'inOut', mode: 'smooth' },
        { id: 'b', time: 2, value: 350, easing: 'linear', direction: 'inOut', mode: 'smooth' },
      ] }],
    });
    project.elements = [first, second];
    const result = alignSelection(project, [first.id, second.id], 0, 'left');
    expect(result.elements[1].x).toBe(90);
    expect(result.elements[1].tracks[0].keyframes.map(key => key.value)).toEqual([90, 140]);
    expect(project.elements[1].x).toBe(300);
  });

  it('distributes three objects by equal visible gaps', () => {
    const project = createProject();
    project.elements = [100, 300, 600].map(x => createElement('rectangle', { x, width: 100 }));
    const result = alignSelection(project, project.elements.map(element => element.id), 0, 'distributeX');
    expect(result.elements.map(element => element.x)).toEqual([100, 350, 600]);
  });

  it('converts stage-space changes through a rotated parent', () => {
    const project = createProject();
    const parent = createElement('group', { x: 100, y: 100, rotation: 90, width: 0, height: 0, pivotX: 0, pivotY: 0 });
    const child = createElement('rectangle', { x: 20, y: 0, width: 40, height: 20, pivotX: 0, pivotY: 0, parentId: parent.id });
    const other = createElement('rectangle', { x: 200, y: 100, width: 40, height: 20, pivotX: 0, pivotY: 0 });
    project.elements = [parent, child, other];
    const result = alignSelection(project, [child.id, other.id], 0, 'right');
    expect(result.elements[1].x).toBeCloseTo(20);
    expect(result.elements[1].y).toBeCloseTo(-140);
    expect(result.elements[2].x).toBe(200);
  });

  it('rejects locked and constrained objects', () => {
    const project = createProject();
    const a = createElement('rectangle', { locked: true });
    const b = createElement('rectangle');
    project.elements = [a, b];
    expect(() => alignSelection(project, [a.id, b.id], 0, 'top')).toThrow(/Unlock/);
  });
});
