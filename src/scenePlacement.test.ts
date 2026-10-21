import { describe, expect, it } from 'vitest';
import { evaluateCameraForScene, evaluateProject } from './engine';
import { hasProjectAudio } from './mediaExportAudio';
import { createElement, createProject } from './model';
import { bakeScenePlacements, makeSceneIndependent, materializeScenePlacements, placeLinkedScene, validateSceneLinks } from './scenePlacement';
import { deleteScene, retimeScene } from './sceneOperations';

function sourceStory(){
  const project=createProject('Linked scenes');
  const source=project.sequences[0];source.duration=4;project.duration=4;
  project.assets.push({id:'tone',name:'tone.wav',kind:'audio',mime:'audio/wav',dataUrl:'data:audio/wav;base64,AQ=='});
  project.elements.push(createElement('rectangle',{id:'shape',sceneId:source.id,start:1,duration:2,fill:'#ff8a00',tracks:[{property:'x',keyframes:[
    {id:'first',time:0,value:100,easing:'linear',direction:'inOut',mode:'smooth'},
    {id:'last',time:2,value:300,easing:'linear',direction:'inOut',mode:'smooth'},
  ]}]}));
  project.elements.push(createElement('audio',{id:'sound',sceneId:source.id,assetId:'tone',start:0,duration:4}));
  project.captions.push({id:'words',sceneId:source.id,start:1,end:2,text:'Hello'});
  return project;
}

