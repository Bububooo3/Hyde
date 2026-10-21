import { describe, expect, it } from 'vitest';
import { createElement, createProject, type Project } from './model';
import { moveTimelineItems, timelineNudgeStep, trimTimelineClips } from './timelineSelection';

const key = (id: string, time: number) => ({id, time, value: time, easing: 'linear' as const, direction: 'inOut' as const, mode: 'smooth' as const});

function projectWithClips(): Project {
  const project = createProject();
  project.elements = [
    createElement('group', {id:'parent', start:1, duration:2, tracks:[{property:'x',keyframes:[key('parent-key',.5)]}]}),
    createElement('rectangle', {id:'child', parentId:'parent', start:1.5, duration:2, tracks:[{property:'x',keyframes:[key('child-key',.5)]}]}),
    createElement('ellipse', {id:'independent', start:4, duration:2, tracks:[{property:'x',keyframes:[key('first',.5),key('second',1.5)]}]}),
    createElement('text', {id:'later', start:7, duration:1}),
  ];
  return project;
}

describe('timeline group operations', () => {
  it('moves assemblies once, preserving relative offsets and skipping covered keys', () => {
    const base = projectWithClips();
    const moved = moveTimelineItems(base, [
      {kind:'clip', elementId:'parent'},
      {kind:'clip', elementId:'child'},
      {kind:'key', elementId:'child', property:'x', keyId:'child-key'},
      {kind:'key', elementId:'independent', property:'x', keyId:'first'},
    ], .25);
    expect(moved.elements.map(element => element.start)).toEqual([1.25,1.75,4,7]);
    expect(moved.elements[1].tracks[0].keyframes[0].time).toBe(.5);
    expect(moved.elements[2].tracks[0].keyframes[0].time).toBe(.75);
    expect(base.elements[0].start).toBe(1);
  });

  it('moves a selected keyframe group while keeping key identities and order', () => {
    const base = projectWithClips();
    const moved = moveTimelineItems(base, [
      {kind:'key', elementId:'independent', property:'x', keyId:'first'},
      {kind:'key', elementId:'independent', property:'x', keyId:'second'},
    ], -.2);
    expect(moved.elements[2].tracks[0].keyframes.map(frame => [frame.id,frame.time])).toEqual([['first',.3],['second',1.3]]);
    expect(base.elements[2].tracks[0].keyframes[0].time).toBe(.5);
  });

  it('rejects a whole move when any key would leave its clip or collide with another key', () => {
    const base = projectWithClips();
    expect(() => moveTimelineItems(base, [
      {kind:'clip',elementId:'parent'},
      {kind:'key',elementId:'independent',property:'x',keyId:'first'},
    ], -.75)).toThrow(/outside its clip/);
    expect(() => moveTimelineItems(base, [
      {kind:'key',elementId:'independent',property:'x',keyId:'first'},
    ], 1)).toThrow(/same time/);
    expect(base.elements[0].start).toBe(1);
    expect(base.elements[2].tracks[0].keyframes[0].time).toBe(.5);
  });

  it('ripples later material once for a moved clip group and does not double-move selected keys', () => {
    const base = projectWithClips();
    base.captions = [{id:'caption',start:6,end:7,text:'Hello'}];
    const moved = moveTimelineItems(base, [
      {kind:'clip',elementId:'parent'},
      {kind:'clip',elementId:'child'},
      {kind:'key',elementId:'independent',property:'x',keyId:'first'},
    ], .5, {ripple:true});
    expect(moved.elements.map(element => element.start)).toEqual([1.5,2,4.5,7.5]);
    expect(moved.elements[2].tracks[0].keyframes[0].time).toBe(.5);
    expect(moved.captions[0]).toMatchObject({start:6.5,end:7.5});
    expect(moved.sequences[0].duration).toBe(8.5);
  });

  it('trims selected clips together and ripples subsequent material for each out-point', () => {
    const base = projectWithClips();
    const trimmed = trimTimelineClips(base,['parent','independent'],.5,{ripple:true});
    expect(trimmed.elements.find(element => element.id==='parent')).toMatchObject({start:1,duration:2.5});
    expect(trimmed.elements.find(element => element.id==='independent')).toMatchObject({start:4.5,duration:2.5});
    expect(trimmed.elements.find(element => element.id==='later')?.start).toBe(8);
    expect(trimmed.duration).toBe(9);
    expect(base.elements[0].duration).toBe(2);
  });

  it('rejects all selected trims if one violates a source or minimum duration', () => {
    const base = projectWithClips();
    base.assets = [{id:'audio-source',name:'short',kind:'audio',mime:'audio/wav',dataUrl:'data:audio/wav;base64,AA==',duration:2.2}];
    base.elements[2].assetId = 'audio-source';
    expect(() => trimTimelineClips(base,['parent','independent'],.5)).toThrow(/source/);
    expect(() => trimTimelineClips(base,['parent','independent'],-2)).toThrow(/project frame/);
    expect(base.elements[0].duration).toBe(2);
    expect(base.elements[2].duration).toBe(2);
  });

  it('uses power-of-ten movement and at least one frame when snapped', () => {
    expect(timelineNudgeStep(2,30,false)).toBe(.1);
    expect(timelineNudgeStep(20,30,false)).toBe(1);
    expect(timelineNudgeStep(.2,30,false)).toBe(.01);
    expect(timelineNudgeStep(.2,30,true)).toBeCloseTo(1/30);
    expect(timelineNudgeStep(2,24,true)).toBeCloseTo(2/24);
  });
  it('keeps story duration at its scene boundary when a source-owned clip crosses it',()=>{
    const base=createProject();
    const sceneId=base.sequences[0].id;
    base.elements=[createElement('rectangle',{id:'long',sceneId,start:0,duration:8})];
    const moved=moveTimelineItems(base,[{kind:'clip',elementId:'long'}],3);
    expect(moved.elements[0].start).toBe(3);
    expect(moved.duration).toBe(8);
    const shortened=trimTimelineClips(moved,['long'],-6);
    expect(shortened.duration).toBe(8);
    const extended=structuredClone(base);extended.duration=12;
    expect(trimTimelineClips(extended,['long'],-1).duration).toBe(12);
  });
  it('moves selected camera keys as a group without collisions or leaving a scene', () => {
    const base=projectWithClips();
    base.sequences[0].camera={x:480,y:270,zoom:1,rotation:0,tracks:[
      {property:'zoom',keyframes:[key('camera-a',1),key('camera-b',3),key('camera-c',6)]},
    ]};
    const items=[
      {kind:'cameraKey' as const,sequenceId:base.sequences[0].id,property:'zoom' as const,keyId:'camera-a'},
      {kind:'cameraKey' as const,sequenceId:base.sequences[0].id,property:'zoom' as const,keyId:'camera-b'},
    ];
    const moved=moveTimelineItems(base,items,.5);
    expect(moved.sequences[0].camera?.tracks[0].keyframes.map(frame=>frame.time)).toEqual([1.5,3.5,6]);
    expect(() => moveTimelineItems(base,items,3)).toThrow(/same time/);
    expect(() => moveTimelineItems(base,items,-2)).toThrow(/outside its scene/);
    expect(base.sequences[0].camera?.tracks[0].keyframes[0].time).toBe(1);
  });
});
