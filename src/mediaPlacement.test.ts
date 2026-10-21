import {expect,it} from 'vitest';
import {createElement,createProject} from './model';
import {applyMediaFill} from './mediaPlacement';

it('fills an existing shape while preserving its timing, path, animation, and attachment',()=>{
  const project=createProject('Media fill');
  const shape=createElement('ellipse',{id:'shape',x:42,start:1,duration:3,sceneId:project.sequences[0].id});
  project.elements.push(shape);
  const asset={id:'texture',name:'paper.png',mime:'image/png',kind:'image' as const,dataUrl:'data:image/png;base64,AA=='};
  const result=applyMediaFill(project,'shape',asset);
  expect(result.elements).toHaveLength(1);
  expect(result.elements[0]).toMatchObject({id:'shape',kind:'ellipse',x:42,start:1,duration:3,assetId:'texture',mediaFit:'fill',mediaOpacity:1});
  expect(result.assets).toEqual([asset]);
  expect(project.elements[0].assetId).toBeUndefined();
  expect(()=>applyMediaFill(result,'shape',asset)).toThrow(/already exists/);
});
