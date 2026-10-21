import { describe, expect, it } from 'vitest';
import { evaluateProject } from './engine';
import { hasProjectAudio } from './mediaExportAudio';
import { assignSceneOwnership, captionWindow, createElement, createProject, elementWindow } from './model';

describe('source scene boundaries', () => {
  it('hide crossing visual, audio, and caption content without changing their authored timing', () => {
    const project = createProject('Boundaries');
    const first = project.sequences[0];
    first.duration = 2;
    project.sequences.push({id:'next',name:'Next',start:2,duration:2,color:'#ffc857'});
    project.duration = 4;
    project.assets.push({id:'sound',name:'tone.wav',kind:'audio',mime:'audio/wav',dataUrl:'data:audio/wav;base64,AQ=='});
    project.elements.push(createElement('rectangle',{id:'shape',sceneId:first.id,start:0,duration:4}));
    project.elements.push(createElement('audio',{id:'tone',sceneId:first.id,assetId:'sound',start:1,duration:3}));
    project.captions.push({id:'caption',sceneId:first.id,start:1,end:3,text:'Opening'});

    expect(elementWindow(project,project.elements[0])).toEqual({start:0,end:2});
    expect(captionWindow(project,project.captions[0])).toEqual({start:1,end:2});
    expect(evaluateProject(project,1.9).map(element=>element.id)).toEqual(['shape','tone']);
    expect(evaluateProject(project,2.1)).toEqual([]);
    expect(hasProjectAudio(project,2.1,3)).toBe(false);
    expect(project.elements[0].duration).toBe(4);
    expect(project.captions[0].end).toBe(3);

    first.duration = 3;
    expect(evaluateProject(project,2.1).map(element=>element.id)).toEqual(['shape','tone']);
    expect(hasProjectAudio(project,2.1,3)).toBe(true);
  });

  it('keeps legacy content in an uncovered gap globally timed', () => {
    const project=createProject();
    project.sequences[0].duration=1;
    project.elements.push(createElement('rectangle',{id:'gap',start:2,duration:1}));
    const opened=assignSceneOwnership(project);
    expect(opened.elements[0].sceneId).toBeUndefined();
    expect(evaluateProject(opened,2.5).map(element=>element.id)).toEqual(['gap']);
  });
});
