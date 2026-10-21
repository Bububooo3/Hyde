// @vitest-environment jsdom
import {describe,expect,it} from 'vitest';
import {captureAssemblyClip,editAssemblyClipGapTransition,editAssemblyTextureOverlap} from './assemblyClips';
import {editAssemblyClipKey} from './assemblyClipEditing';
import {makeAssembly} from './editing';
import {evaluateProject} from './engine';
import {createElement,createProject,type Keyframe,type Project} from './model';
import {textureDuringOverlap} from './textureConflict';
import {importAssembly,loadAssemblyFile,saveAssemblyBlob,saveProjectBlob} from './storage';

const key=(time:number,value:string):Keyframe=>({id:crypto.randomUUID(),time,value,easing:'linear',direction:'in',mode:'smooth'});
function projectWithTextures():Project{
  const project=createProject('Texture actor');
  project.assets=[
    {id:'paper-a',name:'A.png',kind:'image',mime:'image/png',dataUrl:'data:image/png;base64,AQIDBA=='},
    {id:'paper-b',name:'B.png',kind:'image',mime:'image/png',dataUrl:'data:image/png;base64,BQYHCA=='},
  ];
  project.elements=[
    createElement('group',{id:'root',start:0,duration:8,width:0,height:0,sceneId:project.sequences[0].id}),
    createElement('rectangle',{id:'card',parentId:'root',start:0,duration:8,assetId:'paper-a',sceneId:project.sequences[0].id}),
  ];
  const root=project.elements[0];
  root.assemblyClips=[
    {id:'a',name:'A',duration:2,tracks:[{elementId:'card',property:'assetId',keyframes:[key(0,'paper-a')]}]},
    {id:'b',name:'B',duration:2,tracks:[{elementId:'card',property:'assetId',keyframes:[key(0,'paper-b')]}]},
  ];
  root.clipInstances=[{id:'a-place',clipId:'a',start:0,duration:2},{id:'b-place',clipId:'b',start:1,duration:2}];
  return project;
}
const textureAt=(project:Project,time:number)=>evaluateProject(project,time).find(element=>element.id==='card')?.assetId;

