import { HydeRenderHost } from './browserHost';
import type { RenderFrameOptions } from './browserHost';
import type { MediaExportSettings, ExportProgress } from './mediaExport';
import type { Project } from './model';

type BrowserTask =
  | { kind: 'preview'; options: Omit<RenderFrameOptions, 'signal'> }
  | { kind: 'render'; settings: MediaExportSettings };

interface BrowserResult {
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  frameCount?: number;
  duration?: number;
  includesAudio?: boolean;
  warnings?: { code: string; severity: string; message: string }[];
}

declare global {
  interface Window {
    __hydeCliProgress?: (progress: ExportProgress) => Promise<void>;
    __hydeCliRuntime: {
      run: (project: Project, task: BrowserTask) => Promise<BrowserResult>;
      cancel: () => void;
      cleanup: () => void;
      chunk: (offset: number, length: number) => Promise<number[]>;
      doctor: (project: Project) => Promise<unknown>;
    };
  }
}

let controller: AbortController | undefined;
let artifact: Blob | undefined;

window.__hydeCliRuntime = {
  async run(project, task) {
    if (controller) throw Object.assign(new Error('A render job is already active.'), { code: 'RESOURCE_LIMIT' });
    controller = new AbortController();
    let host: HydeRenderHost | undefined;
    try {
      host = await HydeRenderHost.connect(() => project);
      if (task.kind === 'preview') {
        const frame = await host.renderFrame({ ...task.options, signal: controller.signal });
        artifact = new Blob([frame.bytes as Uint8Array<ArrayBuffer>], { type: frame.mime });
        return { mime: frame.mime, bytes: frame.bytes.byteLength, width: frame.width, height: frame.height, warnings: frame.warnings };
      }
      const result = await host.exportMedia(task.settings, {
        signal: controller.signal,
        onProgress: progress => { void window.__hydeCliProgress?.(progress); },
      });
      artifact = result.blob;
      return { mime: result.blob.type, bytes: result.blob.size, frameCount: result.frameCount, duration: result.duration, includesAudio: result.includesAudio };
    } finally {
      host?.close();
      controller = undefined;
    }
  },
  cancel() { controller?.abort(); },
  cleanup() { artifact = undefined; },
  async chunk(offset, length) {
    if (!artifact || !Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 1 || length > 1_048_576 || offset + length > artifact.size) throw new Error('Invalid artifact chunk.');
    return Array.from(new Uint8Array(await artifact.slice(offset, offset + length).arrayBuffer()));
  },
  async doctor(project) {
    const host = await HydeRenderHost.connect(() => project);
    try { return await host.capabilities(); }
    finally { host.close(); }
  },
};
