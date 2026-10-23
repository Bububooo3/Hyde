import { decodeAssemblyBytes, encodeAssemblyBytes, validateDocument } from './archive';
import { HydeAuthoringSession } from './authoring';
import type { ExecuteRequest, ExecuteResult, HydeDiagnostic } from './authoring';
import { evaluateCamera } from './engine';
import { createProject } from './model';
import type { Assembly, Asset, Project } from './model';
import type { HydeRenderHost } from './browserHost';

export type { HydeCommand, ExecuteRequest, ExecuteResult, HydeDiagnostic } from './authoring';
export type { RenderFrameOptions, RenderedFrame } from './browserHost';

export interface NewProjectOptions {
  name?: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  background?: string;
}

/** A versioned, portable entry point around Hyde's native authoring model. */
export class HydeSession {
  private closed = false;
  constructor(private readonly authoring: HydeAuthoringSession) {}
  private ready(): HydeAuthoringSession {
    if (this.closed) throw Object.assign(new Error('The Hyde session is closed.'), { code: 'CAPABILITY_UNAVAILABLE' });
    return this.authoring;
  }
  get revision(): number { return this.ready().revision; }
  capabilities(): ReturnType<HydeAuthoringSession['capabilities']> { return this.ready().capabilities(); }
  execute(request: ExecuteRequest): Promise<ExecuteResult> { return this.ready().execute(request); }
  inspect(request: Parameters<HydeAuthoringSession['inspect']>[0]): Promise<ReturnType<HydeAuthoringSession['inspect']>> {
    return Promise.resolve(this.ready().inspect(request));
  }
  diagnostics(): Promise<HydeDiagnostic[]> {
    try { validateDocument(this.ready().snapshot(), false); return Promise.resolve([]); }
    catch (cause) { return Promise.resolve([{ code: 'INVALID_REFERENCE', severity: 'error', message: cause instanceof Error ? cause.message : 'Invalid project.' }]); }
  }
  evaluate(timeSeconds: number): Promise<{ timeSeconds: number; camera: ReturnType<typeof evaluateCamera>; elements: ReturnType<HydeAuthoringSession['evaluate']> }> {
    const session = this.ready();
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds > session.snapshot().duration) throw new Error('Evaluation time is outside project duration.');
    return Promise.resolve({ timeSeconds, camera: evaluateCamera(session.snapshot(), timeSeconds), elements: session.evaluate(timeSeconds) });
  }
  stageAsset(bytes: Uint8Array, mime: string, kind: Asset['kind'], licenseNotice?: string): string { return this.ready().stageAsset(bytes, mime, kind, licenseNotice); }
  discardAsset(handle: string): void { this.ready().discardAsset(handle); }
  stageAssembly(bytes: Uint8Array): string { return this.ready().stageAssembly(bytes); }
  discardAssembly(handle: string): void { this.ready().discardAssembly(handle); }
  exportProject(): Promise<Uint8Array> { return Promise.resolve(this.ready().exportProject()); }
  exportAssembly(rootId: string, timeSeconds?: number): Promise<Uint8Array> { return Promise.resolve(this.ready().exportAssembly(rootId, timeSeconds)); }
  snapshot(): Project { return this.ready().snapshot(); }
  undo(expectedRevision: number): boolean { return this.ready().undo(expectedRevision); }
  redo(expectedRevision: number): boolean { return this.ready().redo(expectedRevision); }
  async close(): Promise<void> { this.closed = true; }
}

export class HydeAssemblyHandle {
  private closed = false;
  constructor(private readonly assembly: Assembly) {}
  inspect(): Omit<Assembly, 'assets'> & { assets: Array<Omit<Asset, 'dataUrl'>> } {
    if (this.closed) throw new Error('The assembly handle is closed.');
    return { ...structuredClone(this.assembly), assets: this.assembly.assets.map(({ dataUrl: _data, ...asset }) => structuredClone(asset)) };
  }
  exportBytes(): Uint8Array {
    if (this.closed) throw new Error('The assembly handle is closed.');
    return encodeAssemblyBytes(this.assembly);
  }
  close(): void { this.closed = true; }
}

export class HydeSDK {
  static readonly version = '0.1.0';
  async createProject(options: NewProjectOptions = {}): Promise<HydeSession> {
    const project = createProject(options.name);
    for (const field of ['width', 'height', 'fps', 'duration', 'background'] as const) {
      if (options[field] !== undefined) Object.assign(project, { [field]: options[field] });
    }
    if (options.duration !== undefined) project.sequences[0].duration = options.duration;
    validateDocument(project, false);
    return new HydeSession(new HydeAuthoringSession(project));
  }
  async openProject(bytes: Uint8Array): Promise<HydeSession> { return new HydeSession(HydeAuthoringSession.open(bytes)); }
  async openAssembly(bytes: Uint8Array): Promise<HydeAssemblyHandle> { return new HydeAssemblyHandle(decodeAssemblyBytes(bytes)); }
  async connectBrowser(source: HydeSession | (() => Project)): Promise<HydeRenderHost> {
    const { HydeRenderHost } = await import('./browserHost');
    return HydeRenderHost.connect(typeof source === 'function' ? source : () => source.snapshot());
  }
}

export const hyde = new HydeSDK();
