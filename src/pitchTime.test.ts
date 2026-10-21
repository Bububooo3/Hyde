import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioBufferFromPcm, pcmFromAudioBuffer, processPitchTime } from './pitchTime';

const worklet = vi.hoisted(() => ({
  changes: [] as Array<{ active: boolean; input: number; output: number; rate: number; semitones: number }>,
  buffers: [] as Float32Array[][],
}));

vi.mock('signalsmith-stretch', () => ({
  default: async () => ({
    addBuffers: async (channels: Float32Array[]) => { worklet.buffers.push(channels); return channels[0].length / 48_000; },
    schedule: async (change: (typeof worklet.changes)[number]) => { worklet.changes.push(change); },
    connect: () => undefined,
    disconnect: () => undefined,
    dropBuffers: async () => undefined,
    port: { close: () => undefined },
  }),
}));

class FakeOfflineAudioContext {
  readonly audioWorklet = {};
  readonly destination = {};
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {}
  async startRendering() {
    return {
      sampleRate: this.sampleRate,
      numberOfChannels: this.numberOfChannels,
      getChannelData: () => new Float32Array(this.length),
    };
  }
}

const sampleRate = 48_000;
const tone = (frames = sampleRate) => ({
  sampleRate,
  channels: [Float32Array.from({ length: frames }, (_, n) => Math.sin(2 * Math.PI * 440 * n / sampleRate))],
});

describe('pitch/time processing contract', () => {
  const originalContext = globalThis.OfflineAudioContext;
  beforeEach(() => {
    worklet.changes.length = 0;
    worklet.buffers.length = 0;
    globalThis.OfflineAudioContext = FakeOfflineAudioContext as unknown as typeof OfflineAudioContext;
  });
  afterEach(() => { globalThis.OfflineAudioContext = originalContext; });

  it('keeps duration at pitch-only changes and schedules the independent semitone shift', async () => {
    const output = await processPitchTime(tone(), { speed: 1, pitchSemitones: 12 });
    expect(output.sampleRate).toBe(sampleRate);
    expect(output.channels).toHaveLength(1);
    expect(output.channels[0]).toHaveLength(sampleRate);
    expect(worklet.changes).toEqual([{ active: true, input: 0, output: 0, rate: 1, semitones: 12 }]);
  });

  it('halves duration at 2× speed without requesting a pitch shift', async () => {
    const output = await processPitchTime(tone(), { speed: 2, pitchSemitones: 0 });
    expect(output.channels[0]).toHaveLength(sampleRate / 2);
    expect(worklet.changes[0]).toMatchObject({ rate: 2, semitones: 0 });
  });

  it('retains all channels and computes the slowest supported duration exactly', async () => {
    const left = tone(1_001).channels[0];
    const right = new Float32Array(left.length).fill(.25);
    const output = await processPitchTime({ sampleRate, channels: [left, right] }, { speed: .25, pitchSemitones: -24 });
    expect(output.channels).toHaveLength(2);
    expect(output.channels[0]).toHaveLength(4_004);
    expect(worklet.buffers[0]).toHaveLength(2);
    expect(worklet.changes[0]).toMatchObject({ rate: .25, semitones: -24 });
  });

  it('copies unprocessed PCM without requiring AudioWorklet', async () => {
    const input = tone(256);
    const output = await processPitchTime(input, { speed: 1, pitchSemitones: 0 });
    expect(output.channels[0]).toEqual(input.channels[0]);
    expect(output.channels[0]).not.toBe(input.channels[0]);
    expect(worklet.changes).toHaveLength(0);
  });

  it('rejects invalid ranges, oversized renders, and cancellation before allocation', async () => {
    await expect(processPitchTime(tone(256), { speed: 0, pitchSemitones: 0 })).rejects.toThrow(RangeError);
    await expect(processPitchTime(tone(256), { speed: 1, pitchSemitones: 25 })).rejects.toThrow(RangeError);
    await expect(processPitchTime(tone(256), { speed: .25, pitchSemitones: 0, maxOutputFrames: 1_000 })).rejects.toThrow(/limit/);
    const controller = new AbortController();
    controller.abort();
    await expect(processPitchTime(tone(256), { speed: 2, pitchSemitones: 0, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns promptly when rendering is canceled', async () => {
    globalThis.OfflineAudioContext = class extends FakeOfflineAudioContext {
      override async startRendering(): Promise<never> { return new Promise(() => undefined); }
    } as unknown as typeof OfflineAudioContext;
    const controller = new AbortController();
    const pending = processPitchTime(tone(256), { speed: 2, pitchSemitones: 0, signal: controller.signal });
    await vi.waitFor(() => expect(worklet.changes).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('adapts AudioBuffer channel data without sharing mutable arrays', () => {
    const source = Float32Array.of(.5, -.25, .125);
    const input = { sampleRate, numberOfChannels: 1, getChannelData: () => source } as unknown as AudioBuffer;
    const pcm = pcmFromAudioBuffer(input);
    expect(pcm.channels[0]).toEqual(source);
    expect(pcm.channels[0]).not.toBe(source);
    const output = { copyToChannel: vi.fn() } as unknown as AudioBuffer;
    const context = { createBuffer: vi.fn(() => output) } as unknown as BaseAudioContext;
    expect(audioBufferFromPcm(context, pcm)).toBe(output);
    expect(context.createBuffer).toHaveBeenCalledWith(1, 3, sampleRate);
    expect(output.copyToChannel).toHaveBeenCalledWith(source, 0);
  });
});
