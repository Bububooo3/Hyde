// @vitest-environment jsdom
import {describe,expect,it} from 'vitest';
import {addAssemblyClipKey,assemblyTrackView,editAssemblyClipKey,removeAssemblyClipKey,resetAssemblyClipTrackOverride} from './assemblyClipEditing';
import {selectAssemblyMasterRows} from './assemblyMaster';
import {captureAssemblyClip,placeAssemblyClip} from './assemblyClips';
import {evaluateProject} from './engine';
import {insertAssemblyAt,makeAssembly} from './editing';
import {createElement,createProject,type Keyframe,type Project} from './model';
import {loadAssemblyFile,loadProjectFile,saveAssemblyBlob,saveProjectBlob} from './storage';

const key=(time:number,value:number):Keyframe=>({id:crypto.randomUUID(),time,value,easing:'linear',direction:'inOut',mode:'smooth'});

function fixture(){
  let project:Project=createProject();
  const sceneId=project.sequences[0].id;
  project.elements=[
    createElement('group',{id:'root',name:'Actor',x:0,y:0,width:0,height:0,duration:8,sceneId}),
    createElement('rectangle',{id:'part',name:'Part',parentId:'root',x:0,y:0,duration:8,sceneId,tracks:[{property:'x',keyframes:[key(0,0),key(2,100)]}]}),
  ];
  const captured=captureAssemblyClip(project,'root',0,2,'Move');
  project=placeAssemblyClip(captured.project,'root',captured.clipId,0).project;
  const second=placeAssemblyClip(project,'root',captured.clipId,3);
  return {project:second.project,clipId:captured.clipId,secondId:second.instanceId};
}
const xAt=(project:Project,time:number,id='part')=>evaluateProject(project,time).find(item=>item.id===id)!.x;

describe('shared and placed assembly clip keys',()=>{
  it('edits the source for all placements and forks only the chosen instance on local edit',async()=>{
    const {project,clipId,secondId}=fixture();
    const target={rootId:'root',clipId,elementId:'part',property:'x' as const};
    const shared=editAssemblyClipKey(project,target,1,{value:200});
    expect(xAt(shared,1)).toBeCloseTo(100);
    expect(xAt(shared,4)).toBeCloseTo(100);
    const local=editAssemblyClipKey(shared,{...target,instanceId:secondId},1,{value:300});
    expect(xAt(local,1)).toBeCloseTo(100);
    expect(xAt(local,4)).toBeCloseTo(150);
    expect(assemblyTrackView(local,{...target,instanceId:secondId}).isOverride).toBe(true);
    expect(local.elements[0].assemblyClips![0].tracks.find(track=>track.elementId==='part'&&track.property==='x')!.keyframes[1].value).toBe(200);
    const reopened=await loadProjectFile(new File([await saveProjectBlob(local)],'clips.hyde'));
    expect(xAt(reopened,4)).toBeCloseTo(150);
    const assembly=makeAssembly(local,['root']);
    const imported=insertAssemblyAt(createProject(),await loadAssemblyFile(new File([await saveAssemblyBlob(assembly)],'actor.hyproj')),0);
    const root=imported.elements.find(item=>item.name==='Actor')!;
    const part=imported.elements.find(item=>item.parentId===root.id)!;
    expect(root.clipInstances![1].trackOverrides![0].elementId).toBe(part.id);
    expect(xAt(imported,4,part.id)-xAt(imported,4,root.id)).toBeCloseTo(150);
    const reset=resetAssemblyClipTrackOverride(local,{...target,instanceId:secondId});
    expect(xAt(reset,4)).toBeCloseTo(100);
    expect(project.elements[0].clipInstances![1].trackOverrides).toBeUndefined();
  });

  it('adds, retimes, and removes keyed values while enforcing source bounds',()=>{
    const {project,clipId,secondId}=fixture();
    const target={rootId:'root',clipId,instanceId:secondId,elementId:'part',property:'x' as const};
    const added=addAssemblyClipKey(project,target,1);
    expect(assemblyTrackView(added,target).track.keyframes.map(key=>key.time)).toEqual([0,1,2]);
    expect(assemblyTrackView(added,target).track.keyframes[1].value).toBeCloseTo(50);
    const moved=editAssemblyClipKey(added,target,1,{time:1.5,value:80,easing:'quad',direction:'out'});
    expect(assemblyTrackView(moved,target).track.keyframes[1]).toMatchObject({time:1.5,value:80,easing:'quad',direction:'out'});
    expect(removeAssemblyClipKey(moved,target,1).elements[0].clipInstances![1].trackOverrides![0].keyframes).toHaveLength(2);
    expect(()=>editAssemblyClipKey(moved,target,1,{time:2})).toThrow(/one keyframe/);
    expect(()=>addAssemblyClipKey(moved,target,3)).toThrow(/inside the clip/);
    const fill={...target,property:'fill' as const};
    expect(assemblyTrackView(editAssemblyClipKey(project,fill,0,{value:'rgba(12, 30, 40, 0.5)'}),fill).track.keyframes[0].value).toBe('rgba(12, 30, 40, 0.5)');
  });

  it('derives master keys from actual sources and a read-only composed curve',()=>{
    const {project,clipId,secondId}=fixture();
    const target={rootId:'root',clipId,instanceId:secondId,elementId:'part',property:'x' as const};
    const local=editAssemblyClipKey(project,target,1,{value:300});
    const row=selectAssemblyMasterRows(local,'root',20).find(item=>item.elementId==='part'&&item.property==='x')!;
    expect(row.keys.map(key=>key.time)).toEqual([0,2,3,5]);
    expect(row.keys.map(key=>key.scope)).toEqual(['shared','shared','instance','instance']);
    expect(row.curve).toHaveLength(20);
    expect(row.curve.every(point=>point.x>=0&&point.x<=100&&point.y>=4&&point.y<=20)).toBe(true);
  });
});
