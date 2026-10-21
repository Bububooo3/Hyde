export interface VideoCapability {
  id: 'mp4-h264-aac' | 'webm-vp9-opus';
  container: 'mp4' | 'webm';
  videoCodec: string;
  audioCodec: string;
  recommended: boolean;
  supported: boolean;
  reason: string;
}

/** A probe confirms these settings, not every possible export size/rate. */
export const VIDEO_PROBE_SETTINGS = {
  width: 1920,
  height: 1080,
  framerate: 30,
  videoBitrate: 8_000_000,
  sampleRate: 48_000,
  numberOfChannels: 2,
  audioBitrate: 192_000,
} as const;

interface EncoderProbe {
  isConfigSupported(config: Record<string, unknown>): Promise<{ supported?: boolean }>;
}
interface ProbeResult { supported: boolean; reason?: string }
type EncoderGlobal = 'VideoEncoder' | 'AudioEncoder';

function encoder(name: EncoderGlobal): EncoderProbe | undefined {
  // AudioEncoder is not declared in all TypeScript DOM versions. Runtime feature
  // detection also handles unsupported browsers and non-browser environments.
  const candidate = (globalThis as unknown as Record<string, EncoderProbe | undefined>)[name];
  return candidate && typeof candidate.isConfigSupported === 'function' ? candidate : undefined;
}

async function probe(name: EncoderGlobal, codecName: string, config: Record<string, unknown>): Promise<ProbeResult> {
  const api = encoder(name);
  if (!api) return { supported: false, reason: `${name}.isConfigSupported is unavailable in this browser context.` };
  try {
    const result = await api.isConfigSupported(config);
    return result.supported === true
      ? { supported: true }
      : { supported: false, reason: `${codecName} encoding is not supported at the tested settings.` };
  } catch {
    return { supported: false, reason: `${codecName} capability check failed; support could not be confirmed.` };
  }
}

/** Probe the actual platform encoders, without user-agent assumptions. An audio
 * export format is available only when both codec configurations are supported.
 * This does not test a muxer, render quality, or guarantee an encoder can start
 * later under memory/resource pressure. Recheck the final settings at export. */
export async function detectVideoCapabilities(): Promise<VideoCapability[]> {
  const settings = VIDEO_PROBE_SETTINGS;
  const candidates = [
    { id: 'mp4-h264-aac', container: 'mp4', videoCodec: 'avc1.420028', audioCodec: 'mp4a.40.2', videoName: 'H.264', audioName: 'AAC' },
    { id: 'webm-vp9-opus', container: 'webm', videoCodec: 'vp09.00.40.08', audioCodec: 'opus', videoName: 'VP9', audioName: 'Opus' },
  ] as const;

  const results = await Promise.all(candidates.map(async candidate => {
    const videoConfig: Record<string, unknown> = {
      codec: candidate.videoCodec, width: settings.width, height: settings.height,
      framerate: settings.framerate, bitrate: settings.videoBitrate,
      latencyMode: 'quality', hardwareAcceleration: 'no-preference',
      ...(candidate.container === 'mp4' ? { avc: { format: 'avc' } } : {}),
    };
    const audioConfig = {
      codec: candidate.audioCodec, sampleRate: settings.sampleRate,
      numberOfChannels: settings.numberOfChannels, bitrate: settings.audioBitrate,
    };
    const [video, audio] = await Promise.all([
      probe('VideoEncoder', candidate.videoName, videoConfig),
      probe('AudioEncoder', candidate.audioName, audioConfig),
    ]);
    const supported = video.supported && audio.supported;
    return {
      id: candidate.id, container: candidate.container,
      videoCodec: candidate.videoCodec, audioCodec: candidate.audioCodec,
      supported, recommended: false,
      reason: supported
        ? `${candidate.videoName} video and ${candidate.audioName} audio encoding confirmed at 1920×1080, 30 fps, stereo 48 kHz. Container export still requires a muxer.`
        : [video.reason, audio.reason].filter(Boolean).join(' '),
    } satisfies VideoCapability;
  }));
  // Prefer the broadly playable MP4 combination when available; otherwise the
  // first fully supported combination wins. Unsupported entries are never recommended.
  const recommended = results.findIndex(result => result.supported);
  return results.map((result, index) => ({ ...result, recommended: index === recommended }));
}
