import { describe, expect, it } from 'vitest';
import { createElement } from './model';
import { editablePathForElement, movePathAnchor, pathPointToWorld, pointInShapePath, removePathPoint, setPathHandle, shapePathCommands, shapePathSvg, splitPathSegment, withEditablePath, worldToPathPoint } from './shapePath';

describe('editable closed paths', () => {
  it('converts a rectangle to straight normalized edges that follow resizing', () => {
    const element = createElement('rectangle', { width: 100, height: 50 });
    const path = editablePathForElement(element);
    expect(path.points).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
    expect(shapePathSvg(path, 100, 50)).toBe('M 0 0 L 100 0 L 100 50 L 0 50 L 0 0 Z');
    expect(shapePathSvg(path, 200, 100)).toBe('M 0 0 L 200 0 L 200 100 L 0 100 L 0 0 Z');
    expect(element.shapePath).toBeUndefined();
  });

  it('preserves legacy polygon vertices and creates four cubic ellipse edges', () => {
    const polygon = createElement('polygon', { width: 200, height: 100, points: [{ x: 100, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }] });
    expect(editablePathForElement(polygon).points).toEqual([{ x: .5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
    const ellipse = editablePathForElement(createElement('ellipse', { width: 200, height: 100 }));
    const commands = shapePathCommands(ellipse, 200, 100);
    expect(commands[0]).toEqual({ type: 'move', x: 100, y: 0 });
    expect(commands.filter(command => command.type === 'cubic')).toHaveLength(4);
    expect(commands[1]).toMatchObject({ type: 'cubic', x: 200, y: 50 });
    expect(commands.at(-1)).toEqual({ type: 'close' });
  });

  it('uses editable cubic handles for both geometry and SVG guides without modifying input', () => {
    const element = createElement('polygon', { width: 200, height: 100 });
    const editable = withEditablePath(element);
    editable.shapePath!.points[0].out = { x: .75, y: -.25 };
    editable.shapePath!.points[1].in = { x: 1.25, y: .25 };
    expect(shapePathCommands(editable.shapePath!, 200, 100)[1]).toEqual({
      type: 'cubic', x1: 150, y1: -25, x2: 250, y2: 25, x: 200, y: 100,
    });
    expect(shapePathSvg(editable.shapePath!, 200, 100)).toContain('C 150 -25 250 25 200 100');
    expect(element.shapePath).toBeUndefined();
    expect(withEditablePath(editable).shapePath).toEqual(editable.shapePath);
  });

  it('moves anchors with their handles and splits curved and closing edges without changing the outline', () => {
    const original = { points: [
      { x: 0, y: 0, out: { x: 0, y: 1 } },
      { x: 1, y: 0, in: { x: 1, y: 1 } },
      { x: 1, y: 1 },
    ] };
    const divided = splitPathSegment(original, 0);
    expect(divided.points[1]).toEqual({ x: .5, y: .75, in: { x: .25, y: .75 }, out: { x: .75, y: .75 } });
    expect(original.points).toHaveLength(3);
    const moved = movePathAnchor(divided, 1, .6, .6);
    expect(moved.points[1]).toEqual({ x: .6, y: .6, in: { x: .35, y: .6 }, out: { x: .85, y: .6 } });
    const straightened = setPathHandle(setPathHandle(moved, 1, 'in'), 0, 'out');
    expect(shapePathCommands(straightened, 100, 100)[1].type).toBe('line');
    expect(splitPathSegment(original, 2).points.at(-1)).toEqual({ x: .5, y: .5 });
  });

  it('maps handles through the evaluated stage pose and back', () => {
    const pose = createElement('polygon', { x: 365, y: 123, width: 180, height: 70, pivotX: .2, pivotY: .8, scaleX: -1.5, scaleY: .75, rotation: 37 });
    const local = { x: .93, y: -.2 };
    const world = pathPointToWorld(pose, local);
    const returned = worldToPathPoint(pose, world);
    expect(returned.x).toBeCloseTo(local.x, 10);
    expect(returned.y).toBeCloseTo(local.y, 10);
  });
  it('removes a selected vertex while keeping closed paths valid',()=>{
    const square=editablePathForElement(createElement('rectangle'));
    expect(removePathPoint(square,1).points).toHaveLength(3);
    expect(square.points).toHaveLength(4);
    expect(()=>removePathPoint(removePathPoint(square,1),0)).toThrow(/at least three/);
  });
  it('hit-tests the actual curved outline rather than its rectangular bounds',()=>{
    const ellipse=editablePathForElement(createElement('ellipse',{width:200,height:100}));
    expect(pointInShapePath(ellipse,200,100,100,50)).toBe(true);
    expect(pointInShapePath(ellipse,200,100,0,0)).toBe(false);
    expect(pointInShapePath(ellipse,200,100,199,99)).toBe(false);
  });
});
