import { describe, expect, it } from 'vitest';
import { createElement, createProject, type Keyframe, type Project } from './model';
import { evaluateProject } from './engine';
import { createExampleProject } from './example';
import {mediaAudioSegments} from './mediaAudioSegments';
import { descendantIds, duplicateElements, insertAssemblyAt, makeAssembly, parentId, reparentElement, translateAssemblyTime } from './editing';

const key = (time: number, value: number): Keyframe => ({ id: crypto.randomUUID(), time, value, easing: 'linear', direction: 'in', mode: 'smooth' });
function hierarchy(): Project {
  const project = createProject();
  project.elements = [
    createElement('group', { id: 'root', name: 'Root', x: 100, y: 200, start: 2, duration: 4 }),
    createElement('rectangle', { id: 'child', name: 'Child', x: 20, y: 30, start: 3, duration: 3, attachment: { type: 'hinge', parentId: 'root', min: -90, max: 90 }, tracks: [{ property: 'rotation', keyframes: [key(0, 0), key(2, 60)] }] }),
    createElement('ellipse', { id: 'grandchild', x: 5, y: 10, start: 3.5, duration: 2, parentId: 'child' }),
    createElement('rectangle', { id: 'second-root', name: 'Second', x: 300, y: 400, start: 4, duration: 2 }),
  ];
  return project;
}

describe('hierarchy references', () => {
  it('includes attachment-only descendants and nested children exactly once', () => {
    const project = hierarchy();
    expect(parentId(project.elements[1])).toBe('root');
    expect([...descendantIds(project, ['root', 'child', 'missing'])]).toEqual(['root', 'child', 'grandchild']);
  });
});

