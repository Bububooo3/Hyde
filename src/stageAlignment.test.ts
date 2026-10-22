import {describe,expect,it} from 'vitest';
import {createElement} from './model';
import {snapStagePosition} from './stageAlignment';

describe('stage drag alignment',()=>{
  it('snaps transformed artwork edges to a peer and reports visible guides',()=>{
    const moving=createElement('rectangle',{id:'moving',sceneId:'scene',width:100,height:80,x:298,y:100});
    const peer=createElement('rectangle',{id:'peer',sceneId:'scene',width:100,height:80,x:400,y:280});
    const result=snapStagePosition(moving,[peer],{x:298,y:100},{width:960,height:540},4);
    expect(result.position.x).toBe(300);
    expect(result.guides.x).toBe(350);
    expect(result.guides.y).toBeUndefined();
  });

  it('snaps centers to stage center and ignores remote scenes',()=>{
    const moving=createElement('ellipse',{id:'moving',sceneId:'one',width:100,height:100,x:476,y:269});
    const remote=createElement('ellipse',{id:'remote',sceneId:'two',width:100,height:100,x:477,y:269});
    expect(snapStagePosition(moving,[remote],{x:476,y:269},{width:960,height:540},5)).toEqual({position:{x:480,y:270},guides:{x:480,y:270}});
  });
});
