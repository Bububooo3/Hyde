import { HydeAuthoringSession } from './authoring';
import { enrichAssetInspection } from './assetInspection';
import type { ExecuteRequest, HydeCommand, HydeDiagnostic } from './authoring';
import { HydeRenderHost } from './browserHost';
import { exportMedia } from './mediaExport';
import type { MediaExportSettings } from './mediaExport';
import type { Project } from './model';

export type BridgeScope = 'read' | 'write' | 'assets' | 'preview' | 'export' | 'editorNavigation';
export type BridgeOperation = 'capabilities' | 'inspect' | 'execute' | 'evaluate' | 'stageAsset' | 'stageAssembly' | 'renderFrame' | 'startExport' | 'jobStatus' | 'jobArtifact' | 'cancelJob' | 'select' | 'setPlayhead' | 'diagnostics' | 'revoke';
export interface BridgeRequest {
  protocolVersion: 1;
  sessionId: string;
  requestId: string;
  operation: BridgeOperation;
  payload?: unknown;
}
export type BridgeResponse = { requestId: string; ok: true; revision: number; result: unknown } | { requestId: string; ok: false; revision: number; errors: HydeDiagnostic[] };
export interface EditorBridgeCallbacks {
  project(): Project;
  revision(): number;
  commit(project: Project): void;
  select(ids: string[]): void;
  setPlayhead(timeSeconds: number): void;
}
interface ExportJob {
  id: string;
  state: 'queued' | 'preparing' | 'running' | 'completed' | 'failed' | 'canceled';
  progress: number;
  message?: string;
  controller: AbortController;
  artifact?: Uint8Array;
  mime?: string;
  timedOut?: boolean;
}

const EXPORT_TIMEOUT_MS = 5 * 60_000;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

function error(code: string, message: string): HydeDiagnostic { return { code, severity: 'error', message }; }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request payload must be an object.');
  return value as Record<string, unknown>;
}

/** Explicit same-page adapter. It is not a sandbox for scripts already in Hyde's origin. */
export class EditorBridge {
  readonly sessionId = crypto.randomUUID();
  private active = true;
  private readonly staged = new Map<string, { bytes: Uint8Array; mime: string; kind: 'image' | 'video' | 'audio' | 'font'; licenseNotice?: string }>();
  private readonly stagedAssemblies = new Map<string, Uint8Array>();
  private readonly jobs = new Map<string, ExportJob>();
  private renderHost?: HydeRenderHost;
  private hostOpening?: Promise<HydeRenderHost>;
  private mutating = false;
  private rendering = false;
  constructor(readonly scopes: ReadonlySet<BridgeScope>, private readonly editor: EditorBridgeCallbacks) {}

