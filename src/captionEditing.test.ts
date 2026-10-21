import {describe,expect,it} from 'vitest';
import {createProject} from './model';
import {addCaption,deleteCaption,editCaption} from './captionEditing';

describe('timed caption editing',()=>{
  it('adds and retimes captions on exact project frames within their scene',()=>{
    const base=createProject();
    const {project,caption}=addCaption(base,2.02);
    expect(caption.start).toBeCloseTo(2.0333333333);
    expect(caption.end).toBeCloseTo(4.0333333333);
    const changed=editCaption(project,caption.id,{text:'A new line',start:3,end:5.01});
    expect(changed.captions[0]).toMatchObject({text:'A new line',start:3,end:5});
    expect(base.captions).toHaveLength(0);
    expect(deleteCaption(changed,caption.id).captions).toHaveLength(0);
  });

  it('enforces scene bounds and one-frame duration',()=>{
    const base=createProject();
    const {project,caption}=addCaption(base,7.99);
    expect(caption.start).toBeCloseTo(8-1/30);
    expect(caption.end).toBe(8);
    expect(()=>editCaption(project,caption.id,{end:caption.start})).toThrow(/one frame/);
    expect(()=>editCaption(project,caption.id,{start:9})).toThrow(/inside its scene/);
  });
});
