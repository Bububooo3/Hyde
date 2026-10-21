import {describe,expect,it} from 'vitest';
import {elementWindow,createElement,createProject,type Project} from './model';
import {preparePortableAudio} from './portableAudio';
import {materializeScenePlacements,placeLinkedScene} from './scenePlacement';

function story(){
  const project=createProject('Nested sound');
  const source=project.sequences[0];source.duration=4;project.duration=4;
  project.assets.push({id:'tone',name:'tone.wav',kind:'audio',mime:'audio/wav',dataUrl:'data:audio/wav;base64,AQ=='});
  project.elements.push(createElement('audio',{id:'source-audio',sceneId:source.id,assetId:'tone',start:0,duration:4}));
  return project;
}

function audibleAt(project:Project,time:number){
  const flattened=materializeScenePlacements(project);
  return flattened.elements.filter(element=>{
    const window=elementWindow(flattened,element);
    return !element.muted&&!element.hidden&&element.assetId&&window&&time>=window.start&&time<window.end;
  });
}

describe('portable linked-scene audio',()=>{
  it('renders one local clip per nested placement at that placement’s effective speed',async()=>{
    const original=story();
    const first=placeLinkedScene(original,original.sequences[0].id);
    first.project.sequences.find(scene=>scene.id===first.sceneId)!.duration=2;
    const second=placeLinkedScene(first.project,first.sceneId);
    second.project.sequences.find(scene=>scene.id===second.sceneId)!.duration=1;
    const prepared=await preparePortableAudio(second.project);
    expect(second.project.sequences.filter(scene=>scene.sourceSceneId).every(scene=>!scene.muted)).toBe(true);
    expect(prepared.sequences.filter(scene=>scene.sourceSceneId).every(scene=>scene.muted)).toBe(true);
    const firstAudio=audibleAt(prepared,4.5),secondAudio=audibleAt(prepared,8.5);
    expect(firstAudio).toHaveLength(1);
    expect(secondAudio).toHaveLength(1);
    expect(firstAudio[0]).toMatchObject({sceneId:first.sceneId,speed:2});
    expect(secondAudio[0]).toMatchObject({sceneId:second.sceneId,speed:4});
    expect(secondAudio[0].id).not.toBe(firstAudio[0].id);
    expect(audibleAt(prepared,0.5)).toHaveLength(1);
  });

  it('retains authored overrides and targeted source mutes through nested links',async()=>{
    const source=story();
    const linked=placeLinkedScene(source,source.sequences[0].id);
    const inner=linked.project.sequences.find(scene=>scene.id===linked.sceneId)!;
    inner.mutedSourceClipIds=['source-audio'];
    linked.project.elements.push(createElement('audio',{id:'replacement',sceneId:linked.sceneId,assetId:'tone',start:4,duration:4}));
    const outerLink=placeLinkedScene(linked.project,linked.sceneId);
    outerLink.project.sequences.find(scene=>scene.id===outerLink.sceneId)!.mutedSourceClipIds=['replacement'];
    const prepared=await preparePortableAudio(outerLink.project);
    expect(audibleAt(prepared,4.5).map(element=>element.id)).toEqual(['replacement']);
    expect(audibleAt(prepared,8.5)).toHaveLength(0);
    expect(prepared.sequences.find(scene=>scene.id===linked.sceneId)?.mutedSourceClipIds).toEqual(['source-audio']);
    expect(prepared.sequences.find(scene=>scene.id===outerLink.sceneId)?.mutedSourceClipIds).toEqual(['replacement']);
  });
});
