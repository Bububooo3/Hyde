import {describe,expect,it} from 'vitest';
import {createElement,createProject} from './model';
import {effectiveRenderOptimization,projectRenderOptimization,staticVisualSignature} from './renderOptimization';

describe('render optimization',()=>{
  it('automatically classifies still art and animated parts',()=>{
    const project=createProject();
    const still=createElement('rectangle');
    const animated=createElement('ellipse',{tracks:[{property:'x',keyframes:[{id:'move',time:0,value:100,easing:'linear',direction:'inOut',mode:'smooth'}]}]});
    project.elements=[still,animated];
    expect(still.optimize).toBe('auto');
    expect(projectRenderOptimization(project,still)).toBe('static');
    expect(projectRenderOptimization(project,animated)).toBe('motion');
  });

  it('inherits assembly choices while keeping video and timed text live',()=>{
    const parent=createElement('group',{optimize:'static'});
    const child=createElement('rectangle',{parentId:parent.id});
    const parts=new Map([parent,child].map(element=>[element.id,element]));
    expect(effectiveRenderOptimization(child,parts)).toBe('static');
    parent.optimize='motion';
    expect(effectiveRenderOptimization(child,parts)).toBe('motion');
    child.optimize='static';
    expect(effectiveRenderOptimization(child,parts)).toBe('static');
    expect(effectiveRenderOptimization(child,parts,{id:'movie',name:'movie',mime:'video/mp4',kind:'video',dataUrl:'data:'})).toBe('motion');
    const text=createElement('text',{optimize:'static',textAnimation:{unit:'word',effect:'fade',direction:'in',start:0,duration:1,stagger:0,easing:'linear',easingDirection:'inOut',distance:0,seed:1,amplitude:0,frequency:1}});
    expect(effectiveRenderOptimization(text,new Map([[text.id,text]]))).toBe('motion');
  });

  it('invalidates a static signature for pose, appearance, and flow shape changes',()=>{
    const text=createElement('text',{flowAroundId:'shape'});
    const target=createElement('ellipse',{id:'shape'});
    const original=staticVisualSignature(text,target);
    expect(staticVisualSignature({...text,x:text.x+1},target)).not.toBe(original);
    expect(staticVisualSignature({...text,fill:'#ff0000'},target)).not.toBe(original);
    expect(staticVisualSignature(text,{...target,x:target.x+1})).not.toBe(original);
  });
});
