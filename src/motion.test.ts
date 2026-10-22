// @vitest-environment jsdom
import {describe,expect,it} from 'vitest';
import {evaluateProject} from './engine';
import {createElement,createProject,type MotionBehavior} from './model';
import {createMotionBehavior,sampleMotionPath,scaleMotionTime} from './motion';
import {makeSceneIndependent,materializeScenePlacements,placeLinkedScene} from './scenePlacement';
import {duplicateScene,retimeScene} from './sceneOperations';
import {loadProjectFile,saveProjectBlob} from './storage';

const sceneProject=()=>{const project=createProject('Motion');project.sequences[0].duration=8;return project;};

describe('procedural motion evaluation',()=>{
  it('holds the authored path at its start position while clips change the object pose',()=>{
    const project=sceneProject(),sceneId=project.sequences[0].id;
    const root=createElement('group',{id:'root',sceneId,x:100,y:100,assemblyClips:[{
      id:'clip',name:'Move',duration:2,tracks:[{elementId:'part',property:'x',keyframes:[
        {id:'clip0',time:0,value:0,easing:'linear',direction:'inOut',mode:'smooth'},
        {id:'clip1',time:2,value:100,easing:'linear',direction:'inOut',mode:'smooth'},
      ]}],
    }],clipInstances:[{id:'placed',clipId:'clip',start:0,duration:2}]});
    const path=createMotionBehavior('followPath',2);
    path.points=[{x:0,y:0},{x:20,y:0}];
    const part=createElement('rectangle',{id:'part',sceneId,parentId:'root',x:0,y:0,motionBehaviors:[path]});
    project.elements=[root,part];
    expect(evaluateProject(project,1).find(element=>element.id==='part')?.x).toBeCloseTo(110);
    expect(evaluateProject(project,1).find(element=>element.id==='part')?.y).toBe(100);
    const constrained=structuredClone(project);
    constrained.elements[1].attachment={type:'hinge',parentId:'root'};
    expect(evaluateProject(constrained,1).find(element=>element.id==='part')?.x).toBe(100);
  });

  it('follows multi-segment curved paths at approximately constant spatial speed',()=>{
    const points=[{x:0,y:0,out:{x:0,y:80}},{x:100,y:0,in:{x:100,y:80}},{x:200,y:0}];
    expect(sampleMotionPath(points,0)).toMatchObject({x:0,y:0});
    expect(sampleMotionPath(points,1)).toMatchObject({x:200,y:0});
    const distances=[];
    for(let step=1;step<=8;step++){
      const a=sampleMotionPath(points,(step-1)/8),b=sampleMotionPath(points,step/8);
      distances.push(Math.hypot(b.x-a.x,b.y-a.y));
    }
    expect(Math.max(...distances)/Math.min(...distances)).toBeLessThan(1.3);
  });

  it('renders a moved first path point at the same position as its stage guide',()=>{
    const project=sceneProject(),sceneId=project.sequences[0].id;
    const path=createMotionBehavior('followPath',2);
    path.points=[{x:30,y:15},{x:130,y:15}];
    project.elements=[createElement('rectangle',{sceneId,x:100,y:100,motionBehaviors:[path]})];
    expect(sampleMotionPath(path.points,0)).toMatchObject({x:30,y:15});
    expect(evaluateProject(project,0)[0]).toMatchObject({x:130,y:115});
    expect(evaluateProject(project,2)[0]).toMatchObject({x:230,y:115});
  });

  it('seeks and repeats seeded shake without random state or changing project data',()=>{
    const project=sceneProject(),sceneId=project.sequences[0].id;
    const shake=createMotionBehavior('shake',4);shake.seed=423;shake.fadeIn=.2;shake.fadeOut=.2;
    const el=createElement('rectangle',{id:'shaker',sceneId,x:100,y:100,motionBehaviors:[shake]});
    project.elements=[el];const original=JSON.stringify(project);
    const samples=[0,.1,.3,1.1,3.9,4].map(time=>evaluateProject(project,time)[0]);
    expect(samples[0].x).toBe(100);
    expect(samples[1].x).not.toBe(100);
    expect(samples[4].x).not.toBe(100);
    expect(samples[5].x).toBe(100);
    expect(evaluateProject(project,1.1)[0]).toEqual(samples[3]);
    expect(JSON.stringify(project)).toBe(original);
    const changed=structuredClone(project);(changed.elements[0].motionBehaviors![0] as Extract<MotionBehavior,{type:'shake'}>).seed=424;
    expect(evaluateProject(changed,1.1)[0].x).not.toBe(samples[3].x);
  });

  it('clamps additive opacity and scales wave frequency with scene retiming',()=>{
    const project=sceneProject(),sceneId=project.sequences[0].id;
    const wave=createMotionBehavior('oscillation',8);wave.property='opacity';wave.amplitude=.8;wave.frequency=1;
    const element=createElement('rectangle',{id:'wave',sceneId,opacity:.8,motionBehaviors:[wave]});
    project.elements=[element];
    expect(evaluateProject(project,.25)[0].opacity).toBe(1);
    expect(evaluateProject(project,.75)[0].opacity).toBeCloseTo(0);
    const retimed=retimeScene(project,sceneId,4);
    const next=retimed.elements[0].motionBehaviors![0] as Extract<MotionBehavior,{type:'oscillation'}>;
    expect(next.frequency).toBe(2);
    expect(evaluateProject(retimed,.125)[0].opacity).toBe(evaluateProject(project,.25)[0].opacity);
    expect((project.elements[0].motionBehaviors![0] as Extract<MotionBehavior,{type:'oscillation'}>).frequency).toBe(1);
    expect(scaleMotionTime([wave],.5)?.[0].duration).toBe(4);
  });
});

