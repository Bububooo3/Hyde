import { describe, expect, it } from 'vitest';
import { assignSceneOwnership,createElement, createProject, type Project } from './model';
import { deleteScene, duplicateScene, moveScene, retimeScene } from './sceneOperations';

function story(): Project {
  const project = createProject('Scenes');
  project.duration = 7;
  project.sequences = [
    { id: 'first', name: 'Opening', start: 0, duration: 2, color: '#111111' },
    { id: 'middle', name: 'Paper box', start: 2, duration: 3, color: '#ffc857' },
    { id: 'last', name: 'End', start: 5, duration: 2, color: '#222222' },
  ];
  project.assets = [{ id: 'texture', name: 'paper.png', mime: 'image/png', kind: 'image', dataUrl: 'data:image/png;base64,AQ==' }];
  project.folders = [{ id: 'props', name: 'Props' }];
  project.elements = [
    createElement('text', { id: 'opening', start: 0, duration: 2 }),
    createElement('group', { id: 'box', start: 2, duration: 3, folderId: 'props' }),
    createElement('rectangle', {
      id: 'lid', name: 'Lid', start: 2.2, duration: 2.4, parentId: 'box',
      attachment: { type: 'hinge', parentId: 'box', min: -90, max: 90 },
      assetId: 'texture', folderId: 'props',
      tracks: [{ property: 'rotation', keyframes: [
        { id: 'lid-key', time: .5, value: 35, easing: 'quad', direction: 'inOut', mode: 'smooth' },
      ] }],
    }),
    createElement('audio', { id: 'voice', start: 3, duration: 1, speed: 1 }),
    createElement('ellipse', { id: 'ending', start: 5.2, duration: 1 }),
  ];
  project.captions = [
    { id: 'middle-caption', start: 2.25, end: 3.25, text: 'Hello' },
    { id: 'last-caption', start: 5.5, end: 6, text: 'Bye' },
  ];
  return project;
}