describe('discrete texture animation',()=>{
  it('alternates conflicting placed textures at four switches per project second',()=>{
    const project=projectWithTextures();
    expect(textureAt(project,1.1)).toBe('paper-a');
    expect(textureAt(project,1.3)).toBe('paper-b');
    expect(textureAt(project,1.6)).toBe('paper-a');
    expect(textureAt(project,1.8)).toBe('paper-b');
    expect(textureAt(project,2.1)).toBe('paper-b');
    // The same absolute timestamp keeps its phase even with another overlap start.
    expect(textureDuringOverlap('paper-a','paper-b',1.3,1.2,2)).toBe('paper-b');
    expect(textureDuringOverlap('paper-a','paper-a',1.3,1,2)).toBe('paper-a');
  });
  it('offers a single switch, outgoing hold and incoming override per incoming part',()=>{
    let project=projectWithTextures();
    project=editAssemblyTextureOverlap(project,'root','b-place','card',{mode:'single',switchPoint:.7});
    expect(textureAt(project,1.6)).toBe('paper-a');
    expect(textureAt(project,1.8)).toBe('paper-b');
    project=editAssemblyTextureOverlap(project,'root','b-place','card',{mode:'holdOutgoing'});
    expect(textureAt(project,1.8)).toBe('paper-a');
    project=editAssemblyTextureOverlap(project,'root','b-place','card',{mode:'useIncoming'});
    expect(textureAt(project,1.1)).toBe('paper-b');
    project=editAssemblyTextureOverlap(project,'root','b-place','card',null);
    expect(project.elements[0].clipInstances![1].textureOverlaps).toBeUndefined();
  });
  it('switches texture across a positive clip gap at an adjustable discrete point',()=>{
    const project=projectWithTextures();
    project.elements[0].clipInstances![1].start=3;
    expect(textureAt(project,2.25)).toBe('paper-a');
    expect(textureAt(project,2.75)).toBe('paper-b');
    const later=editAssemblyClipGapTransition(project,'root','b-place','card','assetId',{switchPoint:.8});
    expect(textureAt(later,2.75)).toBe('paper-a');
    expect(textureAt(later,2.9)).toBe('paper-b');
    expect(()=>editAssemblyClipGapTransition(project,'root','b-place','card','assetId',{switchPoint:2})).toThrow(/between zero and one/);
  });
  it('preserves priority overrides and direct discrete keys without changing fill tweening',()=>{
    const project=projectWithTextures();
    project.elements[0].clipInstances![0].priorityOverrides=[{elementId:'card',property:'assetId',priority:1}];
    expect(textureAt(project,1.3)).toBe('paper-a');
    const card=project.elements[1];
    card.tracks=[
      {property:'assetId',keyframes:[key(0,'paper-a'),key(2,'paper-b'),key(4,'')]},
      {property:'fill',keyframes:[key(0,'#000000'),key(2,'#ffffff')]},
    ];
    expect(textureAt(project,.5)).toBe('paper-a');
    expect(evaluateProject(project,.5).find(item=>item.id==='card')?.fill).toBe('#404040');
    const withoutClips=structuredClone(project);
    delete withoutClips.elements[0].clipInstances;
    expect(textureAt(withoutClips,1.1)).toBe('paper-b');
    withoutClips.elements[1].tracks[0].keyframes[0].switchPoint=.8;
    expect(textureAt(withoutClips,1.1)).toBe('paper-a');
    expect(textureAt(withoutClips,1.7)).toBe('paper-b');
    expect(textureAt(withoutClips,3.1)).toBeUndefined();
  });
  it('captures keyed assets and includes/remaps every dependency in a portable assembly',async()=>{
    const source=projectWithTextures();
    delete source.elements[0].assemblyClips;delete source.elements[0].clipInstances;
    source.elements[1].tracks=[{property:'assetId',keyframes:[key(0,'paper-a'),key(2,'paper-b')]}];
    const captured=captureAssemblyClip(source,'root',0,2,'Texture swap').project;
    const assembly=makeAssembly(captured,['root']);
    expect(assembly.assets.map(asset=>asset.id).sort()).toEqual(['paper-a','paper-b']);
    const opened=await loadAssemblyFile(new File([await saveAssemblyBlob(assembly)],'textures.hyproj'));
    const imported=importAssembly(createProject(),opened);
    const importedRoot=imported.elements.find(item=>item.kind==='group')!;
    const importedCard=imported.elements.find(item=>item.parentId===importedRoot.id)!;
    const keyed=new Set(importedRoot.assemblyClips!.flatMap(clip=>clip.tracks.filter(track=>track.property==='assetId').flatMap(track=>track.keyframes.map(frame=>frame.value))));
    expect(keyed).toContain(importedCard.assetId);
    expect([...keyed].every(id=>imported.assets.some(asset=>asset.id===id))).toBe(true);
    expect([...keyed].some(id=>id==='paper-a'||id==='paper-b')).toBe(false);
    await expect(saveProjectBlob(imported)).resolves.toBeInstanceOf(Blob);
  });
  it('rejects missing texture key assets and invalid overlap controls',async()=>{
    const project=projectWithTextures();
    project.elements[0].assemblyClips![0].tracks[0].keyframes[0].value='missing';
    await expect(saveProjectBlob(project)).rejects.toThrow(/image or video asset/);
    project.elements[0].assemblyClips![0].tracks[0].keyframes[0].value='paper-a';
    project.elements[0].clipInstances![1].textureOverlaps=[{elementId:'card',mode:'alternate',switchesPerSecond:0,switchPoint:.5}];
    await expect(saveProjectBlob(project)).rejects.toThrow(/Texture switches per second/);
    delete project.elements[0].clipInstances![1].textureOverlaps;
    project.elements[0].assemblyClips![0].tracks[0].keyframes[0].switchPoint=2;
    await expect(saveProjectBlob(project)).rejects.toThrow(/Texture key switch point/);
    expect(()=>editAssemblyTextureOverlap(project,'root','b-place','card',{switchPoint:2})).toThrow(/valid texture overlap/);
    const target={rootId:'root',clipId:'a',elementId:'card',property:'assetId' as const};
    expect(editAssemblyClipKey(project,target,0,{switchPoint:.8}).elements[0].assemblyClips![0].tracks[0].keyframes[0].switchPoint).toBe(.8);
    expect(()=>editAssemblyClipKey(project,target,0,{switchPoint:2})).toThrow(/between zero and one/);
    expect(()=>editAssemblyClipKey(project,target,0,{value:'missing'})).toThrow(/image or video/);
  });
  it('allows saved pin and media placement on a shape whose resting pose has no texture',async()=>{
    const project=projectWithTextures();
    const card=project.elements[1];
    delete card.assetId;
    card.mediaPin=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
    card.mediaTransform={x:12,y:0,scaleX:1,scaleY:1,rotation:0};
    expect(textureAt(project,.2)).toBe('paper-a');
    await expect(saveProjectBlob(project)).resolves.toBeInstanceOf(Blob);
  });
});
