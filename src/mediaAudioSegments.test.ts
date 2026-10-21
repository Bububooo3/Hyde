import {describe,expect,it} from 'vitest';
import {createElement,createProject,type Keyframe} from './model';
import {animatedAssetElementIds,mediaAudioSegments} from './mediaAudioSegments';
import {hasProjectAudio,projectAudioTail,projectEffectTails} from './mediaExportAudio';
import {createAudioEffect} from './audioEffects';

const key=(id:string,time:number,value:string,switchPoint?:number):Keyframe=>({
  id,time,value,easing:'linear',direction:'inOut',mode:'smooth',...(switchPoint===undefined?{}:{switchPoint}),
});
const asset=(id:string,kind:'image'|'video')=>({id,name:id,mime:kind==='image'?'image/png':'video/mp4',kind,dataUrl:`data:${kind}/mp4;base64,AA==`});

describe('animated media audio intervals',()=>{
  it('uses the evaluated asset and exact switch point, including an image-to-video fill',()=>{
    const project=createProject();project.duration=4;project.sequences[0].duration=4;
    project.assets=[asset('still','image'),asset('one','video'),asset('two','video')];
    const element=createElement('rectangle',{id:'art',assetId:'still',start:0,duration:4,tracks:[{property:'assetId',keyframes:[
      key('a',0,'still',.3),key('b',2,'one'),key('c',4,'two'),
    ]}]});
    project.elements=[element];
    expect(animatedAssetElementIds(project)).toContain(element.id);
    const intervals=mediaAudioSegments(project);
    expect(intervals.map(interval=>interval.asset.id)).toEqual(['one','two']);
    expect(intervals[0].start).toBeCloseTo(.6,5);
    expect(intervals[0].end).toBeCloseTo(3,5);
    expect(intervals[1].start).toBeCloseTo(3,5);
    expect(intervals[1].end).toBe(4);
    expect(hasProjectAudio(project,0,.5)).toBe(false);
    expect(hasProjectAudio(project,.7,1)).toBe(true);
  });

  it('follows the absolute-clock four-per-second assembly texture cadence',()=>{
    const project=createProject();project.duration=2;project.sequences[0].duration=2;
    project.assets=[asset('one','video'),asset('two','video')];
    const element=createElement('rectangle',{id:'part',assetId:'one',duration:2,
      assemblyClips:[
        {id:'first',name:'First',duration:1.5,tracks:[{elementId:'part',property:'assetId',keyframes:[key('a',0,'one')]}]},
        {id:'second',name:'Second',duration:1,tracks:[{elementId:'part',property:'assetId',keyframes:[key('b',0,'two')]}]},
      ],
      clipInstances:[{id:'i1',clipId:'first',start:0,duration:1.5},{id:'i2',clipId:'second',start:1,duration:1}],
    });
    project.elements=[element];
    const intervals=mediaAudioSegments(project);
    expect(intervals.map(interval=>interval.asset.id)).toEqual(['one','two']);
    expect(intervals[0].end).toBeCloseTo(1.25,5);
    expect(intervals[1].start).toBeCloseTo(1.25,5);
  });

  it('carries an effect tail from the last audible texture segment',()=>{
    const project=createProject();project.duration=2;project.sequences[0].duration=2;
    project.assets=[asset('still','image'),asset('voice','video')];
    project.elements=[createElement('ellipse',{assetId:'still',duration:2,audioEffects:[createAudioEffect('reverb')],
      tracks:[{property:'assetId',keyframes:[key('a',0,'still'),key('b',1,'voice')]}]})];
    const tails=projectEffectTails(project);
    expect(tails).toHaveLength(1);
    expect(tails[0].start).toBe(2);
    expect(tails[0].end).toBeGreaterThan(2);
    expect(projectAudioTail(project,2)).toBeCloseTo(tails[0].end-2);
  });
});
