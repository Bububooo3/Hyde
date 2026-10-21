import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import {
  AudioBufferSource, BufferTarget, CanvasSource, getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec, Mp4OutputFormat, Output, Quality, WebMOutputFormat,
} from 'mediabunny';
import type { AudioCodec, OutputFormat, VideoCodec } from 'mediabunny';
import type { Project } from './model';
import { evaluateProject } from './engine';
import { StageRenderer } from './render';
import { hasProjectAudio, projectAudioTail, renderExportAudio } from './mediaExportAudio';

export type MediaExportFormat = 'gif' | 'mp4' | 'webm';
export type MediaExportQuality = 'low' | 'medium' | 'high';

export interface MediaExportSettings {
  format: MediaExportFormat;
  start: number;
  end: number;
  width: number;
  height: number;
  fps: number;
  quality: MediaExportQuality;
  /** GIF repeat: true means forever, false means play once. */
  loop: boolean;
  /** GIFs are opaque and use this canvas background. */
  background: string;
  /** Video only. The default is true. */
  includeAudio?: boolean;
}

export interface ExportProgress {
  phase: 'audio' | 'rendering' | 'finalizing';
  completed: number;
  total: number;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  format: MediaExportFormat;
  includesAudio: boolean;
  frameCount: number;
  duration: number;
}

export interface VideoCapability {
  format: 'mp4' | 'webm';
  label: string;
  codec: VideoCodec | null;
  audioCodec: AudioCodec | null;
  supported: boolean;
  playable: boolean;
  recommended: boolean;
  reason?: string;
}

export interface FrameSample {
  index: number;
  projectTime: number;
  timestamp: number;
  duration: number;
}

export interface ExportOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
}

export class ExportCanceledError extends Error {
  constructor() { super('Export canceled.'); this.name = 'AbortError'; }
}

const throwIfCanceled = (signal?: AbortSignal) => { if (signal?.aborted) throw new ExportCanceledError(); };
const safeName = (name: string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'story';
const quality = (name: MediaExportQuality) => new Quality(name);

/** Project times are sampled independently of display refresh and encoder speed. */
export function frameSchedule(start: number, end: number, fps: number): FrameSample[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(fps) || end <= start || fps <= 0) throw new Error('Export range and frame rate must be positive.');
  const count = Math.max(1, Math.ceil((end - start) * fps - 1e-9));
  return Array.from({ length: count }, (_, index) => {
    const timestamp = index / fps;
    return { index, projectTime: start + timestamp, timestamp, duration: Math.min(1 / fps, end - start - timestamp) };
  });
}

