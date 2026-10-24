import { evaluateProject } from './engine';
import { StageRenderer } from './render';
import { exportMedia, getVideoCapabilities } from './mediaExport';
import type { ExportOptions, ExportResult, MediaExportSettings } from './mediaExport';
import type { Project } from './model';
import type { HydeAuthoringSession, HydeDiagnostic } from './authoring';
import type { WebPackageResources } from './export';

export interface RenderFrameOptions {
  timeSeconds: number;
  width?: number;
  height?: number;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  signal?: AbortSignal;
}
export interface RenderedFrame {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  warnings: HydeDiagnostic[];
}

function capabilityError(message: string): Error {
  return Object.assign(new Error(message), { code: 'CAPABILITY_UNAVAILABLE' });
}
function canvasBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The Hyde canvas could not produce an image.')), mime, quality));
}

/** Browser-only host for the same Pixi renderer and media exporter used by Hyde. */
export class HydeRenderHost {
  private readonly host: HTMLDivElement;
  private readonly renderer: StageRenderer;
  private closed = false;
  private constructor(private readonly source: () => Project, host: HTMLDivElement, renderer: StageRenderer) {
    this.host = host;
    this.renderer = renderer;
  }
  static async connect(source: HydeAuthoringSession | (() => Project)): Promise<HydeRenderHost> {
    if (typeof document === 'undefined' || !document.body) throw capabilityError('A browser document with WebGL is required for Hyde frame rendering.');
    const host = document.createElement('div');
    host.hidden = true;
    host.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none';
    document.body.append(host);
    try {
      const renderer = await StageRenderer.create(host);
      const read = typeof source === 'function' ? source : () => source.snapshot();
      return new HydeRenderHost(read, host, renderer);
    } catch (error) {
      host.remove();
      throw capabilityError(`Hyde's browser renderer could not start: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  async capabilities() {
    const project = this.source();
    const video = await getVideoCapabilities(project.width, project.height, project.fps, false);
    return {
      preview: { frames: true, audio: false, video: true },
      exports: ['hyde', 'hy', 'hyproj', 'web', 'gif', ...video.filter(item => item.supported).map(item => item.format)],
      video,
      resourceLimits: { maxRenderPixels: 8_294_400, maxConcurrentJobs: 1 },
    };
  }
  async renderFrame(options: RenderFrameOptions): Promise<RenderedFrame> {
    if (this.closed) throw capabilityError('The render host has been closed.');
    if (options.signal?.aborted) throw Object.assign(new Error('Render canceled.'), { code: 'CANCELED' });
    const project = this.source();
    const width = options.width ?? project.width, height = options.height ?? project.height;
    if (![width, height, options.timeSeconds].every(Number.isFinite) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 8_294_400 || options.timeSeconds < 0 || options.timeSeconds > project.duration) throw new Error('Frame time or dimensions are outside Hyde limits.');
    await document.fonts.ready;
    await this.renderer.render(project, evaluateProject(project, options.timeSeconds), options.timeSeconds);
    if (options.signal?.aborted) throw Object.assign(new Error('Render canceled.'), { code: 'CANCELED' });
    const warnings = this.renderer.warnings.map(message => ({ code: /could not be loaded|missing/i.test(message) ? 'MEDIA_NOT_READY' : 'RENDER_WARNING', severity: 'warning' as const, message }));
    if (warnings.some(item => item.code === 'MEDIA_NOT_READY')) throw Object.assign(new Error(warnings.map(item => item.message).join(' ')), { code: 'MEDIA_NOT_READY', diagnostics: warnings });
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw capabilityError('A 2D canvas is required to extract a rendered Hyde frame.');
    context.fillStyle = project.background;
    context.fillRect(0, 0, width, height);
    const scale = Math.min(width / project.width, height / project.height);
    const drawWidth = project.width * scale, drawHeight = project.height * scale;
    context.drawImage(this.renderer.canvas, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    const mime = `image/${options.format ?? 'png'}`;
    const blob = await canvasBlob(canvas, mime, options.quality);
    if (blob.type !== mime) throw capabilityError(`This browser cannot encode ${mime}; it returned ${blob.type || 'an unknown type'}.`);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, width, height, warnings };
  }
  async exportMedia(settings: MediaExportSettings, options?: ExportOptions): Promise<ExportResult> {
    if (this.closed) throw capabilityError('The render host has been closed.');
    return exportMedia(this.source(), settings, options);
  }
  /** Produce a standalone ZIP from Hyde's built portable player and native archive codec. */
  async exportWeb(resources: WebPackageResources, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.closed) throw capabilityError('The render host has been closed.');
    const { buildWebPackageBytes } = await import('./export');
    return buildWebPackageBytes(this.source(), resources, signal);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.renderer.destroy();
    this.host.remove();
  }
}
