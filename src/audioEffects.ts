import { uid } from './model';
import type { AudioEffect, AudioEffectType } from './model';

export const MAX_AUDIO_EFFECTS = 16;
export const MAX_EFFECT_TAIL = 4;

const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
const limit = (value: number, min: number, max: number, fallback: number) =>
  Math.min(max, Math.max(min, finite(value, fallback)));

/** The same bounds are used by import validation and the playback graph. */
export const AUDIO_EFFECT_BOUNDS = {
  echo: { delay: [.05, 1], feedback: [0, .8], mix: [0, 1] },
  chorus: { rate: [.1, 3], depth: [0, .008], delay: [.01, .03], mix: [0, 1] },
  compressor: { threshold: [-60, 0], ratio: [1, 20], knee: [0, 40], attack: [.001, .1], release: [.01, 1] },
  distortion: { drive: [0, 1], mix: [0, 1] },
  equalizer: { low: [-24, 24], mid: [-24, 24], high: [-24, 24] },
  reverb: { seconds: [.1, 2.5], decay: [.25, 5], mix: [0, 1] },
} as const;

const EFFECT_DEFAULTS = {
  echo: { delay: .28, feedback: .35, mix: .3 },
  chorus: { rate: .8, depth: .003, delay: .018, mix: .35 },
  compressor: { threshold: -24, ratio: 3, knee: 12, attack: .012, release: .25 },
  distortion: { drive: .35, mix: .25 },
  equalizer: { low: 0, mid: 0, high: 0 },
  reverb: { seconds: 1.3, decay: 2, mix: .25 },
} as const;

export function createAudioEffect<T extends AudioEffectType>(type: T): Extract<AudioEffect, { type: T }>;
export function createAudioEffect(type: AudioEffectType): AudioEffect {
  const common = { id: uid(), enabled: true };
  switch (type) {
    case 'echo': return { ...common, type, ...EFFECT_DEFAULTS.echo };
    case 'chorus': return { ...common, type, ...EFFECT_DEFAULTS.chorus };
    case 'compressor': return { ...common, type, ...EFFECT_DEFAULTS.compressor };
    case 'distortion': return { ...common, type, ...EFFECT_DEFAULTS.distortion };
    case 'equalizer': return { ...common, type, ...EFFECT_DEFAULTS.equalizer };
    case 'reverb': return { ...common, type, ...EFFECT_DEFAULTS.reverb };
  }
}

/** Protect playback from in-memory edits or a hand-authored portable project. */
export function boundedAudioEffect(effect: AudioEffect): AudioEffect {
  const common = { id: effect.id, enabled: effect.enabled, type: effect.type };
  const bound = (field: string, value: number) => {
    const pair = (AUDIO_EFFECT_BOUNDS[effect.type] as Record<string, readonly [number, number]>)[field];
    return limit(value, pair[0], pair[1], (EFFECT_DEFAULTS[effect.type] as unknown as Record<string, number>)[field]);
  };
  switch (effect.type) {
    case 'echo': return { ...common, type: 'echo', delay: bound('delay', effect.delay), feedback: bound('feedback', effect.feedback), mix: bound('mix', effect.mix) };
    case 'chorus': return { ...common, type: 'chorus', rate: bound('rate', effect.rate), depth: bound('depth', effect.depth), delay: bound('delay', effect.delay), mix: bound('mix', effect.mix) };
    case 'compressor': return { ...common, type: 'compressor', threshold: bound('threshold', effect.threshold), ratio: bound('ratio', effect.ratio), knee: bound('knee', effect.knee), attack: bound('attack', effect.attack), release: bound('release', effect.release) };
    case 'distortion': return { ...common, type: 'distortion', drive: bound('drive', effect.drive), mix: bound('mix', effect.mix) };
    case 'equalizer': return { ...common, type: 'equalizer', low: bound('low', effect.low), mid: bound('mid', effect.mid), high: bound('high', effect.high) };
    case 'reverb': return { ...common, type: 'reverb', seconds: bound('seconds', effect.seconds), decay: bound('decay', effect.decay), mix: bound('mix', effect.mix) };
  }
}

export interface AudioEffectsGraph {
  /** The longest audible effect tail after its source stops. */
  tailSeconds: number;
  dispose(): void;
}

