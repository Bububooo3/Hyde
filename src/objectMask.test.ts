import { describe, expect, it } from 'vitest';
import { createElement, createProject } from './model';
import { duplicateElements, worldPoses } from './editing';
import { decodeProjectBytes, encodeProjectBytes } from './archive';
import { pruneObjectMasks, setObjectMask } from './objectMask';
import { duplicateScene } from './sceneOperations';
import { materializeScenePlacements, placeLinkedScene, makeSceneIndependent } from './scenePlacement';

describe('object masks', () => {
  it('keeps multiple references outside tracks and round trips through native archives', () => {
    const project = createProject();
    const target = createElement('rectangle'), first = createElement('ellipse'), second = createElement('polygon');
    project.elements = [target, first, second];
    const masked = setObjectMask(project, target.id, 'exclude', [first.id, second.id]);
    expect(masked.elements[0].objectMask).toEqual({ mode: 'exclude', objectIds: [first.id, second.id] });
    expect(masked.elements[0].tracks).toEqual(target.tracks);
    expect(decodeProjectBytes(encodeProjectBytes(masked)).elements[0].objectMask).toEqual(masked.elements[0].objectMask);
    expect(project.elements[0].objectMask).toBeUndefined();
  });

  it('rejects invalid refs and cycles, and prunes removed sources', () => {
    const project = createProject();
    const a = createElement('rectangle'), b = createElement('rectangle'), otherScene = createElement('ellipse', { sceneId: 'other' });
    project.elements = [a, b, otherScene];
    expect(() => setObjectMask(project, a.id, 'include', [a.id])).toThrow(/itself/);
    expect(() => setObjectMask(project, a.id, 'include', ['missing'])).toThrow(/existing/);
    expect(() => setObjectMask(project, a.id, 'include', [otherScene.id])).toThrow(/scene/);
    const masked = setObjectMask(project, a.id, 'include', [b.id]);
    expect(() => setObjectMask(masked, b.id, 'include', [a.id])).toThrow(/cycle/);
    pruneObjectMasks(masked, new Set([b.id]));
    expect(masked.elements[0].objectMask).toBeUndefined();
  });

  it('remaps mask sources copied with their target and keeps uncopied source references', () => {
    const project = createProject();
    const target = createElement('rectangle'), source = createElement('ellipse');
    project.elements = [target, source];
    const masked = setObjectMask(project, target.id, 'include', [source.id]);
    const both = duplicateElements(masked, [target.id, source.id]);
    expect(both.project.elements.find(element=>element.id===both.ids[0])?.objectMask?.objectIds).toEqual([both.ids[1]]);
    const targetOnly = duplicateElements(masked, [target.id]);
    expect(targetOnly.project.elements.find(element=>element.id===targetOnly.ids[0])?.objectMask?.objectIds).toEqual([source.id]);
  });
  it('remaps references in duplicated and linked scenes', () => {
    const project=createProject(),sceneId=project.sequences[0].id;
    const target=createElement('rectangle',{sceneId}),source=createElement('ellipse',{sceneId});
    project.elements=[target,source];
    const masked=setObjectMask(project,target.id,'include',[source.id]);
    const duplicate=duplicateScene(masked,sceneId);
    const copied=duplicate.project.elements.filter(element=>element.sceneId===duplicate.sceneId);
    expect(copied[0].objectMask?.objectIds).toEqual([copied[1].id]);
    const linked=placeLinkedScene(masked,sceneId,8);
    const virtual=materializeScenePlacements(linked.project).elements.filter(element=>element.sceneId===linked.sceneId);
    expect(virtual[0].objectMask?.objectIds).toEqual([virtual[1].id]);
    const independent=makeSceneIndependent(linked.project,linked.sceneId);
    const actual=independent.elements.filter(element=>element.sceneId===linked.sceneId);
    expect(actual[0].objectMask?.objectIds).toEqual([actual[1].id]);
  });
  it('evaluates animated source geometry while the relationship stays fixed', () => {
    const project=createProject(),sceneId=project.sequences[0].id;
    const target=createElement('rectangle',{sceneId});
    const source=createElement('ellipse',{sceneId,x:100,tracks:[{property:'x',keyframes:[
      {id:'start',time:0,value:100,easing:'linear',direction:'inOut',mode:'smooth'},
      {id:'end',time:2,value:300,easing:'linear',direction:'inOut',mode:'smooth'},
    ]}]});
    project.elements=[target,source];
    const masked=setObjectMask(project,target.id,'include',[source.id]);
    expect(worldPoses(masked,0).get(source.id)?.x).toBe(100);
    expect(worldPoses(masked,2).get(source.id)?.x).toBe(300);
    expect(masked.elements[0].objectMask).toEqual({mode:'include',objectIds:[source.id]});
  });
});
