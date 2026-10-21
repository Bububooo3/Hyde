/** Decoded, deinterleaved PCM. Every channel has the same number of frames. */
export interface PcmAudio {
  sampleRate: number;
  channels: readonly Float32Array[];
}

export interface PitchTimeOptions {
  /** Source seconds consumed per output second, from 0.25 to 4. */
  speed: number;
  /** Independent pitch shift, from -24 to +24 semitones. */
  pitchSemitones: number;
  signal?: AbortSignal;
  /** Prevent an unexpectedly long offline render from exhausting browser memory. */
  maxOutputFrames?: number;
}

/** About four minutes at 48 kHz. Callers can process a source in pieces when longer. */
export const DEFAULT_MAX_OUTPUT_FRAMES = 12_000_000;

type StretchNode = AudioWorkletNode & {
  addBuffers(channels: Float32Array[], transfer?: Transferable[]): Promise<number>;
  schedule(change: { active: boolean; input: number; output: number; rate: number; semitones: number }): Promise<unknown>;
  dropBuffers(): Promise<unknown>;
};

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Audio processing canceled.', 'AbortError');
}

function validate(input: PcmAudio, options: PitchTimeOptions): number {
  const { speed, pitchSemitones } = options;
  if (!Number.isFinite(speed) || speed < .25 || speed > 4) throw new RangeError('Speed must be between 0.25 and 4.');
  if (!Number.isFinite(pitchSemitones) || pitchSemitones < -24 || pitchSemitones > 24) throw new RangeError('Pitch must be between -24 and 24 semitones.');
  if (!Number.isInteger(input.sampleRate) || input.sampleRate < 8_000 || input.sampleRate > 192_000) throw new RangeError('PCM sample rate must be between 8,000 and 192,000 Hz.');
  if (!input.channels.length || input.channels.length > 8) throw new RangeError('PCM must have between one and eight channels.');
  const frames = input.channels[0].length;
  if (!input.channels.every(channel => channel.length === frames)) throw new RangeError('PCM channels must have equal length.');
  const outputFrames = Math.max(1, Math.round(frames / speed));
  const limit = options.maxOutputFrames ?? DEFAULT_MAX_OUTPUT_FRAMES;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('maxOutputFrames must be a positive integer.');
  if (outputFrames > limit) throw new RangeError(`Processed audio exceeds the ${limit}-frame limit; process a shorter segment.`);
  return outputFrames;
}

/** Copy an AudioBuffer into stable PCM suitable for processing or caching. */
export function pcmFromAudioBuffer(buffer: AudioBuffer): PcmAudio {
  return {
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel).slice()),
  };
}

/** Materialize processed PCM in the context used by playback or export. */
export function audioBufferFromPcm(context: BaseAudioContext, pcm: PcmAudio): AudioBuffer {
  const frames = pcm.channels[0]?.length ?? 0;
  if (!pcm.channels.length || !pcm.channels.every(channel => channel.length === frames) || frames < 1) {
    throw new RangeError('PCM channels must be nonempty and have equal length.');
  }
  const buffer = context.createBuffer(pcm.channels.length, frames, pcm.sampleRate);
  pcm.channels.forEach((channel, index) => buffer.copyToChannel(new Float32Array(channel), index));
  return buffer;
}

/**
 * Process decoded PCM with the official Signalsmith Stretch WASM AudioWorklet.
 * Pitch is independent of speed: output duration is always input duration/speed.
 * This is intended for prepared playback/export segments, not a synchronous UI path.
 */
export async function processPitchTime(input: PcmAudio, options: PitchTimeOptions): Promise<PcmAudio> {
  const frames = validate(input, options);
  abortIfNeeded(options.signal);
  if (!input.channels[0].length || (options.speed === 1 && options.pitchSemitones === 0)) {
    return { sampleRate: input.sampleRate, channels: input.channels.map(channel => {
      const copy = new Float32Array(frames);
      copy.set(channel.subarray(0, frames));
      return copy;
    }) };
  }
  if (typeof OfflineAudioContext === 'undefined') throw new Error('Offline audio processing is unavailable in this browser.');

  const context = new OfflineAudioContext(input.channels.length, frames, input.sampleRate);
  if (!context.audioWorklet) throw new Error('AudioWorklet is unavailable for offline audio processing in this browser.');
  abortIfNeeded(options.signal);

  // Signalsmith Stretch is bundled with Hyde, so standalone web exports do not
  // depend on a remote script or a server-side processing service.
  // @ts-expect-error The official package does not publish TypeScript declarations.
  const { default: createStretch } = await import('signalsmith-stretch') as { default: (context: BaseAudioContext, options: AudioWorkletNodeOptions) => Promise<StretchNode> };
  abortIfNeeded(options.signal);
  const stretch = await createStretch(context, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [input.channels.length],
  });
  let aborted = false;
  let rejectCancellation: (error: DOMException) => void = () => undefined;
  const canceled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  // The signal can fire while the worklet is loading, before a race is attached.
  void canceled.catch(() => undefined);
  const onAbort = () => {
    aborted = true;
    stretch.disconnect();
    rejectCancellation(new DOMException('Audio processing canceled.', 'AbortError'));
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    abortIfNeeded(options.signal);
    // Transfer copies because the worklet owns its input after postMessage.
    const copies = input.channels.map(channel => channel.slice());
    await Promise.race([stretch.addBuffers(copies, copies.map(channel => channel.buffer)), canceled]);
    abortIfNeeded(options.signal);
    await Promise.race([stretch.schedule({ active: true, input: 0, output: 0, rate: options.speed, semitones: options.pitchSemitones }), canceled]);
    abortIfNeeded(options.signal);
    stretch.connect(context.destination);
    const rendered = await Promise.race([context.startRendering(), canceled]);
    abortIfNeeded(options.signal);
    return pcmFromAudioBuffer(rendered);
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    stretch.disconnect();
    // Release the worklet's transferred source buffers promptly.
    if (!aborted) {
      try { await stretch.dropBuffers(); } catch { /* context may have closed */ }
    }
    stretch.port.close();
  }
}
