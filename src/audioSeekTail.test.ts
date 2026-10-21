import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioPitchPlan } from './audioPitch';
import { seekEffectHistory, renderSeekEffectTail } from './audioSeekTail';
import { mediaAudioSegments } from './mediaAudioSegments';
import { createElement, createProject, type AudioEffect } from './model';

const echo: AudioEffect = { id: 'echo', type: 'echo', enabled: true, delay: .5, feedback: .5, mix: .4 };

class FakeParam {
  value = 1;
  events: { value: number; time: number }[] = [];
  setValueAtTime(value: number, time: number) { this.events.push({ value, time }); this.value = value; }
  linearRampToValueAtTime(value: number, time: number) { this.events.push({ value, time }); this.value = value; }
}
class FakeNode {
  connect = vi.fn();
  disconnect = vi.fn();
}
class FakeBuffer {
  duration: number;
  channels: Float32Array[];
  constructor(channels: number, length: number, sampleRate: number, fill = 0) {
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: channels }, () => new Float32Array(length).fill(fill));
  }
  getChannelData(channel: number) { return this.channels[channel]; }
  copyToChannel(data: Float32Array, channel: number) { this.channels[channel].set(data); }
}
class FakeOfflineAudioContext {
  static last: FakeOfflineAudioContext;
  sampleRate: number;
  length: number;
  destination = new FakeNode();
  sources: (FakeNode & { buffer: AudioBuffer | null; playbackRate: FakeParam; loop: boolean; loopStart: number; loopEnd: number; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> })[] = [];
  gains: (FakeNode & { gain: FakeParam })[] = [];
  constructor(_channels: number, length: number, sampleRate: number) {
    this.length = length; this.sampleRate = sampleRate; FakeOfflineAudioContext.last = this;
  }
  createBufferSource() {
    const source = Object.assign(new FakeNode(), { buffer: null as AudioBuffer | null, playbackRate: new FakeParam(), loop: false, loopStart: 0, loopEnd: 0, start: vi.fn(), stop: vi.fn() });
    this.sources.push(source); return source;
  }
  createGain() { const gain = Object.assign(new FakeNode(), { gain: new FakeParam() }); this.gains.push(gain); return gain; }
  createDelay() { return Object.assign(new FakeNode(), { delayTime: new FakeParam() }); }
  createBuffer(channels: number, length: number, sampleRate: number) { return new FakeBuffer(channels, length, sampleRate); }
  async startRendering() { return new FakeBuffer(2, this.length, this.sampleRate, .25); }
}

describe('bounded live seek effect history', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('selects active and recently ended effects, but no dry or expired history', () => {
    const project = createProject();
    project.duration = 9; project.sequences[0].duration = 9;
    project.assets = [{ id: 'asset', name: 'sound.wav', kind: 'audio', mime: 'audio/wav', dataUrl: 'data:audio/wav;base64,AA==', duration: 10 }];
    project.elements = [
      createElement('audio', { id: 'echo', assetId: 'asset', start: 0, duration: 2, audioEffects: [echo] }),
      createElement('audio', { id: 'dry', assetId: 'asset', start: 0, duration: 8 }),
    ];
    const segments = mediaAudioSegments(project, 0, 9);
    const recent = seekEffectHistory(segments, 2.4);
    expect(recent.segments.map(segment => segment.element.id)).toEqual(['echo']);
    expect(recent.tailDuration).toBeCloseTo(2.6, 4);
    expect(seekEffectHistory(segments, 5.1).segments).toHaveLength(0);
    expect(seekEffectHistory(segments, 0).segments).toHaveLength(0);
  });

  it('keeps isolated preview history even for a muted object', () => {
    const project = createProject();
    project.duration = 5; project.sequences[0].duration = 5;
    project.assets = [{ id: 'asset', name: 'sound.wav', kind: 'audio', mime: 'audio/wav', dataUrl: 'data:audio/wav;base64,AA==', duration: 10 }];
    project.elements = [
      createElement('audio', { id: 'selected', assetId: 'asset', duration: 2, muted: true, audioEffects: [echo] }),
      createElement('audio', { id: 'other', assetId: 'asset', duration: 2, audioEffects: [echo] }),
    ];
    const segments = mediaAudioSegments(project, 0, 5, 'selected');
    expect(seekEffectHistory(segments, 1).segments.map(segment => segment.element.id)).toEqual(['selected']);
  });

  it('rebuilds fades before effects, holds volume through the tail, and returns only post-seek samples', async () => {
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
    const project = createProject();
    project.duration = 6; project.sequences[0].duration = 6;
    const element = createElement('audio', {
      id: 'clip', assetId: 'asset', start: 0, duration: 2, sourceOffset: 1, speed: 1.5,
      fadeIn: .5, fadeOut: .5, volume: .6, audioEffects: [echo],
    });
    const asset = { id: 'asset', name: 'sound.wav', kind: 'audio' as const, mime: 'audio/wav', dataUrl: 'data:audio/wav;base64,AA==', duration: 10 };
    project.assets = [asset]; project.elements = [element];
    const buffer = new FakeBuffer(2, 10 * 48_000, 48_000) as unknown as AudioBuffer;
    const output = await renderSeekEffectTail(project, 2.2, [{ segment: { element, asset, start: 0, end: 2 }, buffer, originalDuration: 10, plan: audioPitchPlan(element) }]);
    const offline = FakeOfflineAudioContext.last;
    expect(offline.sources).toHaveLength(1);
    expect(offline.sources[0].start).toHaveBeenCalledWith(0, 1);
    expect(offline.sources[0].stop).toHaveBeenCalledWith(2);
    expect(offline.sources[0].playbackRate.value).toBe(1.5);
    expect(offline.gains[0].gain.events.at(-1)?.value).toBe(0);
    expect(offline.gains[1].gain.events.at(-1)?.value).toBeCloseTo(.6, 4);
    expect(output?.duration).toBeCloseTo(2.8, 4);
    expect(output?.getChannelData(0)[0]).toBeCloseTo(.25, 4);
    expect(offline.sources[0].disconnect).toHaveBeenCalled();
  });
});