export function validateMediaExport(project: Project, settings: MediaExportSettings): void {
  if (!['gif', 'mp4', 'webm'].includes(settings.format)) throw new Error('Choose GIF, MP4, or WebM.');
  if (![settings.start, settings.end, settings.width, settings.height, settings.fps].every(Number.isFinite)) throw new Error('Export settings must be finite numbers.');
  if (settings.start < 0 || settings.end > project.duration + 1e-6 || settings.end <= settings.start) throw new Error('Choose a time range within the project.');
  if (!Number.isInteger(settings.width) || !Number.isInteger(settings.height) || settings.width < 16 || settings.height < 16 || settings.width > 4096 || settings.height > 4096) throw new Error('Export dimensions must be whole numbers between 16 and 4096 pixels.');
  if (settings.width * settings.height > 8_294_400) throw new Error('Export dimensions exceed the current 8.3-megapixel limit.');
  if (!Number.isInteger(settings.fps) || settings.fps < 1 || settings.fps > (settings.format === 'gif' ? 50 : 60)) throw new Error(settings.format === 'gif' ? 'GIF frame rate must be 1–50 fps.' : 'Video frame rate must be 1–60 fps.');
  const frames = Math.ceil((settings.end - settings.start) * settings.fps - 1e-9);
  if (frames > (settings.format === 'gif' ? 3_000 : 18_000)) throw new Error('The selected range is too long for an in-browser export. Choose a shorter range or lower frame rate.');
  if (settings.format === 'gif' && settings.width * settings.height * frames > 350_000_000) throw new Error('This GIF would use too much browser memory. Choose a shorter range or smaller dimensions.');
  if (!['low', 'medium', 'high'].includes(settings.quality)) throw new Error('Choose a video quality.');
  if (!/^#[0-9a-f]{6}$/i.test(settings.background)) throw new Error('Choose a six-digit background color.');
}

function formatObject(format: 'mp4' | 'webm'): OutputFormat {
  return format === 'mp4' ? new Mp4OutputFormat() : new WebMOutputFormat();
}

function candidateVideoCodecs(format: 'mp4' | 'webm'): VideoCodec[] {
  return format === 'mp4' ? ['avc'] : ['vp9', 'vp8'];
}

function candidateAudioCodecs(format: 'mp4' | 'webm'): AudioCodec[] {
  return format === 'mp4' ? ['aac'] : ['opus'];
}

function playbackMime(format: 'mp4' | 'webm', codec: VideoCodec): string {
  return format === 'mp4' ? 'video/mp4; codecs="avc1.42E01E"' : `video/webm; codecs="${codec === 'vp8' ? 'vp8' : 'vp9'}"`;
}

/** Probe the requested dimensions and rate, rather than advertising a generic browser list. */
export async function getVideoCapabilities(width: number, height: number, fps: number, needAudio = false, signal?: AbortSignal): Promise<VideoCapability[]> {
  const capabilities: VideoCapability[] = [];
  for (const format of ['mp4', 'webm'] as const) {
    throwIfCanceled(signal);
    const container = formatObject(format);
    const candidates = candidateVideoCodecs(format).filter(codec => container.getSupportedVideoCodecs().includes(codec));
    const codec = candidates.length ? await getFirstEncodableVideoCodec(candidates, { width, height, frameRate: fps, quality: quality('medium') }) : null;
    const audioCandidates = candidateAudioCodecs(format).filter(audio => container.getSupportedAudioCodecs().includes(audio));
    const audioCodec = needAudio && audioCandidates.length ? await getFirstEncodableAudioCodec(audioCandidates) : null;
    const supported = codec !== null && (!needAudio || audioCodec !== null);
    const video = typeof document !== 'undefined' ? document.createElement('video') : null;
    const playable = !!codec && !!video?.canPlayType(playbackMime(format, codec));
    const reason = !codec ? 'This browser cannot encode this video format at the chosen size and frame rate.'
      : needAudio && !audioCodec ? 'This browser cannot encode the project audio in this format.' : undefined;
    capabilities.push({ format, label: format === 'mp4' ? 'MP4 · H.264' : `WebM · ${codec?.toUpperCase() ?? 'VP9/VP8'}`, codec, audioCodec, supported, playable, recommended: false, reason });
  }
  const recommended = capabilities.find(entry => entry.supported && entry.playable) ?? capabilities.find(entry => entry.supported);
  if (recommended) recommended.recommended = true;
  return capabilities;
}

function createRaster(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser cannot create a 2D export canvas.');
  return { canvas, context };
}

async function makeFrameRenderer(project: Project, settings: MediaExportSettings) {
  await document.fonts.ready;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;';
  document.body.append(host);
  let renderer: StageRenderer;
  try { renderer = await StageRenderer.create(host); }
  catch (error) { host.remove(); throw error; }
  let raster:ReturnType<typeof createRaster>;
  try { raster = createRaster(settings.width, settings.height); }
  catch (error) { renderer.destroy(); host.remove(); throw error; }
  const renderProject = settings.format === 'gif' ? { ...project, background: settings.background } : project;
  return {
    canvas: raster.canvas,
    context: raster.context,
    async sample(time: number) {
      await renderer.render(renderProject, evaluateProject(renderProject, Math.min(time, project.duration)), Math.min(time, project.duration));
      const ctx = raster.context;
      ctx.fillStyle = settings.format === 'gif' ? settings.background : project.background;
      ctx.fillRect(0, 0, settings.width, settings.height);
      // Preserve authored aspect ratio even when an output dimension differs.
      const scale = Math.min(settings.width / project.width, settings.height / project.height);
      const width = project.width * scale, height = project.height * scale;
      ctx.drawImage(renderer.canvas, (settings.width - width) / 2, (settings.height - height) / 2, width, height);
    },
    destroy() { renderer.destroy(); host.remove(); },
  };
}

const yieldToUI = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function encodeGif(project: Project, settings: MediaExportSettings, samples: FrameSample[], options: ExportOptions): Promise<ExportResult> {
  const source = await makeFrameRenderer(project, settings);
  try {
    const gif = GIFEncoder();
    for (const frame of samples) {
      throwIfCanceled(options.signal);
      await source.sample(frame.projectTime);
      throwIfCanceled(options.signal);
      const pixels = source.context.getImageData(0, 0, settings.width, settings.height).data;
      const palette = quantize(pixels, 256, { format: 'rgb565' });
      const indices = applyPalette(pixels, palette, 'rgb565');
      gif.writeFrame(indices, settings.width, settings.height, { palette, delay: Math.max(20, Math.round(frame.duration * 1000 / 10) * 10), repeat: settings.loop ? 0 : -1, dispose: 2 });
      options.onProgress?.({ phase: 'rendering', completed: frame.index + 1, total: samples.length });
      if (frame.index % 2 === 0) await yieldToUI();
    }
    throwIfCanceled(options.signal);
    options.onProgress?.({ phase: 'finalizing', completed: samples.length, total: samples.length });
    gif.finish();
    const blob = new Blob([gif.bytesView() as Uint8Array<ArrayBuffer>], { type: 'image/gif' });
    return { blob, fileName: `${safeName(project.name)}.gif`, format: 'gif', includesAudio: false, frameCount: samples.length, duration: samples.reduce((sum, sample) => sum + sample.duration, 0) };
  } finally { source.destroy(); }
}

async function encodeVideo(project: Project, settings: MediaExportSettings, options: ExportOptions): Promise<ExportResult> {
  const includeAudio = settings.includeAudio !== false && hasProjectAudio(project, settings.start, settings.end);
  const capabilities = await getVideoCapabilities(settings.width, settings.height, settings.fps, includeAudio, options.signal);
  const capability = capabilities.find(entry => entry.format === settings.format);
  if (!capability?.supported || !capability.codec) throw new Error(capability?.reason ?? 'This browser cannot encode the selected video format.');
  const tail = includeAudio ? projectAudioTail(project, settings.end) : 0;
  const samples = frameSchedule(settings.start, settings.end + tail, settings.fps).map(frame => ({ ...frame, projectTime: Math.min(frame.projectTime, settings.end) }));
  let audioBuffer: AudioBuffer | null = null;
  if (includeAudio) {
    options.onProgress?.({ phase: 'audio', completed: 0, total: 1 });
    audioBuffer = await renderExportAudio(project, settings.start, settings.end, tail, options.signal);
    throwIfCanceled(options.signal);
    options.onProgress?.({ phase: 'audio', completed: 1, total: 1 });
  }
  const source = await makeFrameRenderer(project, settings);
  try {
    const target = new BufferTarget();
    const output = new Output({ format: formatObject(settings.format as 'mp4' | 'webm'), target });
    try {
      const videoSource = new CanvasSource(source.canvas, { codec: capability.codec, quality: quality(settings.quality), keyFrameInterval: 2 });
      output.addVideoTrack(videoSource);
      const audioSource = audioBuffer && capability.audioCodec ? new AudioBufferSource({ codec: capability.audioCodec, quality: quality(settings.quality) }) : null;
      if (audioSource) output.addAudioTrack(audioSource);
      throwIfCanceled(options.signal);
      await output.start();
      if (audioSource && audioBuffer) await audioSource.add(audioBuffer);
      for (const frame of samples) {
        throwIfCanceled(options.signal);
        await source.sample(frame.projectTime);
        throwIfCanceled(options.signal);
        await videoSource.add(frame.timestamp, frame.duration);
        options.onProgress?.({ phase: 'rendering', completed: frame.index + 1, total: samples.length });
        if (frame.index % 2 === 0) await yieldToUI();
      }
      throwIfCanceled(options.signal);
      options.onProgress?.({ phase: 'finalizing', completed: samples.length, total: samples.length });
      await output.finalize();
      if (!target.buffer) throw new Error('The video encoder did not produce a file.');
      return { blob: new Blob([target.buffer], { type: output.format.mimeType }), fileName: `${safeName(project.name)}.${settings.format}`, format: settings.format, includesAudio: !!audioSource, frameCount: samples.length, duration: samples.reduce((sum, sample) => sum + sample.duration, 0) };
    } finally {
      if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    }
  } finally { source.destroy(); }
}

/** Render to a downloadable Blob. It never mutates the editable project. */
export async function exportMedia(project: Project, settings: MediaExportSettings, options: ExportOptions = {}): Promise<ExportResult> {
  validateMediaExport(project, settings);
  throwIfCanceled(options.signal);
  if (settings.format === 'gif') return encodeGif(project, settings, frameSchedule(settings.start, settings.end, settings.fps), options);
  return encodeVideo(project, settings, options);
}
