import { describe, expect, it } from 'vitest';
import { evaluateProject } from './engine';
import { createElement, createProject } from './model';
import { rotateSelectionAroundWorldPoint, rotatedWorldPivot } from './worldPointRotation';

describe('world point rotation', () => {
  it('moves pivots around a chosen point and turns the artwork', () => {
    const project = createProject(), element = createElement('rectangle',{x:120,y:100,rotation:10});
    project.elements=[element];
    const next=rotateSelectionAroundWorldPoint(project,[element.id],0,{x:100,y:100},90,false);
    expect(next.elements[0].x).toBeCloseTo(100);
    expect(next.elements[0].y).toBeCloseTo(120);
    expect(next.elements[0].rotation).toBeCloseTo(100);
    expect(project.elements[0].x).toBe(120);
    expect(rotatedWorldPivot({x:120,y:100},{x:100,y:100},90)).toEqual({x:100,y:120});
  });

  it('converts a child position through its rotated parent and does not rotate selected descendants twice', () => {
    const project=createProject();
    const parent=createElement('group',{x:100,y:100,rotation:90,width:0,height:0,pivotX:0,pivotY:0});
    const child=createElement('rectangle',{x:20,y:0,parentId:parent.id});
    project.elements=[parent,child];
    const moved=rotateSelectionAroundWorldPoint(project,[child.id],0,{x:100,y:100},90,false);
    expect(moved.elements[1].x).toBeCloseTo(0);
    expect(moved.elements[1].y).toBeCloseTo(20);
    expect(evaluateProject(moved,0).find(element=>element.id===child.id)?.x).toBeCloseTo(80);
    const together=rotateSelectionAroundWorldPoint(project,[parent.id,child.id],0,{x:100,y:100},90,false);
    expect(together.elements[1].x).toBe(20);
    expect(together.elements[1].rotation).toBe(0);
  });

  it('writes frame-aligned position and rotation keys without changing base values', () => {
    const project=createProject(), element=createElement('rectangle',{x:120,y:100,rotation:0,start:0,duration:4});
    project.elements=[element];
    const next=rotateSelectionAroundWorldPoint(project,[element.id],1.01,{x:100,y:100},90,true);
    expect(next.elements[0].x).toBe(120);
    expect(next.elements[0].tracks.map(track=>track.property).sort()).toEqual(['rotation','x','y']);
    expect(next.elements[0].tracks.every(track=>track.keyframes[0].time===1)).toBe(true);
    const pose=evaluateProject(next,1)[0];
    expect(pose.x).toBeCloseTo(100);
    expect(pose.y).toBeCloseTo(120);
    expect(pose.rotation).toBe(90);
    expect(()=>rotateSelectionAroundWorldPoint(next,[element.id],1,{x:100,y:100},15,false)).toThrow(/Auto key/);
  });

  it('rejects constrained parts that cannot move with their rotation', () => {
    const project=createProject(), parent=createElement('group'),child=createElement('rectangle',{attachment:{type:'hinge',parentId:parent.id}});
    project.elements=[parent,child];
    expect(()=>rotateSelectionAroundWorldPoint(project,[child.id],0,{x:0,y:0},20,false)).toThrow(/Detach/);
  });
});
