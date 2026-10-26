import { describe, expect, it } from 'vitest';
import { applyBulkProperty } from './bulkEditing';
import { worldPoses } from './editing';
import { createElement, createProject } from './model';

describe('bulk property edits', () => {
  it('moves nested elements in stage coordinates, skips constraints, and leaves input untouched', () => {
    const project = createProject();
    const parent = createElement('group', { x: 400, y: 300, rotation: 90, scaleX: 2, scaleY: 1 });
    const child = createElement('polygon', { x: 20, y: 30, width: 100, height: 80, parentId: parent.id });
    const locked = createElement('rectangle', { x: 100, locked: true });
    project.elements = [parent, child, locked];
    const before = worldPoses(project, 0).get(child.id)!;
    const result = applyBulkProperty(project, [child.id, locked.id], 'x', 35, 'relative', 0);
    expect(worldPoses(result.project, 0).get(child.id)!.x).toBeCloseTo(before.x + 35);
    expect(worldPoses(result.project, 0).get(child.id)!.y).toBeCloseTo(before.y);
    expect(result.skipped).toEqual([{ id: locked.id, reason: 'locked' }]);
    expect(project.elements[1].x).toBe(20);
  });

  it('resizes mixed polygon dimensions and sets one shared color without modifying unsupported objects', () => {
    const project = createProject();
    const first = createElement('polygon', { width: 100, height: 80, points: [{ x: 50, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }] });
    const second = createElement('rectangle', { width: 170 });
    const audio = createElement('audio');
    project.elements = [first, second, audio];
    const resized = applyBulkProperty(project, [first.id, second.id, audio.id], 'width', 30, 'relative', 0);
    expect(resized.project.elements.map(element => element.width)).toEqual([130, 200, audio.width]);
    expect(resized.project.elements[0].shapePath?.points[0].x).toBe(.5);
    expect(resized.skipped).toEqual([{ id: audio.id, reason: 'no editable dimensions' }]);
    const filled = applyBulkProperty(resized.project, [first.id, second.id, audio.id], 'fill', '#123456', 'absolute', 0);
    expect(filled.project.elements.slice(0, 2).map(element => element.fill)).toEqual(['#123456', '#123456']);
    expect(filled.skipped).toEqual([{ id: audio.id, reason: 'no visual appearance' }]);
  });
});