describe('motion persistence and composition',()=>{
  it('preserves timing through linked, independent, and archived scenes',async()=>{
    const project=sceneProject(),source=project.sequences[0];
    const path=createMotionBehavior('followPath',8);path.points=[{x:0,y:0},{x:80,y:0}];
    project.elements=[createElement('rectangle',{id:'traveler',sceneId:source.id,x:10,motionBehaviors:[path]})];
    const placement=placeLinkedScene(project,source.id,8);
    const linked=structuredClone(placement.project),scene=linked.sequences.find(item=>item.id===placement.sceneId)!;
    scene.duration=4;
    const virtual=materializeScenePlacements(linked).elements.find(item=>item.id===`${scene.id}::traveler`)!;
    expect(virtual.motionBehaviors?.[0]).toMatchObject({duration:4});
    const originalPose=evaluateProject(linked,9).find(item=>item.id===virtual.id)!;
    expect(originalPose.x).toBeCloseTo(30);
    const independent=makeSceneIndependent(linked,scene.id);
    const newPose=evaluateProject(independent,9).find(item=>item.sceneId===scene.id)!;
    expect(newPose.x).toBeCloseTo(originalPose.x);
    expect(newPose.motionBehaviors?.[0].id).not.toBe(path.id);
    const reopened=await loadProjectFile(new File([await saveProjectBlob(independent)],'motion.hyde'));
    expect(evaluateProject(reopened,9).find(item=>item.id===newPose.id)?.x).toBeCloseTo(30);
  });

  it('duplicates motion IDs and rejects out-of-range controls at the archive boundary',async()=>{
    const project=sceneProject(),sceneId=project.sequences[0].id;
    const motion=createMotionBehavior('oscillation',8);
    project.elements=[createElement('rectangle',{id:'swing',sceneId,motionBehaviors:[motion]})];
    const duplicated=duplicateScene(project,sceneId).project;
    expect(duplicated.elements[1].motionBehaviors?.[0].id).not.toBe(motion.id);
    await expect(saveProjectBlob(duplicated)).resolves.toBeInstanceOf(Blob);
    motion.frequency=1001;
    await expect(saveProjectBlob(project)).rejects.toThrow('frequency is too high');
  });
});
