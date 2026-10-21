import { describe, expect, it, vi } from 'vitest';
import { AUDIO_EFFECT_BOUNDS, MAX_EFFECT_TAIL, boundedAudioEffect, connectAudioEffects, createAudioEffect } from './audioEffects';
import type { AudioEffect } from './model';

class FakeNode {
  connections: FakeNode[] = [];
  disconnected = false;
  gain = { value: 1 }; delayTime = { value: 0 }; frequency = { value: 0 };
  threshold = { value: 0 }; ratio = { value: 0 }; knee = { value: 0 };
  attack = { value: 0 }; release = { value: 0 }; Q = { value: 0 };
  curve: Float32Array | null = null; oversample = 'none'; type = '';
  buffer: unknown = null; normalize = false;
  start = vi.fn(); stop = vi.fn();
  constructor(readonly kind: string) {}
  connect(destination: FakeNode) { this.connections.push(destination); return destination; }
  disconnect() { this.disconnected = true; this.connections = []; }
}
class FakeContext {
  nodes: FakeNode[] = [];
  sampleRate = 48000;
  make(kind: string) { const node = new FakeNode(kind); this.nodes.push(node); return node; }
  createGain() { return this.make('gain'); }
  createDelay() { return this.make('delay'); }
  createOscillator() { return this.make('oscillator'); }
  createDynamicsCompressor() { return this.make('compressor'); }
  createWaveShaper() { return this.make('distortion'); }
  createBiquadFilter() { return this.make('equalizer'); }
  createConvolver() { return this.make('reverb'); }
  createBuffer(_channels: number, length: number) {
    const data = [new Float32Array(length), new Float32Array(length)];
    return { getChannelData(channel: number) { return data[channel]; } };
  }
}

const asContext = (context: FakeContext) => context as unknown as BaseAudioContext;
const asNode = (node: FakeNode) => node as unknown as AudioNode;

describe('clip audio effects', () => {
  it('provides bounded editable defaults for all supported effect types', () => {
    for (const type of Object.keys(AUDIO_EFFECT_BOUNDS) as AudioEffect['type'][]) {
      const effect = createAudioEffect(type);
      expect(effect.type).toBe(type);
      expect(effect.enabled).toBe(true);
      for (const [field, [minimum, maximum]] of Object.entries(AUDIO_EFFECT_BOUNDS[type])) {
        const value = (effect as unknown as Record<string, number>)[field];
        expect(value).toBeGreaterThanOrEqual(minimum);
        expect(value).toBeLessThanOrEqual(maximum);
      }
    }
  });

  it('keeps bypassed effects out of the graph and processes active effects in order', () => {
    const context = new FakeContext(), source = context.make('source'), destination = context.make('destination');
    const echo = createAudioEffect('echo'), compressor = createAudioEffect('compressor'), distortion = createAudioEffect('distortion');
    echo.enabled = false;
    const graph = connectAudioEffects(asContext(context), asNode(source), asNode(destination), [echo, compressor, distortion]);
    expect(context.nodes.filter(node => node.kind === 'delay')).toHaveLength(0);
    expect(context.nodes.findIndex(node => node.kind === 'compressor')).toBeLessThan(context.nodes.findIndex(node => node.kind === 'distortion'));
    expect(source.connections).toHaveLength(1);
    expect(destination.connections).toHaveLength(0);
    expect(graph.tailSeconds).toBe(0);
    graph.dispose();
    expect(context.nodes.filter(node => node !== source && node !== destination).every(node => node.disconnected)).toBe(true);
    graph.dispose();
  });

  it('builds chorus, echo, equalizer and reverb with bounded tails and disposes modulation', () => {
    const context = new FakeContext(), source = context.make('source'), destination = context.make('destination');
    const effects = [createAudioEffect('chorus'), createAudioEffect('echo'), createAudioEffect('equalizer'), createAudioEffect('reverb')];
    const graph = connectAudioEffects(asContext(context), asNode(source), asNode(destination), effects);
    const oscillator = context.nodes.find(node => node.kind === 'oscillator')!;
    expect(oscillator.start).toHaveBeenCalledOnce();
    expect(context.nodes.filter(node => node.kind === 'equalizer')).toHaveLength(3);
    expect(context.nodes.filter(node => node.kind === 'reverb')).toHaveLength(1);
    expect(graph.tailSeconds).toBeGreaterThan(1);
    expect(graph.tailSeconds).toBeLessThanOrEqual(MAX_EFFECT_TAIL);
    graph.dispose();
    expect(oscillator.stop).toHaveBeenCalledOnce();
  });

  it('clamps an in-memory effect before it touches browser audio nodes', () => {
    const unsafe = { ...createAudioEffect('echo'), delay: 900, feedback: 1, mix: -5 };
    const bounded = boundedAudioEffect(unsafe);
    expect(bounded).toMatchObject({ delay: 1, feedback: .8, mix: 0 });
    const context = new FakeContext(), source = context.make('source'), destination = context.make('destination');
    const graph = connectAudioEffects(asContext(context), asNode(source), asNode(destination), [unsafe]);
    expect(context.nodes.find(node => node.kind === 'delay')?.delayTime.value).toBe(1);
    expect(graph.tailSeconds).toBe(MAX_EFFECT_TAIL);
    graph.dispose();
  });
});
