import {describe,expect,it} from 'vitest';
import {composedSceneFrameTransform,mapSceneFramePoint,sceneFrameAffine,sceneFrameSvgTransform,sceneFrameTransform,unmapSceneFramePoint} from './sceneFrame';
import {createProject} from './model';

describe('placement viewport',()=>{
  const project={width:400,height:200};
  const frame={x:0,y:0,width:200,height:200};
  it('fits without distorting and centers spare height',()=>{
    expect(sceneFrameTransform(project,{frame})).toEqual({x:0,y:50,scaleX:.5,scaleY:.5});
  });
  it('fills by cropping and stretches only when selected',()=>{
    expect(sceneFrameTransform(project,{frame,frameFit:'fill'})).toEqual({x:-100,y:0,scaleX:1,scaleY:1});
    expect(sceneFrameTransform(project,{frame,frameFit:'stretch'})).toEqual({x:0,y:0,scaleX:.5,scaleY:1});
  });
  it('composes the outer placement and a framed linked source',()=>{
    const story=createProject();story.width=400;story.height=200;
    story.sequences=[
      {id:'source',name:'Source',start:0,duration:8,color:'#000'},
      {id:'inner',name:'Inner',start:8,duration:8,color:'#000',sourceSceneId:'source',frame:{x:0,y:0,width:200,height:200}},
      {id:'outer',name:'Outer',start:16,duration:8,color:'#000',sourceSceneId:'inner',frame:{x:200,y:0,width:200,height:100}},
    ];
    expect(composedSceneFrameTransform(story,story.sequences[2])).toEqual({x:200,y:25,scaleX:.25,scaleY:.25});
  });

  it('rotates a fitted viewport around the frame center and has an exact inverse',()=>{
    const story=createProject();story.width=400;story.height=200;
    const scene={id:'rotated',name:'Rotated',start:0,duration:8,color:'#000',frame:{x:100,y:50,width:200,height:100},frameRotation:90};
    story.sequences=[scene];
    const topLeft=mapSceneFramePoint(story,scene,{x:0,y:0});
    expect(topLeft.x).toBeCloseTo(250);expect(topLeft.y).toBeCloseTo(0);
    const center=mapSceneFramePoint(story,scene,{x:200,y:100});
    expect(center.x).toBeCloseTo(200);expect(center.y).toBeCloseTo(100);
    const restored=unmapSceneFramePoint(story,scene,topLeft);
    expect(restored.x).toBeCloseTo(0);expect(restored.y).toBeCloseTo(0);
    const [a,b,c,d,e,f]=sceneFrameSvgTransform(story,scene).slice(7,-1).split(' ').map(Number);
    expect(a*400+c*200+e).toBeCloseTo(mapSceneFramePoint(story,scene,{x:400,y:200}).x);
    expect(b*400+d*200+f).toBeCloseTo(mapSceneFramePoint(story,scene,{x:400,y:200}).y);
  });

  it('composes rotations through nested source viewports without losing their order',()=>{
    const story=createProject();story.width=400;story.height=200;
    story.sequences=[
      {id:'source',name:'Source',start:0,duration:8,color:'#000'},
      {id:'inner',name:'Inner',start:8,duration:8,color:'#000',sourceSceneId:'source',frame:{x:20,y:40,width:200,height:100},frameRotation:90},
      {id:'outer',name:'Outer',start:16,duration:8,color:'#000',sourceSceneId:'inner',frame:{x:150,y:20,width:200,height:160},frameFit:'stretch',frameRotation:-30},
    ];
    const [inner,outer]=story.sequences.slice(1);
    const point={x:93,y:37};
    const innerMatrix=sceneFrameAffine(story,inner),outerMatrix=sceneFrameAffine(story,outer);
    const innerMapped={x:innerMatrix.a*point.x+innerMatrix.c*point.y+innerMatrix.e,y:innerMatrix.b*point.x+innerMatrix.d*point.y+innerMatrix.f};
    const expected={x:outerMatrix.a*innerMapped.x+outerMatrix.c*innerMapped.y+outerMatrix.e,y:outerMatrix.b*innerMapped.x+outerMatrix.d*innerMapped.y+outerMatrix.f};
    const actual=mapSceneFramePoint(story,outer,point);
    expect(actual.x).toBeCloseTo(expected.x);expect(actual.y).toBeCloseTo(expected.y);
    const restored=unmapSceneFramePoint(story,outer,actual);
    expect(restored.x).toBeCloseTo(point.x);expect(restored.y).toBeCloseTo(point.y);
  });
});