describe('scene operations', () => {
  it('assigns legacy content deterministically in overlaps without splitting an assembly',()=>{
    const original=story();original.sequences[2].start=4.5;
    original.elements.find(element=>element.id==='lid')!.start=4.6;
    original.elements.find(element=>element.id==='ending')!.start=4.6;
    original.elements.push(createElement('text',{id:'gap',start:8,duration:1}));
    const assigned=assignSceneOwnership(original);
    expect(assigned.elements.find(element=>element.id==='box')?.sceneId).toBe('middle');
    expect(assigned.elements.find(element=>element.id==='lid')?.sceneId).toBe('middle');
    expect(assigned.elements.find(element=>element.id==='ending')?.sceneId).toBe('last');
    expect(assigned.elements.find(element=>element.id==='gap')?.sceneId).toBeUndefined();
    expect(original.elements.every(element=>element.sceneId===undefined)).toBe(true);
  });
  it('copies camera keys with new identities and retimes them with their scene', () => {
    const original = story();
    original.sequences[1].camera = {x:480,y:270,zoom:1,rotation:0,tracks:[
      {property:'x',keyframes:[{id:'camera-x',time:1,value:600,easing:'linear',direction:'inOut',mode:'smooth'}]},
    ]};
    const copied=duplicateScene(original,'middle').project;
    expect(copied.sequences[2].camera?.tracks[0].keyframes[0]).toMatchObject({time:1,value:600});
    expect(copied.sequences[2].camera?.tracks[0].keyframes[0].id).not.toBe('camera-x');
    const retimed=retimeScene(original,'middle',6);
    expect(retimed.sequences[1].camera?.tracks[0].keyframes[0].time).toBe(2);
    expect(original.sequences[1].camera?.tracks[0].keyframes[0].time).toBe(1);
  });
  it('duplicates an entire timed scene after itself with independent object, parent and key IDs', () => {
    const original = story(), before = structuredClone(original);
    const { project, sceneId, start } = duplicateScene(original, 'middle');
    expect(original).toEqual(before);
    expect(start).toBe(5);
    expect(project.sequences.map(scene => [scene.id, scene.start, scene.duration])).toEqual([
      ['first', 0, 2], ['middle', 2, 3], [sceneId, 5, 3], ['last', 8, 2],
    ]);
    expect(project.sequences[2].name).toBe('Paper box copy');
    const copies = project.elements.filter(element => !before.elements.some(old => old.id === element.id));
    expect(copies).toHaveLength(3);
    const box = copies.find(element => element.kind === 'group')!;
    const lid = copies.find(element => element.name === 'Lid')!;
    expect(box.start).toBe(5);
    expect(lid.start).toBeCloseTo(5.2);
    expect(lid.parentId).toBe(box.id);
    expect(lid.attachment?.parentId).toBe(box.id);
    expect(lid.tracks[0].keyframes[0]).toMatchObject({ time: .5, value: 35 });
    expect(lid.tracks[0].keyframes[0].id).not.toBe('lid-key');
    expect(lid.assetId).toBe('texture');
    expect(lid.folderId).toBe('props');
    expect(project.assets).toEqual(original.assets);
    expect(project.elements.find(element => element.id === 'ending')?.start).toBeCloseTo(8.2);
    expect(project.captions.map(caption => caption.start)).toEqual([2.25, 8.5, 5.25]);
    expect(new Set(project.captions.map(caption => caption.id)).size).toBe(3);
    expect(project.duration).toBe(10);
  });

  it('deletes only the selected scene’s content and closes its interval', () => {
    const original = story(), before = structuredClone(original);
    const project = deleteScene(original, 'middle');
    expect(original).toEqual(before);
    expect(project.sequences.map(scene => [scene.id, scene.start])).toEqual([['first', 0], ['last', 2]]);
    expect(project.elements.map(element => element.id)).toEqual(['opening', 'ending']);
    expect(project.elements.find(element => element.id === 'ending')?.start).toBeCloseTo(2.2);
    expect(project.captions).toEqual([{ id: 'last-caption', start: 2.5, end: 3, text: 'Bye',sceneId:'last' }]);
    expect(project.assets).toEqual(original.assets);
    expect(project.duration).toBe(4);
  });

  it('moves a contiguous scene before another while keeping each scene’s internal timing', () => {
    const original = story(), before = structuredClone(original);
    const project = moveScene(original, 'middle', 'first');
    expect(original).toEqual(before);
    expect(project.sequences.map(scene => [scene.id, scene.start])).toEqual([
      ['middle', 0], ['first', 3], ['last', 5],
    ]);
    expect(project.elements.find(element => element.id === 'box')?.start).toBe(0);
    expect(project.elements.find(element => element.id === 'lid')?.start).toBeCloseTo(.2);
    expect(project.elements.find(element => element.id === 'opening')?.start).toBe(3);
    expect(project.elements.find(element => element.id === 'ending')?.start).toBeCloseTo(5.2);
    expect(project.elements.find(element => element.id === 'lid')?.tracks[0].keyframes[0].time).toBe(.5);
    expect(project.captions.map(caption => caption.start)).toEqual([.25, 5.5]);
    expect(project.duration).toBe(7);
    const toEnd = moveScene(original, 'middle');
    expect(toEnd.sequences.map(scene => [scene.id, scene.start])).toEqual([
      ['first', 0], ['last', 2], ['middle', 4],
    ]);
    expect(toEnd.elements.find(element => element.id === 'box')?.start).toBe(4);
    expect(toEnd.elements.find(element => element.id === 'ending')?.start).toBeCloseTo(2.2);
  });

  it('retimes one scene, its local keys and media playback, and ripples later scenes', () => {
    const original = story(), before = structuredClone(original);
    const project = retimeScene(original, 'middle', 4.5);
    expect(original).toEqual(before);
    expect(project.sequences.map(scene => [scene.id, scene.start, scene.duration])).toEqual([
      ['first', 0, 2], ['middle', 2, 4.5], ['last', 6.5, 2],
    ]);
    const lid = project.elements.find(element => element.id === 'lid')!;
    expect(lid.start).toBeCloseTo(2.3);
    expect(lid.duration).toBeCloseTo(3.6);
    expect(lid.tracks[0].keyframes[0].time).toBe(.75);
    expect(project.elements.find(element => element.id === 'voice')).toMatchObject({ start: 3.5, duration: 1.5, speed: 2 / 3 });
    expect(project.elements.find(element => element.id === 'ending')?.start).toBeCloseTo(6.7);
    expect(project.captions.map(caption => [caption.start, caption.end])).toEqual([[2.375, 3.875], [7, 7.5]]);
    expect(project.duration).toBe(8.5);
    const textured = story();
    textured.assets.push({ id: 'moving-texture', name: 'texture.webm', mime: 'video/webm', kind: 'video', dataUrl: 'data:video/webm;base64,AQ==' });
    textured.elements.find(element => element.id === 'lid')!.assetId = 'moving-texture';
    expect(retimeScene(textured, 'middle', 4.5).elements.find(element => element.id === 'lid')?.speed).toBeCloseTo(2 / 3);
  });

  it('uses explicit ownership through overlaps and crossing clips while rejecting shared assemblies and invalid durations', () => {
    const overlap = story(); overlap.sequences[2].start = 4.9;
    expect(duplicateScene(overlap, 'middle').project.elements.filter(element=>element.sceneId==='middle')).toHaveLength(3);

    const crossing = story(); crossing.elements.find(element => element.id === 'lid')!.duration = 3;
    expect(duplicateScene(crossing, 'middle').project.elements.filter(element=>element.name==='Lid')).toHaveLength(2);
    expect(deleteScene(crossing, 'middle').elements.some(element=>element.id==='lid')).toBe(false);

    const shared = story(); shared.elements.find(element => element.id === 'ending')!.parentId = 'box';shared.elements.find(element => element.id === 'ending')!.sceneId='last';
    expect(() => deleteScene(shared, 'middle')).toThrow('shares an assembly');
    expect(() => duplicateScene(shared, 'middle')).toThrow('shares an assembly');

    expect(() => deleteScene(createProject(), createProject().sequences[0].id)).toThrow('no longer exists');
    const single = createProject();
    expect(() => deleteScene(single, single.sequences[0].id)).toThrow('at least one scene');
    expect(() => retimeScene(story(), 'middle', .001)).toThrow('at least one project frame');
    expect(() => retimeScene(story(), 'middle', 20)).toThrow('0.25×–4×');
  });
  it('does not extend the story with content hidden beyond a scene boundary',()=>{
    const project=createProject();const scene=project.sequences[0];scene.duration=4;project.duration=4;
    project.elements.push(createElement('rectangle',{id:'crossing',sceneId:scene.id,start:0,duration:8}));
    const shorter=retimeScene(project,scene.id,2);
    expect(shorter.elements[0].duration).toBe(4);
    expect(shorter.duration).toBe(2);
  });
});