  private success(requestId: string, result: unknown, allowRevoked = false): BridgeResponse {
    if (!this.active && !allowRevoked) return this.failure(requestId, 'PERMISSION_DENIED', 'Automation was revoked before the request completed.');
    return { requestId, ok: true, revision: this.editor.revision(), result };
  }
  private failure(requestId: string, code: string, message: string): BridgeResponse { return { requestId, ok: false, revision: this.editor.revision(), errors: [error(code, message)] }; }
  private require(scope: BridgeScope): void { if (!this.scopes.has(scope)) throw Object.assign(new Error(`${scope} permission is required.`), { code: 'PERMISSION_DENIED' }); }
  private async host(): Promise<HydeRenderHost> {
    if (!this.active) throw Object.assign(new Error('Automation was revoked.'), { code: 'PERMISSION_DENIED' });
    if (this.renderHost) return this.renderHost;
    this.hostOpening ??= HydeRenderHost.connect(() => this.editor.project()).then(host => {
      if (!this.active) { host.close(); throw Object.assign(new Error('Automation was revoked while preparing the renderer.'), { code: 'PERMISSION_DENIED' }); }
      this.renderHost = host;
      return host;
    }).finally(() => { this.hostOpening = undefined; });
    return this.hostOpening;
  }
  revoke(): void {
    if (!this.active) return;
    this.active = false;
    for (const job of this.jobs.values()) if (job.state !== 'completed' && job.state !== 'failed') { job.controller.abort(); job.state = 'canceled'; }
    this.staged.clear();
    this.stagedAssemblies.clear();
    this.jobs.clear();
    this.renderHost?.close();
    this.renderHost = undefined;
  }
  async request(request: BridgeRequest): Promise<BridgeResponse> {
    const requestId = typeof request?.requestId === 'string' ? request.requestId.slice(0, 128) : '';
    if (!this.active) return this.failure(requestId, 'PERMISSION_DENIED', 'Automation is disabled for this editor session.');
    if (request?.protocolVersion !== 1 || request.sessionId !== this.sessionId || !requestId || request.requestId.length > 128) return this.failure(requestId, 'INVALID_ARGUMENT', 'Invalid bridge version, session or request ID.');
    try {
      switch (request.operation) {
        case 'capabilities': {
          this.require('read');
          const base = new HydeAuthoringSession(this.editor.project()).capabilities('browser');
          const renderer = this.scopes.has('preview') || this.scopes.has('export') ? await (await this.host()).capabilities() : undefined;
          return this.success(requestId, { ...base, environment: 'live-editor', preview: renderer?.preview ?? base.preview, exports: renderer?.exports ?? base.exports, scopes: [...this.scopes] });
        }
        case 'inspect': {
          this.require('read');
          const project = this.editor.project();
          const query = object(request.payload) as unknown as Parameters<HydeAuthoringSession['inspect']>[0];
          const result = await enrichAssetInspection(project, query, new HydeAuthoringSession(project).inspect(query));
          return this.success(requestId, result);
        }
        case 'evaluate': {
          this.require('read');
          const timeSeconds = object(request.payload).timeSeconds;
          if (typeof timeSeconds !== 'number' || !Number.isFinite(timeSeconds)) throw new Error('A finite timeSeconds is required.');
          return this.success(requestId, new HydeAuthoringSession(this.editor.project()).evaluate(timeSeconds));
        }
        case 'stageAsset': {
          this.require('assets');
          const payload = object(request.payload);
          if (!(payload.bytes instanceof Uint8Array) || typeof payload.mime !== 'string' || !['image', 'video', 'audio', 'font'].includes(String(payload.kind))) throw new Error('Asset bytes, MIME and kind are required.');
          if (this.staged.size >= 100) return this.failure(requestId, 'RESOURCE_LIMIT', 'At most 100 assets can be staged for this session.');
          // Run the same byte, MIME, SVG and size checks as headless authoring
          // before retaining an untrusted payload in the live editor.
          const verifier = new HydeAuthoringSession(this.editor.project());
          verifier.stageAsset(payload.bytes, payload.mime, payload.kind as 'image' | 'video' | 'audio' | 'font', typeof payload.licenseNotice === 'string' ? payload.licenseNotice : undefined);
          const handle = crypto.randomUUID();
          this.staged.set(handle, { bytes: Uint8Array.from(payload.bytes), mime: payload.mime, kind: payload.kind as 'image' | 'video' | 'audio' | 'font', licenseNotice: typeof payload.licenseNotice === 'string' ? payload.licenseNotice : undefined });
          return this.success(requestId, { handle });
        }
        case 'stageAssembly': {
          this.require('assets');
          const payload = object(request.payload);
          if (!(payload.bytes instanceof Uint8Array)) throw new Error('Assembly archive bytes are required.');
          if (this.stagedAssemblies.size >= 100) return this.failure(requestId, 'RESOURCE_LIMIT', 'At most 100 assemblies can be staged for this session.');
          new HydeAuthoringSession(this.editor.project()).stageAssembly(payload.bytes);
          const handle = crypto.randomUUID();
          this.stagedAssemblies.set(handle, Uint8Array.from(payload.bytes));
          return this.success(requestId, { handle });
        }
        case 'execute': {
          this.require('write');
          if (this.mutating) return this.failure(requestId, 'RESOURCE_LIMIT', 'Another automation mutation is in progress.');
          this.mutating = true;
          try {
            const payload = object(request.payload) as unknown as ExecuteRequest;
            const expectedRevision = payload.expectedRevision;
            if (expectedRevision !== this.editor.revision()) return this.failure(requestId, 'REVISION_CONFLICT', `Expected revision ${expectedRevision}; current revision is ${this.editor.revision()}.`);
            if (!Array.isArray(payload.commands) || payload.commands.length < 1 || payload.commands.length > 1000) return this.failure(requestId, 'RESOURCE_LIMIT', 'A batch must contain between 1 and 1000 commands.');
            const session = new HydeAuthoringSession(this.editor.project());
            const stagedHandles: string[] = [], stagedAssemblyHandles: string[] = [];
            const commands = payload.commands.map(command => {
              if (command.op === 'assembly.import') {
                this.require('assets');
                const staged = this.stagedAssemblies.get(command.args.handle);
                if (!staged) throw new Error('Assembly handle is unavailable.');
                stagedAssemblyHandles.push(command.args.handle);
                return { ...command, args: { ...command.args, handle: session.stageAssembly(staged) } } as HydeCommand;
              }
              if (command.op !== 'asset.add' && command.op !== 'asset.replace') return command;
              this.require('assets');
              const staged = this.staged.get(command.args.handle);
              if (!staged) throw new Error('Asset handle is unavailable.');
              stagedHandles.push(command.args.handle);
              return { ...command, args: { ...command.args, handle: session.stageAsset(staged.bytes, staged.mime, staged.kind, staged.licenseNotice) } } as HydeCommand;
            });
            const result = await session.execute({ ...payload, expectedRevision: 0, commands });
            if (!result.ok) return { requestId, ok: false, revision: this.editor.revision(), errors: result.errors };
            if (this.editor.revision() !== expectedRevision || !this.active) return this.failure(requestId, 'REVISION_CONFLICT', 'Editor changed before the automation batch could commit.');
            if (!payload.dryRun) {
              this.editor.commit(session.snapshot());
              for (const handle of stagedHandles) this.staged.delete(handle);
              for (const handle of stagedAssemblyHandles) this.stagedAssemblies.delete(handle);
            }
            return this.success(requestId, { ...result, revision: this.editor.revision() });
          } finally { this.mutating = false; }
        }
        case 'renderFrame': {
          this.require('preview');
          if (this.rendering || [...this.jobs.values()].some(job => ['queued', 'preparing', 'running'].includes(job.state))) return this.failure(requestId, 'RESOURCE_LIMIT', 'A render or export is already running.');
          this.rendering = true;
          try {
            const frame = await (await this.host()).renderFrame(object(request.payload) as unknown as Parameters<HydeRenderHost['renderFrame']>[0]);
            if (!this.active) return this.failure(requestId, 'PERMISSION_DENIED', 'Automation was revoked before the frame completed.');
            return this.success(requestId, frame);
          } finally { this.rendering = false; }
        }
        case 'startExport': {
          this.require('export');
          if (this.rendering || [...this.jobs.values()].some(job => ['queued', 'preparing', 'running'].includes(job.state))) return this.failure(requestId, 'RESOURCE_LIMIT', 'A render or export is already running.');
          const settings = object(request.payload) as unknown as MediaExportSettings;
          const job: ExportJob = { id: crypto.randomUUID(), state: 'queued', progress: 0, controller: new AbortController() };
          const project = structuredClone(this.editor.project());
          for (const [id, old] of this.jobs) if (old.state === 'completed' || old.state === 'failed' || old.state === 'canceled') this.jobs.delete(id);
          this.jobs.set(job.id, job);
          void (async () => {
            const timeout = setTimeout(() => {
              job.timedOut = true; job.controller.abort(); job.state = 'failed';
              job.message = 'Export exceeded the five minute bridge timeout.'; job.artifact = undefined;
            }, EXPORT_TIMEOUT_MS);
            try {
              job.state = 'preparing';
              if (job.controller.signal.aborted) return;
              job.state = 'running';
              const result = await exportMedia(project, settings, { signal: job.controller.signal, onProgress: progress => { job.progress = progress.total ? progress.completed / progress.total : 0; } });
              if (job.controller.signal.aborted) return;
              if (result.blob.size > MAX_ARTIFACT_BYTES) throw new Error('Export artifact exceeds the 512 MiB bridge limit.');
              job.artifact = new Uint8Array(await result.blob.arrayBuffer());
              if (job.controller.signal.aborted) return;
              job.mime = result.blob.type;
              job.progress = 1;
              job.state = 'completed';
            } catch (cause) {
              job.state = job.timedOut ? 'failed' : job.controller.signal.aborted ? 'canceled' : 'failed';
              job.message = job.timedOut ? 'Export exceeded the five minute bridge timeout.' : cause instanceof Error ? cause.message : 'Export failed.';
            } finally {
              clearTimeout(timeout);
              if (job.timedOut && job.state !== 'completed') { job.state = 'failed'; job.message = 'Export exceeded the five minute bridge timeout.'; job.artifact = undefined; }
            }
          })();
          return this.success(requestId, { jobId: job.id });
        }
        case 'jobStatus': {
          this.require('read');
          const job = this.jobs.get(String(object(request.payload).jobId));
          if (!job) return this.failure(requestId, 'TARGET_NOT_FOUND', 'Export job does not exist.');
          return this.success(requestId, { jobId: job.id, state: job.state, progress: job.progress, message: job.message, hasArtifact: !!job.artifact });
        }
        case 'jobArtifact': {
          this.require('export');
          const job = this.jobs.get(String(object(request.payload).jobId));
          if (!job?.artifact || job.state !== 'completed') return this.failure(requestId, 'TARGET_NOT_FOUND', 'Completed export artifact is unavailable.');
          return this.success(requestId, { bytes: Uint8Array.from(job.artifact), mime: job.mime });
        }
        case 'cancelJob': {
          this.require('export');
          const job = this.jobs.get(String(object(request.payload).jobId));
          if (!job) return this.failure(requestId, 'TARGET_NOT_FOUND', 'Export job does not exist.');
          job.controller.abort(); job.state = 'canceled'; job.artifact = undefined;
          return this.success(requestId, { jobId: job.id, state: job.state });
        }
        case 'select': {
          this.require('editorNavigation');
          const ids = object(request.payload).ids;
          if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) throw new Error('ids must be a list of object IDs.');
          this.editor.select(ids);
          return this.success(requestId, { ids });
        }
        case 'setPlayhead': {
          this.require('editorNavigation');
          const timeSeconds = object(request.payload).timeSeconds;
          if (typeof timeSeconds !== 'number' || !Number.isFinite(timeSeconds)) throw new Error('A finite timeSeconds is required.');
          this.editor.setPlayhead(timeSeconds);
          return this.success(requestId, { timeSeconds });
        }
        case 'diagnostics': this.require('read'); return this.success(requestId, []);
        case 'revoke': this.revoke(); return this.success(requestId, { revoked: true }, true);
        default: return this.failure(requestId, 'OPERATION_UNSUPPORTED', `Unsupported bridge operation ${String(request.operation)}.`);
      }
    } catch (cause) {
      const code = cause instanceof Error && 'code' in cause ? String((cause as Error & { code: string }).code) : 'INVALID_ARGUMENT';
      return this.failure(requestId, code, cause instanceof Error ? cause.message : 'Bridge request failed.');
    }
  }
}

declare global {
  interface Window { hydeAutomation?: EditorBridge }
}
