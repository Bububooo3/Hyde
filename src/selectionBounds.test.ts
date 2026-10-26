import { expect, it } from 'vitest';
import { evaluateProject } from './engine';
import { createElement, createProject } from './model';
import { selectionBounds } from './selectionBounds';

it('encloses nested animated assembly children at the sampled playhead', () => {
  const project = createProject();
  const group = createElement('group', { x: 400, y: 300, start: 0, duration: 8 });
  const child = createElement('rectangle', { parentId: group.id, x: 20, y: 0, width: 100, height: 60, start: 0, duration: 8,
    tracks: [{ property: 'x', keyframes: [
      { id: 'a', time: 0, value: 20, easing: 'linear', direction: 'inOut', mode: 'smooth' },
      { id: 'b', time: 4, value: 120, easing: 'linear', direction: 'inOut', mode: 'smooth' },
    ] }],
  });
  project.elements = [group, child];
  const atZero = selectionBounds(project, evaluateProject(project, 0), group.id)!;
  const atFour = selectionBounds(project, evaluateProject(project, 4), group.id)!;
  expect(atZero.width).toBe(100);
  expect(atFour.width).toBe(100);
  expect(atFour.x - atZero.x).toBeCloseTo(100);
  expect(selectionBounds(project, evaluateProject(project, 4), child.id)?.x).toBeCloseTo(atFour.x);
});