/** An ordered, clip-local chain. Disabled effects leave the signal untouched. */
export function connectAudioEffects(
  context: BaseAudioContext,
  source: AudioNode,
  destination: AudioNode,
  effects: readonly AudioEffect[] | undefined,
): AudioEffectsGraph {
  const nodes: AudioNode[] = [];
  const oscillators: OscillatorNode[] = [];
  const own = <T extends AudioNode>(node: T): T => { nodes.push(node); return node; };
  let previous = source;
  let tailSeconds = 0;

  function wetDry(input: AudioNode, output: AudioNode, wetSource: AudioNode, mix: number) {
    const dry = own(context.createGain()), wet = own(context.createGain());
    dry.gain.value = 1 - mix; wet.gain.value = mix;
    input.connect(dry); dry.connect(output);
    wetSource.connect(wet); wet.connect(output);
  }

  for (const raw of (effects ?? []).slice(0, MAX_AUDIO_EFFECTS)) {
    if (!raw || !raw.enabled || !Object.hasOwn(AUDIO_EFFECT_BOUNDS, raw.type)) continue;
    const effect = boundedAudioEffect(raw);
    const input = own(context.createGain()), output = own(context.createGain());
    previous.connect(input);
    switch (effect.type) {
      case 'echo': {
        const delay = own(context.createDelay(1.1)), feedback = own(context.createGain());
        delay.delayTime.value = effect.delay; feedback.gain.value = effect.feedback;
        input.connect(delay); delay.connect(feedback); feedback.connect(delay);
        wetDry(input, output, delay, effect.mix);
        const repeats = effect.feedback > 0 ? Math.ceil(Math.log(.025) / Math.log(effect.feedback)) : 1;
        tailSeconds = Math.min(MAX_EFFECT_TAIL, tailSeconds + effect.delay * Math.max(1, repeats));
        break;
      }
      case 'chorus': {
        const delay = own(context.createDelay(.05)), depth = own(context.createGain());
        const lfo = own(context.createOscillator()); oscillators.push(lfo);
        delay.delayTime.value = effect.delay; depth.gain.value = effect.depth;
        lfo.type = 'sine'; lfo.frequency.value = effect.rate;
        lfo.connect(depth); depth.connect(delay.delayTime);
        input.connect(delay); wetDry(input, output, delay, effect.mix);
        lfo.start();
        tailSeconds = Math.min(MAX_EFFECT_TAIL, tailSeconds + effect.delay + effect.depth);
        break;
      }
      case 'compressor': {
        const compressor = own(context.createDynamicsCompressor());
        compressor.threshold.value = effect.threshold; compressor.ratio.value = effect.ratio;
        compressor.knee.value = effect.knee; compressor.attack.value = effect.attack;
        compressor.release.value = effect.release;
        input.connect(compressor); compressor.connect(output);
        break;
      }
      case 'distortion': {
        const shaper = own(context.createWaveShaper());
        const curve = new Float32Array(2048), drive = 1 + effect.drive * 79;
        const normalizer = Math.tanh(drive);
        for (let i = 0; i < curve.length; i++) {
          const x = i * 2 / (curve.length - 1) - 1;
          curve[i] = Math.tanh(drive * x) / normalizer;
        }
        shaper.curve = curve; shaper.oversample = '2x';
        input.connect(shaper); wetDry(input, output, shaper, effect.mix);
        break;
      }
      case 'equalizer': {
        const low = own(context.createBiquadFilter()), mid = own(context.createBiquadFilter()), high = own(context.createBiquadFilter());
        low.type = 'lowshelf'; low.frequency.value = 180; low.gain.value = effect.low;
        mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = .7; mid.gain.value = effect.mid;
        high.type = 'highshelf'; high.frequency.value = 6000; high.gain.value = effect.high;
        input.connect(low); low.connect(mid); mid.connect(high); high.connect(output);
        break;
      }
      case 'reverb': {
        const convolver = own(context.createConvolver());
        const length = Math.min(480000, Math.max(1, Math.ceil(effect.seconds * context.sampleRate)));
        const impulse = context.createBuffer(2, length, context.sampleRate);
        let seed = 0x13579bdf;
        for (let channel = 0; channel < 2; channel++) {
          const data = impulse.getChannelData(channel);
          for (let i = 0; i < length; i++) {
            seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
            data[i] = (seed / 0x80000000) * (1 - i / length) ** effect.decay;
          }
        }
        convolver.normalize = true; convolver.buffer = impulse;
        input.connect(convolver); wetDry(input, output, convolver, effect.mix);
        tailSeconds = Math.min(MAX_EFFECT_TAIL, tailSeconds + length / context.sampleRate);
        break;
      }
    }
    previous = output;
  }
  previous.connect(destination);
  let disposed = false;
  return {
    tailSeconds,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const oscillator of oscillators) { try { oscillator.stop(); } catch { /* already stopped */ } }
      for (const node of nodes) node.disconnect();
    },
  };
}
