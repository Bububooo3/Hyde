import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectVideoCapabilities, VIDEO_PROBE_SETTINGS } from './capabilities';

afterEach(() => vi.unstubAllGlobals());

function install(video: (config: Record<string, unknown>) => Promise<{ supported?: boolean }>, audio: (config: Record<string, unknown>) => Promise<{ supported?: boolean }>) {
  const videoProbe = vi.fn(video), audioProbe = vi.fn(audio);
  vi.stubGlobal('VideoEncoder', { isConfigSupported: videoProbe });
  vi.stubGlobal('AudioEncoder', { isConfigSupported: audioProbe });
  return { videoProbe, audioProbe };
}

describe('capability-based video formats', () => {
  it('probes both real codec pairs and recommends MP4 when both pairs are supported', async () => {
    const { videoProbe, audioProbe } = install(async () => ({ supported: true }), async () => ({ supported: true }));
    const result = await detectVideoCapabilities();
    expect(result.map(format => [format.id, format.supported, format.recommended])).toEqual([
      ['mp4-h264-aac', true, true], ['webm-vp9-opus', true, false],
    ]);
    expect(videoProbe).toHaveBeenCalledTimes(2);
    expect(audioProbe).toHaveBeenCalledTimes(2);
    expect(videoProbe).toHaveBeenCalledWith(expect.objectContaining({ codec: 'avc1.420028', width: 1920, height: 1080, framerate: 30, avc: { format: 'avc' } }));
    expect(videoProbe).toHaveBeenCalledWith(expect.objectContaining({ codec: 'vp09.00.40.08', hardwareAcceleration: 'no-preference' }));
    expect(audioProbe).toHaveBeenCalledWith({ codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2, bitrate: 192_000 });
    expect(result[0].reason).toContain('requires a muxer');
    expect(VIDEO_PROBE_SETTINGS.videoBitrate).toBe(8_000_000);
  });
  it('recommends WebM when AAC is unsupported even though H.264 is supported', async () => {
    install(async () => ({ supported: true }), async config => ({ supported: config.codec === 'opus' }));
    const result = await detectVideoCapabilities();
    expect(result[0]).toMatchObject({ supported: false, recommended: false });
    expect(result[0].reason).toContain('AAC encoding is not supported');
    expect(result[1]).toMatchObject({ supported: true, recommended: true });
  });
  it('does not advertise an audio export when AudioEncoder is absent', async () => {
    vi.stubGlobal('VideoEncoder', { isConfigSupported: vi.fn(async () => ({ supported: true })) });
    vi.stubGlobal('AudioEncoder', undefined);
    const result = await detectVideoCapabilities();
    expect(result.every(format => !format.supported && !format.recommended)).toBe(true);
    expect(result[0].reason).toContain('AudioEncoder.isConfigSupported is unavailable');
  });
  it('returns unavailable results instead of throwing outside supporting browsers', async () => {
    vi.stubGlobal('VideoEncoder', undefined);
    vi.stubGlobal('AudioEncoder', {});
    const result = await detectVideoCapabilities();
    expect(result).toHaveLength(2);
    expect(result.every(format => !format.supported && !format.recommended)).toBe(true);
    expect(result[1].reason).toContain('VideoEncoder.isConfigSupported is unavailable');
    expect(result[1].reason).toContain('AudioEncoder.isConfigSupported is unavailable');
  });
  it('isolates thrown probe errors so the other format can still be recommended', async () => {
    install(async config => {
      if (String(config.codec).startsWith('avc')) throw new DOMException('Denied', 'NotSupportedError');
      return { supported: true };
    }, async () => ({ supported: true }));
    const result = await detectVideoCapabilities();
    expect(result[0]).toMatchObject({ supported: false, recommended: false });
    expect(result[0].reason).toContain('H.264 capability check failed');
    expect(result[1]).toMatchObject({ supported: true, recommended: true });
  });
  it('requires explicit supported=true and leaves no recommendation when both fail', async () => {
    install(async () => ({}), async () => ({ supported: false }));
    const result = await detectVideoCapabilities();
    expect(result.every(format => !format.supported && !format.recommended)).toBe(true);
  });
});
