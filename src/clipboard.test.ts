import { describe, expect, it } from 'vitest';
import { copyObjects, pasteObjects } from './clipboard';
import { evaluateProject } from './engine';
import { createElement, createProject } from './model';

describe('object clipboard', () => {
  it('remaps an attached subtree and its asset into another project at the playhead', () => {
    const source = createProject('Source');
    source.assets.push({ id: 'paper', name: 'paper.png', kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,AQIDBA==' });
    source.elements.push(createElement('rectangle', { id: 'outside', x: 320, y: 240, width: 80, height: 80, duration: 8 }));
    source.elements.push(createElement('ellipse', {
      id: 'chosen', name: 'Chosen part', x: 45, y: 12, width: 40, height: 40,
      parentId: 'outside', assetId: 'paper', duration: 8,
    }));
    const original = evaluateProject(source, 2).find(element => element.id === 'chosen')!;
    const clipboard = copyObjects(source, ['chosen'], 2);
    const target = createProject('Target');
    const result = pasteObjects(target, clipboard, 3);
    expect(result.ids).toHaveLength(1);
    expect(result.project.assets).toHaveLength(1);
    expect(result.project.elements).toHaveLength(2); // chosen part and its sampled external frame
    const pasted = result.project.elements.find(element => element.id === result.ids[0])!;
    expect(pasted.id).not.toBe('chosen');
    expect(pasted.parentId).toBeTruthy();
    expect(pasted.assetId).toBe(result.project.assets[0].id);
    expect(pasted.start).toBe(3);
    expect(pasted.sceneId).toBe(target.sequences[0].id);
    const world = evaluateProject(result.project, 3).find(element => element.id === pasted.id)!;
    expect(world.x).toBeCloseTo(original.x + 24);
    expect(world.y).toBeCloseTo(original.y + 24);
  });

  it('keeps selected hierarchy and independent identities across repeated pastes', () => {
    const project = createProject('Repeated');
    project.elements.push(createElement('rectangle', { id: 'root', x: 100, y: 100, duration: 8 }));
    project.elements.push(createElement('ellipse', { id: 'child', parentId: 'root', x: 15, y: 20, duration: 8 }));
    const clipboard = copyObjects(project, ['root', 'child'], 0);
    const first = pasteObjects(project, clipboard, 1);
    const second = pasteObjects(first.project, clipboard, 1, 2);
    expect(first.ids).toHaveLength(2);
    expect(second.ids).toHaveLength(2);
    expect(new Set([...first.ids, ...second.ids]).size).toBe(4);
    expect(first.project.elements.find(element => element.id === first.ids[1])?.parentId).toBe(first.ids[0]);
    expect(second.project.elements.find(element => element.id === second.ids[1])?.parentId).toBe(second.ids[0]);
    const firstRoot = evaluateProject(second.project, 1).find(element => element.id === first.ids[0])!;
    const secondRoot = evaluateProject(second.project, 1).find(element => element.id === second.ids[0])!;
    expect(secondRoot.x - firstRoot.x).toBeCloseTo(24);
    expect(secondRoot.y - firstRoot.y).toBeCloseTo(24);
  });
});