describe('linked scene placements',()=>{
  it('reuses source objects, animation, captions, and sound at a new timeline position',()=>{
    const original=sourceStory();
    const {project,sceneId}=placeLinkedScene(original,original.sequences[0].id);
    expect(project.elements).toHaveLength(original.elements.length);
    expect(project.sequences[1]).toMatchObject({id:sceneId,start:4,duration:4,sourceSceneId:original.sequences[0].id});
    const at=evaluateProject(project,6).find(element=>element.id===`${sceneId}::shape`)!;
    expect(at).toMatchObject({sceneId,x:200,fill:'#ff8a00'});
    expect(hasProjectAudio(project,6,7)).toBe(true);
    expect(materializeScenePlacements(project).captions.find(caption=>caption.id===`${sceneId}::words`))
      .toMatchObject({start:5,end:6,sceneId});
    const edited=structuredClone(project);
    edited.elements.find(element=>element.id==='shape')!.fill='#112233';
    expect(evaluateProject(edited,6).find(element=>element.id===`${sceneId}::shape`)?.fill).toBe('#112233');
    expect(()=>deleteScene(project,original.sequences[0].id)).toThrow('linked placements');
  });

  it('retimes a placement without changing its source and can make an independent copy',()=>{
    const original=sourceStory();
    const {project,sceneId}=placeLinkedScene(original,original.sequences[0].id);
    const retimed=retimeScene(project,sceneId,8);
    expect(retimed.sequences.find(scene=>scene.id===sceneId)?.duration).toBe(8);
    expect(retimed.sequences[0].duration).toBe(4);
    expect(evaluateProject(retimed,8).find(element=>element.id===`${sceneId}::shape`)?.x).toBe(200);
    const independent=makeSceneIndependent(retimed,sceneId);
    expect(independent.sequences.find(scene=>scene.id===sceneId)?.sourceSceneId).toBeUndefined();
    expect(independent.elements.filter(element=>element.sceneId===sceneId)).toHaveLength(2);
    const edited=structuredClone(independent);
    edited.elements.find(element=>element.id==='shape')!.fill='#112233';
    expect(evaluateProject(edited,8).find(element=>element.sceneId===sceneId&&element.kind==='rectangle')?.fill).toBe('#ff8a00');
    expect(bakeScenePlacements(retimed).sequences.every(scene=>!scene.sourceSceneId)).toBe(true);
  });

  it('retimes an explicit source range when its source scene changes length',()=>{
    const original=sourceStory();
    const {project,sceneId}=placeLinkedScene(original,original.sequences[0].id);
    const ranged=structuredClone(project),placement=ranged.sequences.find(scene=>scene.id===sceneId)!;
    placement.sourceIn=1;placement.sourceOut=3;
    const changed=retimeScene(ranged,original.sequences[0].id,8);
    expect(changed.sequences.find(scene=>scene.id===sceneId)).toMatchObject({sourceIn:2,sourceOut:6});
  });

  it('uses the selected source range and can mute only the linked placement',()=>{
    const original=sourceStory();
    const {project,sceneId}=placeLinkedScene(original,original.sequences[0].id);
    const placement=project.sequences.find(scene=>scene.id===sceneId)!;
    placement.sourceIn=1;placement.sourceOut=3;placement.muted=true;
    expect(evaluateProject(project,6).find(element=>element.id===`${sceneId}::shape`)?.x).toBe(200);
    expect(hasProjectAudio(project,5,7)).toBe(false);
    expect(hasProjectAudio(project,0,1)).toBe(true);
  });
  it('can replace one placed source clip without muting its other audio',()=>{
    const original=sourceStory();
    const {project,sceneId}=placeLinkedScene(original,original.sequences[0].id);
    project.sequences.find(scene=>scene.id===sceneId)!.mutedSourceClipIds=['sound'];
    const flattened=materializeScenePlacements(project);
    expect(flattened.elements.find(element=>element.id===`${sceneId}::sound`)?.muted).toBe(true);
    expect(flattened.elements.find(element=>element.id==='sound')?.muted).toBeUndefined();
  });

  it('mutes video audio carried by a shape fill in a linked placement',()=>{
    const original=sourceStory();
    original.assets.push({id:'film',name:'film.webm',kind:'video',mime:'video/webm',dataUrl:'data:video/webm;base64,AQ=='});
    original.elements.push(createElement('rectangle',{id:'video-fill',sceneId:original.sequences[0].id,assetId:'film',start:0,duration:4}));
    const {project,sceneId}=placeLinkedScene(original,original.sequences[0].id);
    project.sequences.find(scene=>scene.id===sceneId)!.mutedSourceClipIds=['video-fill'];
    expect(materializeScenePlacements(project).elements.find(element=>element.id===`${sceneId}::video-fill`)?.muted).toBe(true);
    expect(materializeScenePlacements(project).elements.find(element=>element.id==='video-fill')?.muted).toBeUndefined();
  });

  it('remaps reusable clip targets and text flow while muting animated video fills',()=>{
    const original=sourceStory(),sceneId=original.sequences[0].id;
    original.assets.push({id:'film',name:'film.webm',kind:'video',mime:'video/webm',dataUrl:'data:video/webm;base64,AQ=='});
    original.elements.push(createElement('group',{id:'assembly',sceneId,start:0,duration:4,x:0,y:0,
      assemblyClips:[{id:'motion',name:'Slide',duration:4,tracks:[{elementId:'part',property:'x',keyframes:[
        {id:'left',time:0,value:100,easing:'linear',direction:'inOut',mode:'smooth'},
        {id:'right',time:4,value:300,easing:'linear',direction:'inOut',mode:'smooth'},
      ]}]}],clipInstances:[{id:'placed',clipId:'motion',start:0,duration:4}]}));
    original.elements.push(createElement('rectangle',{id:'part',sceneId,parentId:'assembly',start:0,duration:4,
      tracks:[{property:'assetId',keyframes:[{id:'texture',time:0,value:'film',easing:'linear',direction:'inOut',mode:'smooth'}]}]}));
    original.elements.push(createElement('text',{id:'flow',sceneId,flowAroundId:'part',start:0,duration:4}));
    const linked=placeLinkedScene(original,sceneId),placement=linked.project.sequences.find(item=>item.id===linked.sceneId)!;
    placement.mutedSourceClipIds=['part'];
    const flattened=materializeScenePlacements(linked.project);
    const root=flattened.elements.find(item=>item.id===`${linked.sceneId}::assembly`)!;
    expect(root.assemblyClips?.[0].tracks[0].elementId).toBe('part');
    expect(root.clipInstances?.[0].clipId).toBe(root.assemblyClips?.[0].id);
    expect(flattened.elements.find(item=>item.id===`${linked.sceneId}::flow`)?.flowAroundId).toBe(`${linked.sceneId}::part`);
    expect(flattened.elements.find(item=>item.id===`${linked.sceneId}::part`)?.muted).toBe(true);
    expect(evaluateProject(linked.project,6).find(item=>item.id===`${linked.sceneId}::part`)?.x).toBeCloseTo(200);
    const retimed=retimeScene(linked.project,linked.sceneId,8);
    expect(evaluateProject(retimed,8).find(item=>item.id===`${linked.sceneId}::part`)?.x).toBeCloseTo(200);
    const independent=makeSceneIndependent(linked.project,linked.sceneId);
    const copiedPart=independent.elements.find(item=>item.sceneId===linked.sceneId&&item.tracks.some(track=>track.property==='assetId'))!;
    expect(independent.elements.find(item=>item.sceneId===linked.sceneId&&item.kind==='text')?.flowAroundId).toBe(copiedPart.id);
  });

  it('composes nested timing, keys, captions, media speed, and parent IDs',()=>{
    const original=sourceStory();
    original.elements.push(createElement('ellipse',{id:'part',sceneId:original.sequences[0].id,parentId:'shape',start:1,duration:2}));
    const first=placeLinkedScene(original,original.sequences[0].id);
    const middle=first.project.sequences.find(scene=>scene.id===first.sceneId)!;
    middle.sourceIn=1;middle.sourceOut=3;
    const second=placeLinkedScene(first.project,first.sceneId);
    const outer=second.project.sequences.find(scene=>scene.id===second.sceneId)!;
    outer.sourceIn=1;outer.sourceOut=3;outer.duration=2;
    const nestedId=`${second.sceneId}::${first.sceneId}::shape`;
    const nested=materializeScenePlacements(second.project);
    expect(nested.elements.find(element=>element.id===nestedId)).toMatchObject({
      sceneId:second.sceneId,start:7,duration:4,speed:.5,
    });
    expect(nested.elements.find(element=>element.id===`${second.sceneId}::${first.sceneId}::part`)?.parentId).toBe(nestedId);
    expect(nested.captions.find(caption=>caption.id===`${second.sceneId}::${first.sceneId}::words`))
      .toMatchObject({sceneId:second.sceneId,start:7,end:9});
    expect(evaluateProject(second.project,9).find(element=>element.id===nestedId)?.x).toBe(200);
    const edited=structuredClone(second.project);
    edited.elements.find(element=>element.id==='shape')!.fill='#336699';
    expect(evaluateProject(edited,9).find(element=>element.id===nestedId)?.fill).toBe('#336699');

    const independent=makeSceneIndependent(second.project,second.sceneId);
    const copied=independent.elements.filter(element=>element.sceneId===second.sceneId);
    expect(copied).toHaveLength(3);
    expect(copied.find(element=>element.name==='Ellipse')?.parentId).toBe(copied.find(element=>element.name==='Rectangle')?.id);
    expect(independent.captions.filter(caption=>caption.sceneId===second.sceneId)).toHaveLength(1);
  });

  it('retains an inherited camera when nested source ranges cut between keys',()=>{
    const original=sourceStory();
    original.sequences[0].camera={x:0,y:270,zoom:1,rotation:0,tracks:[{property:'x',keyframes:[
      {id:'camera-start',time:0,value:0,easing:'linear',direction:'inOut',mode:'smooth'},
      {id:'camera-end',time:4,value:400,easing:'linear',direction:'inOut',mode:'smooth'},
    ]}]};
    const first=placeLinkedScene(original,original.sequences[0].id);
    const middle=first.project.sequences.find(scene=>scene.id===first.sceneId)!;
    middle.sourceIn=1;middle.sourceOut=3;
    const second=placeLinkedScene(first.project,first.sceneId);
    const outer=second.project.sequences.find(scene=>scene.id===second.sceneId)!;
    outer.sourceIn=1;outer.sourceOut=3;
    const before=[0,2,4].map(offset=>evaluateCameraForScene(second.project,outer,outer.start+offset).x);
    before.forEach((value,index)=>expect(value).toBeCloseTo([150,200,250][index]));
    const independent=makeSceneIndependent(second.project,second.sceneId);
    const camera=independent.sequences.find(scene=>scene.id===second.sceneId)!.camera!;
    expect(camera.tracks[0].keyframes.map(key=>key.time)).toEqual([0,4]);
    camera.tracks[0].keyframes.forEach((key,index)=>expect(key.value).toBeCloseTo([150,250][index]));
    const after=[0,2,4].map(offset=>evaluateCameraForScene(independent,independent.sequences.find(scene=>scene.id===second.sceneId)!,outer.start+offset).x);
    after.forEach((value,index)=>expect(value).toBeCloseTo(before[index]));
  });

  it('preserves intermediate audio overrides and nested mute IDs when baking',()=>{
    const original=sourceStory();
    const first=placeLinkedScene(original,original.sequences[0].id);
    const middle=first.project.sequences.find(scene=>scene.id===first.sceneId)!;
    middle.mutedSourceClipIds=['sound'];
    first.project.elements.push(createElement('audio',{
      id:'replacement',sceneId:first.sceneId,assetId:'tone',start:4,duration:4,
    }));
    const second=placeLinkedScene(first.project,first.sceneId);
    const outer=second.project.sequences.find(scene=>scene.id===second.sceneId)!;
    outer.mutedSourceClipIds=['replacement'];
    const derived=materializeScenePlacements(second.project);
    expect(derived.elements.find(element=>element.id===`${second.sceneId}::${first.sceneId}::sound`)?.muted).toBe(true);
    expect(derived.elements.find(element=>element.id===`${second.sceneId}::replacement`)?.muted).toBe(true);
    expect(derived.elements.find(element=>element.id==='replacement')?.muted).toBeUndefined();
    expect(hasProjectAudio(second.project,8,9)).toBe(false);
    const baked=bakeScenePlacements(second.project);
    expect(baked.sequences.every(scene=>!scene.sourceSceneId)).toBe(true);
    expect(hasProjectAudio(baked,8,9)).toBe(false);
    expect(hasProjectAudio(baked,4,5)).toBe(true);
  });

  it('rejects cycles and missing linked sources before placement or materialization',()=>{
    const original=sourceStory();
    const {project,sceneId}=placeLinkedScene(original,original.sequences[0].id);
    const cyclic=structuredClone(project);
    cyclic.sequences[0].sourceSceneId=sceneId;
    expect(()=>validateSceneLinks(cyclic)).toThrow('Circular linked scenes');
    expect(()=>materializeScenePlacements(cyclic)).toThrow('Circular linked scenes');
    expect(()=>placeLinkedScene(cyclic,sceneId)).toThrow('Circular linked scenes');
    const missing=structuredClone(project);
    missing.sequences.find(scene=>scene.id===sceneId)!.sourceSceneId='missing';
    expect(()=>validateSceneLinks(missing)).toThrow('unavailable');
  });
});
