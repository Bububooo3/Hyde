import {describe,expect,it} from 'vitest';
import {createElement,createProject} from './model';
import {snapTimelineDelta,snapTimelineTime,timelineSnapTargets} from './timelineSnap';

function fixture(){
  const project=createProject();
  project.duration=10;
  project.sequences=[
    {id:'first',name:'First',start:0,duration:4,color:'#fff'},
    {id:'second',name:'Second',start:4,duration:6,color:'#fff'},
  ];
  project.elements=[
    createElement('group',{id:'assembly',start:1,duration:3,clipInstances:[{id:'placed',clipId:'clip',start:.5,duration:1.25}]}),
    createElement('rectangle',{id:'child',parentId:'assembly',start:1.25,duration:1}),
    createElement('ellipse',{id:'other',start:5.1,duration:1.2}),
  ];
  return project;
}

const settings={duration:10,laneWidth:1000,fps:30,enabled:true};

describe('timeline snapping',()=>{
  it('collects scene boundaries, clip edges, placed assembly edges, and playhead',()=>{
    const targets=timelineSnapTargets(fixture(),{playhead:6.4});
    for(const time of [0,4,10,1,1.5,2.75,5.1,6.3,6.4])expect(targets).toContain(time);
  });

  it('omits moved assembly descendants and a moved placed clip',()=>{
    const targets=timelineSnapTargets(fixture(),{excludeElementIds:['assembly']});
    for(const time of [1,1.25,1.5,2.25,2.75])expect(targets).not.toContain(time);
    expect(targets).toContain(5.1);
    const withoutPlacement=timelineSnapTargets(fixture(),{excludeInstanceIds:['placed']});
    expect(withoutPlacement).not.toContain(1.5);
    expect(withoutPlacement).not.toContain(2.75);
  });

  it('snaps the playhead to nearby clip, scene, and timeline ends before frames',()=>{
    const targets=timelineSnapTargets(fixture(),{playhead:7.1});
    expect(snapTimelineTime(5.15,{...settings,targets})).toBeCloseTo(5.1);
    expect(snapTimelineTime(4.06,{...settings,targets})).toBe(4);
    expect(snapTimelineTime(9.95,{...settings,targets})).toBe(10);
    expect(snapTimelineTime(7.16,{...settings,targets})).toBeCloseTo(7.1);
  });

  it('snaps dragged clip in and out points and trimmed out points',()=>{
    const targets=timelineSnapTargets(fixture(),{excludeElementIds:['assembly'],playhead:7.1});
    expect(snapTimelineDelta(3.04,[1,4],{...settings,targets})).toBe(3);
    expect(snapTimelineDelta(1.14,[1,4],{...settings,targets})).toBeCloseTo(1.1);
    expect(snapTimelineDelta(3.04,[4],{...settings,targets})).toBeCloseTo(3.1);
  });

  it('lands a fractional source edge on an exact frame without a nearby landmark',()=>{
    expect(snapTimelineDelta(.21,[1.01],{...settings,targets:[]})).toBeCloseTo(7/30-0.01);
  });

  it('returns raw subframe movement when temporarily bypassed',()=>{
    const targets=timelineSnapTargets(fixture());
    expect(snapTimelineTime(4.06,{...settings,targets,enabled:false})).toBe(4.06);
    expect(snapTimelineDelta(.117,[1],{...settings,targets,enabled:false})).toBe(.117);
  });
});
