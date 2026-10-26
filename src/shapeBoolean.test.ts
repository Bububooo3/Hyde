import { describe, expect, it } from 'vitest';
import { createElement, createProject } from './model';
import { booleanShapes } from './shapeBoolean';
import { pointInShapePath } from './shapePath';

describe('editable Boolean shapes', () => {
  it('unions, intersects, and subtracts overlapping rectangles with source geometry retained', () => {
    const project = createProject();
    const a = createElement('rectangle', { x: 100, y: 100, width: 100, height: 100 });
    const b = createElement('rectangle', { x: 150, y: 100, width: 100, height: 100 });
    project.elements = [a, b];
    const union = booleanShapes(project, [a.id, b.id], 'union', 0);
    const intersection = booleanShapes(project, [a.id, b.id], 'intersect', 0);
    const difference = booleanShapes(project, [a.id, b.id], 'negate', 0);
    expect(union.project.elements.at(-1)?.width).toBeCloseTo(150);
    expect(intersection.project.elements.at(-1)?.width).toBeCloseTo(50);
    expect(difference.project.elements.at(-1)?.width).toBeCloseTo(50);
    expect(union.project.elements.slice(0, 2).map(element => element.hidden)).toEqual([true, true]);
    expect(project.elements.map(element => element.hidden)).toEqual([undefined, undefined]);
    expect(union.project.elements[0].width).toBe(100);
  });

  it('creates a real editable hole and separates disconnected areas', () => {
    const project = createProject();
    const outer = createElement('rectangle', { x: 100, y: 100, width: 140, height: 140 });
    const inner = createElement('rectangle', { x: 100, y: 100, width: 50, height: 50 });
    project.elements = [outer, inner];
    const ring = booleanShapes(project, [outer.id, inner.id], 'negate', 0).project.elements.at(-1)!;
    expect(ring.shapePath?.holes).toHaveLength(1);
    expect(pointInShapePath(ring.shapePath!, ring.width, ring.height, ring.width / 2, ring.height / 2)).toBe(false);
    const separate = createProject();
    const left = createElement('rectangle', { x: 50, y: 50, width: 40, height: 40 });
    const right = createElement('rectangle', { x: 200, y: 50, width: 40, height: 40 });
    separate.elements = [left, right];
    const joined = booleanShapes(separate, [left.id, right.id], 'union', 0);
    expect(joined.resultIds).toHaveLength(1);
    const result = joined.project.elements.at(-1)!;
    expect(result.shapePath?.islands).toHaveLength(1);
    expect(pointInShapePath(result.shapePath!, result.width, result.height, 0, 20)).toBe(true);
    expect(pointInShapePath(result.shapePath!, result.width, result.height, 75, 20)).toBe(false);
    expect(pointInShapePath(result.shapePath!, result.width, result.height, 150, 20)).toBe(true);
    expect(booleanShapes(separate, [left.id, right.id], 'separate', 0).resultIds).toHaveLength(2);
  });

  it('leaves the project untouched for an empty intersection', () => {
    const project = createProject();
    const a = createElement('rectangle', { x: 50, y: 50, width: 20, height: 20 });
    const b = createElement('rectangle', { x: 200, y: 50, width: 20, height: 20 });
    project.elements = [a, b];
    expect(() => booleanShapes(project, [a.id, b.id], 'intersect', 0)).toThrow(/empty result/);
    expect(project.elements).toHaveLength(2);
  });

  it('keeps a subtraction that splits the primary shape in one editable result',()=>{
    const project=createProject();
    const primary=createElement('rectangle',{x:100,y:100,width:200,height:100});
    const cutter=createElement('rectangle',{x:100,y:100,width:40,height:140});
    project.elements=[primary,cutter];
    const difference=booleanShapes(project,[primary.id,cutter.id],'negate',0);
    expect(difference.resultIds).toHaveLength(1);
    expect(difference.project.elements.at(-1)?.shapePath?.islands).toHaveLength(1);
  });
});
