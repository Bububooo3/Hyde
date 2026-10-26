import { describe, expect, it } from 'vitest';
import { createElement, createProject } from './model';
import { canMoveLayers, moveLayers } from './layerOrder';

describe('layer ordering', () => {
  it('moves a multi-selection one sibling slot while preserving selected order', () => {
    const project = createProject();
    project.elements = ['A', 'B', 'C', 'D'].map(name => createElement('rectangle', { name }));
    const [a, , c] = project.elements;
    const moved = moveLayers(project, [a.id, c.id], 1);
    expect(moved.elements.map(element => element.name)).toEqual(['B', 'A', 'D', 'C']);
    expect(moveLayers(moved, [a.id, c.id], -1).elements.map(element => element.name)).toEqual(['A', 'B', 'C', 'D']);
    expect(project.elements.map(element => element.name)).toEqual(['A', 'B', 'C', 'D']);
    expect(canMoveLayers(moved, [c.id], 1)).toBe(false);
  });

  it('keeps assembly and folder scopes fixed and does not move locked neighbors', () => {
    const project = createProject();
    const group = createElement('group', { name: 'Group' });
    const a = createElement('rectangle', { name: 'A', parentId: group.id });
    const b = createElement('rectangle', { name: 'B', parentId: group.id });
    const other = createElement('rectangle', { name: 'Other' });
    const locked = createElement('rectangle', { name: 'Locked', locked: true });
    project.elements = [a, other, b, group, locked];
    expect(moveLayers(project, [a.id], 1).elements.map(element => element.name)).toEqual(['B', 'Other', 'A', 'Group', 'Locked']);
    expect(canMoveLayers(project, [group.id], 1)).toBe(false);
  });
});
