import {describe,expect,it} from 'vitest';
import {createElement,createProject} from './model';
import {recordingPlaybackProject} from './recording';

describe('recording playback mix',()=>{
  it('mutes existing sound only in the temporary recording mix',()=>{
    const project=createProject();
    project.elements=[createElement('audio',{id:'audio',muted:false}),createElement('video',{id:'video',muted:false}),createElement('text',{id:'text'})];
    const mix=recordingPlaybackProject(project,true);
    expect(mix.elements.map(element=>element.muted)).toEqual([true,true,undefined]);
    expect(project.elements.map(element=>element.muted)).toEqual([false,false,undefined]);
    expect(recordingPlaybackProject(project,false)).toBe(project);
  });
});
