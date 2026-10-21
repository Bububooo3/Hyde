import { describe, expect, it } from 'vitest';
import { createAudioEffect } from './audioEffects';
import { createElement, createProject } from './model';
import { duplicateMediaClip, fadeGainAt, setMediaFades, setMediaSourceWindow, setMediaSpeed, sourceWindow, splitMediaClip, waveformPeaks } from './audioClipEditing';

function fixture() {
  const project = createProject();
  project.duration = 20;
  project.assets = [{ id: 'take', name: 'take.wav', mime: 'audio/wav', kind: 'audio', dataUrl: 'data:audio/wav;base64,AA==', duration: 12 }];
  const element = createElement('audio', { id: 'clip', assetId: 'take', start: 2, duration: 4, sourceOffset: 1, speed: 2, fadeIn: .5, fadeOut: 1, audioEffects: [createAudioEffect('echo')] });
  project.elements = [element];
  return { project, element };
}

describe('audio clip editing', () => {
  it('keeps a source window aligned with audio, picture, fades and keyframes when speed changes',()=>{
    const {project,element}=fixture();
    element.tracks=[{property:'volume',keyframes:[{id:'last',time:4,value:1,easing:'linear',direction:'inOut',mode:'smooth'}]}];
    const faster=setMediaSpeed(project,'clip',4);
    expect(faster.elements[0]).toMatchObject({speed:4,duration:2,sourceOffset:1,fadeIn:.25,fadeOut:.5});
    expect(faster.elements[0].tracks[0].keyframes[0].time).toBe(2);
    expect(sourceWindow(faster.elements[0],12)).toEqual({inTime:1,outTime:9});
    expect(project.elements[0].duration).toBe(4);
    expect(() => setMediaSpeed(project,'clip',5)).toThrow(/between 0.25 and 4/);
  });
  it('reads and changes the source range in source seconds without changing linked playback speed', () => {
    const { project, element } = fixture();
    expect(sourceWindow(element, 12)).toEqual({ inTime: 1, outTime: 9 });
    const result = setMediaSourceWindow(project, 'clip', 3, 9);
    expect(result.elements[0]).toMatchObject({ sourceOffset: 3, duration: 3, speed: 2, fadeIn: .5, fadeOut: 1 });
    expect(project.elements[0].sourceOffset).toBe(1);
    expect(() => setMediaSourceWindow(project, 'clip', 11, 13)).toThrow(/source range/);
    expect(() => setMediaSourceWindow(project, 'clip', 3, 3.02)).toThrow(/one project frame/);
  });

  it('bounds fades and multiplies overlapping ramps', () => {
    const { project, element } = fixture();
    expect(fadeGainAt(element, 2)).toBe(0);
    expect(fadeGainAt(element, 2.25)).toBe(.5);
    expect(fadeGainAt(element, 5.5)).toBe(.5);
    expect(fadeGainAt(element, 6)).toBe(0);
    expect(fadeGainAt(element, 6.1)).toBe(0);
    const result = setMediaFades(project, 'clip', 2.5, 2.5);
    expect(fadeGainAt(result.elements[0], 4)).toBeCloseTo(.64);
    expect(() => setMediaFades(project, 'clip', 5, 0)).toThrow(/inside the clip/);
  });

  it('duplicates an editable clip without sharing keyframe or effect identities', () => {
    const { project, element } = fixture();
    element.tracks = [{ property: 'volume', keyframes: [{ id: 'key', time: 0, value: .4, easing: 'linear', direction: 'inOut', mode: 'smooth' }] }];
    const { project: result, clipId } = duplicateMediaClip(project, 'clip');
    expect(result.elements).toHaveLength(2);
    const copy = result.elements.find(item => item.id === clipId)!;
    expect(copy).toMatchObject({ assetId: 'take', start: 6, sourceOffset: 1, speed: 2, fadeIn: .5, fadeOut: 1 });
    expect(copy.tracks[0].keyframes[0].id).not.toBe('key');
    expect(copy.audioEffects?.[0].id).not.toBe(element.audioEffects?.[0].id);
  });

  it('splits linked source timing and volume automation at a project time', () => {
    const { project, element } = fixture();
    element.tracks = [{ property: 'volume', keyframes: [
      { id: 'k0', time: 0, value: 0, easing: 'linear', direction: 'inOut', mode: 'smooth' },
      { id: 'k1', time: 4, value: 1, easing: 'linear', direction: 'inOut', mode: 'smooth' },
    ] }];
    const { project: result, rightId } = splitMediaClip(project, 'clip', 4);
    const [left, right] = result.elements;
    expect(left).toMatchObject({ start: 2, duration: 2, sourceOffset: 1, fadeIn: .5, fadeOut: 0 });
    expect(right).toMatchObject({ id: rightId, start: 4, duration: 2, sourceOffset: 5, speed: 2, fadeIn: 0, fadeOut: 1 });
    expect(left.tracks[0].keyframes.at(-1)?.value).toBeCloseTo(.5);
    expect(right.tracks[0].keyframes[0]).toMatchObject({ time: 0, value: .5 });
    expect(() => splitMediaClip(project, 'clip', 2.01)).toThrow(/one frame/);
  });

  it('extracts a bounded waveform from PCM channels', () => {
    const data = new Float32Array([0, .2, -.8, .3, .1, -.4, .6, 0]);
    const fake = { length: data.length, numberOfChannels: 1, getChannelData: () => data } as unknown as AudioBuffer;
    expect(waveformPeaks(fake, 4)).toEqual([expect.closeTo(.2), expect.closeTo(.8), expect.closeTo(.4), expect.closeTo(.6)]);
  });
});