describe('portable assembly editing', () => {
  it('captures an immutable origin for multiple roots and normalizes time across all parts', () => {
    const project = hierarchy(), before = structuredClone(project);
    const assembly = makeAssembly(project, ['root', 'second-root']);
    expect(assembly.elements.find(element => element.id === 'root')).toMatchObject({ x: 0, y: 0, start: 0 });
    expect(assembly.elements.find(element => element.id === 'second-root')).toMatchObject({ x: 200, y: 200, start: 2 });
    expect(assembly.elements.find(element => element.id === 'child')).toMatchObject({ x: 20, y: 30, start: 1, attachment: { parentId: 'root' } });
    expect(assembly.elements.find(element => element.id === 'grandchild')?.start).toBe(1.5);
    expect(project).toEqual(before);
  });
  it('preserves an externally attached animated part with a sampled frame and no dangling references', () => {
    const project = hierarchy();
    project.elements[0].rotation = 90;
    const assembly = makeAssembly(project, ['child'], 3);
    expect(assembly.elements).toHaveLength(3);
    const child = assembly.elements.find(element => element.id === 'child')!;
    const frame = assembly.elements.find(element => element.name.endsWith('export frame'))!;
    expect(child.attachment?.parentId).toBe(frame.id);
    expect(frame.rotation).toBe(90);
    const ids = new Set(assembly.elements.map(element => element.id));
    expect(assembly.elements.every(element => !parentId(element) || ids.has(parentId(element)!))).toBe(true);
    const copiedScene = { ...createProject(), elements: assembly.elements };
    const first = evaluateProject(copiedScene, 0).find(element => element.id === 'child')!;
    const later = evaluateProject(copiedScene, 2).find(element => element.id === 'child')!;
    expect(first.x).toBeCloseTo(0);
    expect(first.y).toBeCloseTo(0);
    expect(later.rotation).toBe(150);
  });
  it('samples a future parent at local time zero when exporting before its start', () => {
    const project = hierarchy();
    project.elements[0].start = 5;
    project.elements[0].tracks = [{ property: 'x', keyframes: [key(0, 100), key(2, 500)] }];
    const assembly = makeAssembly(project, ['child'], 1);
    const frame = assembly.elements.find(element => element.name.endsWith('export frame'))!;
    // Parent x=100 and child x=20 are sampled at local zero. The immutable
    // selected-child origin is x=120, so the exported frame must be at -20.
    expect(frame.x).toBe(-20);
    expect(assembly.elements.find(element => element.id === 'child')?.x).toBe(20);
  });
  it('offsets position tracks along with their root base position', () => {
    const project = createProject();
    project.elements = [createElement('rectangle', { id: 'moving', x: 100, y: 40, tracks: [{ property: 'x', keyframes: [key(0, 100), key(2, 200)] }] })];
    const assembly = makeAssembly(project, ['moving'], 0);
    expect(assembly.elements[0].x).toBe(0);
    expect(assembly.elements[0].tracks[0].keyframes.map(frame => frame.value)).toEqual([0, 100]);
  });
  it('inserts centered complete subtrees, remaps references, and extends the timeline', () => {
    const original = hierarchy();
    const assembly = makeAssembly(original, ['root', 'second-root']);
    const project = createProject(), before = structuredClone(project), source = structuredClone(assembly);
    const inserted = insertAssemblyAt(project, assembly, 7);
    const root = inserted.elements.find(element => element.name === 'Root')!;
    const child = inserted.elements.find(element => element.name === 'Child')!;
    const second = inserted.elements.find(element => element.name === 'Second')!;
    expect(root).toMatchObject({ x: 960, y: 540, start: 7 });
    expect(child).toMatchObject({ x: 20, y: 30, start: 8, attachment: { parentId: root.id } });
    expect(second).toMatchObject({ x: 1160, y: 740, start: 9 });
    expect(inserted.duration).toBe(11);
    expect(inserted.sequences[0].duration).toBe(11);
    expect(project).toEqual(before);
    expect(assembly).toEqual(source);
  });
  it('includes only required assets and preserves the paper-box hinge on roundtrip insertion', () => {
    const example = createExampleProject();
    const assembly = makeAssembly(example, ['box-body']);
    expect(assembly.assets).toHaveLength(1);
    const next = insertAssemblyAt(createProject(), assembly, 0);
    const body = next.elements.find(element => element.name === 'Paper Box · body')!;
    const lid = next.elements.find(element => element.name === 'Paper Box · hinged lid')!;
    expect(parentId(lid)).toBe(body.id);
    expect(evaluateProject(next, 3).find(element => element.id === lid.id)).toMatchObject({ x: 841, y: 470, rotation: -90 });
  });
  it('carries attached audio as an ordinary editable lane in a portable assembly',()=>{
    const source=createProject();
    source.assets.push({id:'tone',name:'tone.wav',mime:'audio/wav',kind:'audio',dataUrl:'data:audio/wav;base64,AA==',duration:2});
    source.elements=[
      createElement('group',{id:'assembly',name:'Speaking assembly',start:0,duration:3}),
      createElement('audio',{id:'voice',name:'Voice',parentId:'assembly',assetId:'tone',start:1,duration:2,volume:.6}),
    ];
    const assembly=makeAssembly(source,['assembly']);
    expect(assembly.elements.map(element=>element.name)).toEqual(['Speaking assembly','Voice']);
    expect(assembly.assets.map(asset=>asset.name)).toEqual(['tone.wav']);
    const inserted=insertAssemblyAt(createProject(),assembly,4);
    const voice=inserted.elements.find(element=>element.name==='Voice')!;
    expect(voice).toMatchObject({start:5,duration:2,volume:.6});
    expect(inserted.elements.find(element=>element.id===voice.parentId)?.name).toBe('Speaking assembly');
    expect(mediaAudioSegments(inserted,0,inserted.duration).map(segment=>[segment.element.name,segment.start,segment.end]))
      .toEqual([['Voice',5,7]]);
  });
});

