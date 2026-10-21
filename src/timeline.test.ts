import { describe, expect, it } from 'vitest';
import { createElement, createProject } from './model';
import { moveTimelineClip, moveTimelineKey, rulerStep, rulerTicks, trimTimelineClip } from './timeline';

describe('timeline editing', () => {
  function twoClips() {
    const project = createProject();
    const first = createElement('rectangle', {start: 0, duration: 2});
    const second = createElement('ellipse', {start: 3, duration: 2});
    project.elements = [first, second];
    return {project, first, second};
  }

  it('adapts ruler labels to the screen scale', () => {
    expect(rulerStep(8, 1200)).toBe(1);
    expect(rulerStep(8, 2400)).toBe(.5);
    expect(rulerTicks(8, 2400).slice(0, 3).map(tick => tick.label)).toEqual(['0s', '0.5s', '1s']);
  });

  it('moves and trims later material only in ripple mode', () => {
    const {project, first, second} = twoClips();
    const normal = moveTimelineClip(project, first.id, 1, false);
    expect(normal.elements.find(e => e.id === second.id)?.start).toBe(3);
    const moved = moveTimelineClip(project, first.id, 1, true);
    expect(moved.elements.find(e => e.id === second.id)?.start).toBe(4);
    expect(moved.sequences[0].duration).toBe(9);
    const trimmed = trimTimelineClip(project, first.id, 3, true);
    expect(trimmed.elements.find(e => e.id === second.id)?.start).toBe(4);
    expect(trimmed.duration).toBe(9);
    expect(project.elements.find(e => e.id === second.id)?.start).toBe(3);
  });

  it('retimes a keyframe within its clip and keeps its identity', () => {
    const {project, first} = twoClips();
    first.tracks = [{property:'x',keyframes:[
      {id:'early',time:0,value:100,easing:'linear',direction:'inOut',mode:'smooth'},
      {id:'late',time:1,value:200,easing:'linear',direction:'inOut',mode:'smooth'}
    ]}];
    const retimed = moveTimelineKey(project, first.id, 'x', 'early', 1.5);
    expect(retimed.elements[0].tracks[0].keyframes.map(key => key.id)).toEqual(['late', 'early']);
    expect(retimed.elements[0].tracks[0].keyframes[1].time).toBe(1.5);
    expect(first.tracks[0].keyframes[0].time).toBe(0);
  });
});
