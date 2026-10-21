import { describe, expect, it } from 'vitest';
import { cameraToStage, evaluateCamera, evaluateCameraForScene, stageToCamera } from './engine';
import { createProject, type Keyframe, type SequenceCamera } from './model';

const key = (time: number, value: number): Keyframe => ({ id: `${time}:${value}`, time, value, easing: 'linear', direction: 'in', mode: 'smooth' });

describe('sequence camera evaluation', () => {
  it('keeps old projects centered and untransformed, including after a resize', () => {
    const project = createProject();
    expect(evaluateCamera(project, 3)).toEqual({ x: 960, y: 540, zoom: 1, rotation: 0 });
    project.width = 720;
    project.height = 720;
    expect(evaluateCamera(project, 3)).toEqual({ x: 360, y: 360, zoom: 1, rotation: 0 });
    expect(cameraToStage({ x: 21, y: 53 }, evaluateCamera(project, 3), project)).toEqual({ x: 21, y: 53 });
  });

  it('evaluates tracks at sequence-local time, cuts to the next camera, and holds in gaps', () => {
    const project = createProject();
    const firstCamera: SequenceCamera = { x: 480, y: 270, zoom: 1, rotation: 0, tracks: [
      { property: 'x', keyframes: [key(0, 480), key(2, 680)] },
      { property: 'zoom', keyframes: [key(0, 1), key(2, 2)] },
      { property: 'rotation', keyframes: [key(0, 350), key(2, 10)] },
    ] };
    project.sequences = [
      { id: 'one', name: 'One', start: 0, duration: 2, color: '#000', camera: firstCamera },
      { id: 'two', name: 'Two', start: 4, duration: 2, color: '#000', camera: { x: 100, y: 200, zoom: 3, rotation: 45, tracks: [] } },
    ];
    expect(evaluateCamera(project, 1)).toMatchObject({ x: 580, zoom: 1.5, rotation: 360 });
    expect(evaluateCamera(project, 3)).toMatchObject({ x: 680, zoom: 2, rotation: 370 });
    expect(evaluateCamera(project, 4)).toEqual({ x: 100, y: 200, zoom: 3, rotation: 45 });
    expect(evaluateCamera(project, 30)).toEqual({ x: 100, y: 200, zoom: 3, rotation: 45 });
  });

  it('maps world/stage points reversibly with pan, zoom, and rotation', () => {
    const project = createProject();
    const camera = { x: 400, y: 100, zoom: 2, rotation: 90 };
    expect(cameraToStage({ x: 400, y: 100 }, camera, project)).toEqual({ x: 960, y: 540 });
    const point = { x: 430, y: 120 };
    const stage = cameraToStage(point, camera, project);
    expect(stage.x).toBeCloseTo(1000);
    expect(stage.y).toBeCloseTo(480);
    const world = stageToCamera(stage, camera, project);
    expect(world.x).toBeCloseTo(point.x);
    expect(world.y).toBeCloseTo(point.y);
  });

  it('uses the later sequence while sequences overlap and clamps invalid zoom', () => {
    const project = createProject();
    project.sequences = [
      { id: 'first', name: 'First', start: 0, duration: 8, color: '#000', camera: { x: 1, y: 2, zoom: 1, rotation: 0, tracks: [] } },
      { id: 'second', name: 'Second', start: 4, duration: 3, color: '#000', camera: { x: 3, y: 4, zoom: 0, rotation: 0, tracks: [] } },
    ];
    expect(evaluateCamera(project, 4)).toMatchObject({ x: 3, y: 4, zoom: .01 });
    expect(evaluateCamera(project, 7)).toMatchObject({ x: 1, y: 2, zoom: 1 });
  });

  it('maps a camera through nested source ranges',()=>{
    const project=createProject();
    project.sequences=[
      {id:'source',name:'Source',start:0,duration:8,color:'#000',camera:{x:0,y:270,zoom:1,rotation:0,tracks:[{property:'x',keyframes:[key(0,0),key(8,800)]}]}},
      {id:'inner',name:'Inner',start:8,duration:4,color:'#000',sourceSceneId:'source',sourceIn:2,sourceOut:6},
      {id:'outer',name:'Outer',start:12,duration:8,color:'#000',sourceSceneId:'inner',sourceIn:1,sourceOut:3},
    ];
    expect(evaluateCameraForScene(project,project.sequences[2],16).x).toBeCloseTo(400);
  });
});