describe('independent duplication', () => {
  it('duplicates attachment descendants, remaps key IDs, and offsets only roots', () => {
    const project = hierarchy(), before = structuredClone(project);
    const result = duplicateElements(project, ['root']);
    const copies = result.project.elements.filter(element => result.ids.includes(element.id));
    expect(copies).toHaveLength(3);
    expect(copies[0]).toMatchObject({ x: 124, y: 224 });
    expect(copies[1]).toMatchObject({ x: 20, y: 30, attachment: { parentId: copies[0].id } });
    expect(copies[2].parentId).toBe(copies[1].id);
    expect(copies[1].tracks[0].keyframes[0].id).not.toBe(project.elements[1].tracks[0].keyframes[0].id);
    expect(project).toEqual(before);
  });
  it('keeps a duplicated child under its external parent with a world-space offset', () => {
    const project = hierarchy();
    project.elements[0].rotation = 90;
    project.elements[0].scaleX = project.elements[0].scaleY = 2;
    const result = duplicateElements(project, ['child']);
    const original = evaluateProject(project, 3).find(element => element.id === 'child')!;
    const copy = evaluateProject(result.project, 3).find(element => element.id === result.ids[0])!;
    expect(parentId(copy)).toBe('root');
    expect(copy.x - original.x).toBeCloseTo(24);
    expect(copy.y - original.y).toBeCloseTo(24);
  });
  it('shifts root position keys so animated copies remain visibly offset', () => {
    const project = createProject();
    project.elements = [createElement('rectangle', { id: 'moving', x: 100, tracks: [{ property: 'x', keyframes: [key(0, 100), key(2, 200)] }] })];
    const result = duplicateElements(project, ['moving']);
    expect(evaluateProject(result.project, 1).map(element => element.x)).toEqual([150, 174]);
  });
});

describe('safe reparenting', () => {
  it('converts world pose into a new rotated and scaled parent without a jump', () => {
    const project = createProject();
    project.elements = [
      createElement('group', { id: 'parent', x: 100, y: 200, rotation: 90, scaleX: 2, scaleY: 2 }),
      createElement('rectangle', { id: 'item', x: 140, y: 250, rotation: 30, scaleX: .5, scaleY: .75, opacity: .8 }),
    ];
    const before = structuredClone(project);
    const next = reparentElement(project, 'item', 'parent', 2);
    const child = next.elements[1];
    expect(child.x).toBeCloseTo(25);
    expect(child.y).toBeCloseTo(-20);
    expect(child.rotation).toBe(-60);
    expect(child.scaleX).toBe(.25);
    const pose = evaluateProject(next, 2)[1];
    expect(pose.x).toBeCloseTo(140);
    expect(pose.y).toBeCloseTo(250);
    expect(pose.rotation).toBe(30);
    expect(pose.scaleY).toBe(.75);
    expect(pose.opacity).toBe(.8);
    expect(project).toEqual(before);
  });
  it('detaches an attachment-only object preserving its constrained world angle', () => {
    const project = hierarchy();
    project.elements[1].tracks = [];
    project.elements[1].rotation = 120;
    const next = reparentElement(project, 'child', undefined, 3);
    expect(next.elements[1]).toMatchObject({ x: 120, y: 230, rotation: 90 });
    expect(parentId(next.elements[1])).toBeUndefined();
    expect(next.elements[1].attachment).toBeUndefined();
  });
  it('rejects cycles and animated coordinate-space changes with useful messages', () => {
    const project = hierarchy();
    expect(() => reparentElement(project, 'root', 'grandchild', 3)).toThrow('cycle');
    expect(() => reparentElement(project, 'child', undefined, 3)).toThrow('animation baking');
    project.elements[0].tracks = [{ property: 'x', keyframes: [key(0, 100), key(2, 200)] }];
    expect(() => reparentElement(project, 'second-root', 'root', 4)).toThrow('animation baking');
  });
  it('rejects zero-scale and unattainable opacity instead of silently changing the result', () => {
    const project = hierarchy();
    project.elements[0].scaleX = 0;
    expect(() => reparentElement(project, 'second-root', 'root', 4)).toThrow('zero-scale');
    project.elements[0].scaleX = 1;
    project.elements[0].opacity = .3;
    expect(() => reparentElement(project, 'second-root', 'root', 4)).toThrow('too transparent');
  });
});

describe('assembly timeline movement', () => {
  it('shifts all descendant starts while preserving relative offsets and local keys', () => {
    const project = hierarchy(), before = structuredClone(project);
    const moved = translateAssemblyTime(project, 'root', 7);
    expect(moved.elements.map(element => element.start)).toEqual([7, 8, 8.5, 4]);
    expect(moved.elements[1].tracks).toEqual(project.elements[1].tracks);
    expect(moved.duration).toBe(11);
    expect(project).toEqual(before);
  });
  it('rejects a move that would put an earlier child before zero', () => {
    const project = hierarchy();
    project.elements[1].start = 0;
    expect(() => translateAssemblyTime(project, 'root', 1)).toThrow('before the beginning');
  });
});
