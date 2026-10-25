import { decodeAssemblyBytes, decodeProjectBytes, encodeAssemblyBytes, encodeProjectBytes, validateDocument } from './archive';
import { evaluateProject } from './engine';
import { createElement, createProject, uid } from './model';
import type { AnimProperty, Assembly, Asset, Attachment, ElementKind, Keyframe, Project, ShapePath, StoryElement } from './model';
import { descendantIds, makeAssembly, parentId, reparentElement, worldPoses } from './editing';
import { duplicateScene, deleteScene, moveScene, retimeScene } from './sceneOperations';
import { makeSceneIndependent, placeLinkedScene } from './scenePlacement';
import { movePathAnchor, removePathPoint, setPathHandle, splitPathSegment, withEditablePath } from './shapePath';
import { applyMediaAuthoringCommand, MEDIA_AUTHORING_COMMAND_KEYS, MEDIA_AUTHORING_OPERATIONS, MediaAuthoringError } from './authoringMedia';
import type { MediaAuthoringCommand } from './authoringMedia';
import { applyTimelineCommand, timelineCommandKeys, timelineOperations } from './authoringTimeline';
import type { TimelineCommand } from './authoringTimeline';
import { applyCatalogCommand, CATALOG_COMMAND_KEYS, CATALOG_OPERATIONS, CatalogError } from './authoringCatalog';
import type { CatalogCommand } from './authoringCatalog';
import { validateStagedAsset } from './assetSniff';

export interface HydeDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  targetId?: string;
  commandIndex?: number;
  field?: string;
  details?: Record<string, unknown>;
  suggestions?: string[];
}

type Ref = string;
type ElementCreate = Partial<Pick<StoryElement, 'name' | 'x' | 'y' | 'width' | 'height' | 'rotation' | 'scaleX' | 'scaleY' | 'pivotX' | 'pivotY' | 'fill' | 'stroke' | 'strokeWidth' | 'opacity' | 'start' | 'duration' | 'assetId' | 'text' | 'fontFamily' | 'fontSize' | 'parentId' | 'hidden' | 'locked'>>;
type Transform = Partial<Pick<StoryElement, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'scaleX' | 'scaleY' | 'pivotX' | 'pivotY'>>;
type WorldTransform = Partial<Pick<StoryElement, 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY'>>;
type Appearance = Partial<Pick<StoryElement, 'fill' | 'stroke' | 'strokeWidth' | 'opacity' | 'hidden' | 'optimize' | 'shadow'>>;

export type CoreHydeCommand =
  | { op: 'project.create'; args: { name: string } & Partial<Pick<Project, 'width' | 'height' | 'fps' | 'duration' | 'background' | 'webPlayer'>>; clientCommandId?: string }
  | { op: 'project.updateMetadata'; args: Partial<Pick<Project, 'name' | 'width' | 'height' | 'fps' | 'duration' | 'background' | 'webPlayer'>>; clientCommandId?: string }
  | { op: 'scene.create'; args: { id?: string; alias?: string; name: string; start: number; duration: number; color?: string }; clientCommandId?: string }
  | { op: 'scene.rename'; args: { id: Ref; name: string }; clientCommandId?: string }
  | { op: 'scene.duplicate' | 'scene.delete' | 'scene.retime'; args: { id: Ref; duration?: number; alias?: string }; clientCommandId?: string }
  | { op: 'scene.move'; args: { id: Ref; beforeId?: Ref }; clientCommandId?: string }
  | { op: 'scene.link'; args: { sourceId: Ref; start?: number; alias?: string }; clientCommandId?: string }
  | { op: 'scene.unlink'; args: { id: Ref }; clientCommandId?: string }
  | { op: 'element.create'; args: { id?: string; alias?: string; kind: ElementKind; sceneId?: Ref; properties?: ElementCreate }; clientCommandId?: string }
  | { op: 'element.remove'; args: { id: Ref; descendants?: boolean }; clientCommandId?: string }
  | { op: 'element.setTransform'; args: { id: Ref; transform: Transform; space?: 'local'; timeSeconds?: never }; clientCommandId?: string }
  | { op: 'element.setTransform'; args: { id: Ref; transform: WorldTransform; space: 'world'; timeSeconds?: number }; clientCommandId?: string }
  | { op: 'element.updateAppearance'; args: { id: Ref; appearance: Appearance }; clientCommandId?: string }
  | { op: 'shape.setPath'; args: { id: Ref; path: ShapePath }; clientCommandId?: string }
  | { op: 'shape.convertToPath'; args: { id: Ref }; clientCommandId?: string }
  | { op: 'shape.insertPoint'; args: { id: Ref; index: number; fraction?: number; contourIndex?: number }; clientCommandId?: string }
  | { op: 'shape.movePoint'; args: { id: Ref; index: number; x: number; y: number; contourIndex?: number }; clientCommandId?: string }
  | { op: 'shape.setHandle'; args: { id: Ref; index: number; side: 'in' | 'out'; position?: { x: number; y: number }; contourIndex?: number }; clientCommandId?: string }
  | { op: 'shape.removePoint'; args: { id: Ref; index: number; contourIndex?: number }; clientCommandId?: string }
  | { op: 'assembly.attach'; args: { id: Ref; parentId: Ref; type: Attachment['type']; min?: number; max?: number; preserveWorldPose?: boolean; timeSeconds?: number }; clientCommandId?: string }
  | { op: 'assembly.detach'; args: { id: Ref; preserveWorldPose?: boolean; timeSeconds?: number }; clientCommandId?: string }
  | { op: 'track.ensure'; args: { elementId: Ref; property: AnimProperty }; clientCommandId?: string }
  | { op: 'keyframe.upsert'; args: { elementId: Ref; property: AnimProperty; timeSeconds: number; value: number | string; id?: string; alias?: string; easing?: Keyframe['easing']; direction?: Keyframe['direction']; mode?: Keyframe['mode']; steps?: number }; clientCommandId?: string }
  | { op: 'caption.create'; args: { id?: string; alias?: string; sceneId?: Ref; text: string; start: number; end: number }; clientCommandId?: string }
  | { op: 'asset.add'; args: { id?: string; alias?: string; handle: string; name: string; duration?: number; reuseExisting?: boolean }; clientCommandId?: string };

export type HydeCommand = CoreHydeCommand | (TimelineCommand & { clientCommandId?: string }) | MediaAuthoringCommand | CatalogCommand;

export interface ExecuteRequest { protocolVersion: 1; expectedRevision: number; commands: HydeCommand[]; dryRun?: boolean; correlationId?: string }
export interface ChangeSummary { added: string[]; changed: string[]; removed: string[] }
export interface InspectRequest {
  target: 'project' | 'scenes' | 'scene' | 'elements' | 'element' | 'assets' | 'asset' | 'changes' | 'tree' | 'timeline' | 'assembly' | 'environment' | 'jobs';
  id?: string; sceneId?: string; fields?: string[] | string; limit?: number; cursor?: number; depth?: number;
  sinceRevision?: number; timeStart?: number; timeEnd?: number;
}
export type ExecuteResult =
  | { ok: true; revision: number; applied: number; idMap: Record<string, string>; changes: ChangeSummary; warnings: HydeDiagnostic[] }
  | { ok: false; revision: number; errors: HydeDiagnostic[]; warnings: HydeDiagnostic[] };

const coreOperations = [
  'project.create', 'project.updateMetadata', 'scene.create', 'scene.rename', 'scene.duplicate', 'scene.delete', 'scene.retime', 'scene.move', 'scene.link', 'scene.unlink',
  'element.create', 'element.remove', 'element.setTransform', 'element.updateAppearance',
  'shape.setPath', 'shape.convertToPath', 'shape.insertPoint', 'shape.movePoint', 'shape.setHandle', 'shape.removePoint',
  'assembly.attach', 'assembly.detach', 'track.ensure', 'keyframe.upsert', 'caption.create', 'asset.add',
] as const;
export const HYDE_OPERATIONS = [...new Set<string>([...coreOperations, ...timelineOperations, ...MEDIA_AUTHORING_OPERATIONS, ...CATALOG_OPERATIONS])];

const coreCommandKeys: Record<(typeof coreOperations)[number], string[]> = {
  'project.create': ['name', 'width', 'height', 'fps', 'duration', 'background', 'webPlayer'],
  'project.updateMetadata': ['name', 'width', 'height', 'fps', 'duration', 'background', 'webPlayer'],
  'scene.create': ['id', 'alias', 'name', 'start', 'duration', 'color'],
  'scene.rename': ['id', 'name'],
  'scene.duplicate': ['id', 'alias'],
  'scene.delete': ['id'],
  'scene.retime': ['id', 'duration'],
  'scene.move': ['id', 'beforeId'],
  'scene.link': ['sourceId', 'start', 'alias'],
  'scene.unlink': ['id'],
  'element.create': ['id', 'alias', 'kind', 'sceneId', 'properties'],
  'element.remove': ['id', 'descendants'],
  'element.setTransform': ['id', 'transform', 'space', 'timeSeconds'],
  'element.updateAppearance': ['id', 'appearance'],
  'shape.setPath': ['id', 'path'],
  'shape.convertToPath': ['id'],
  'shape.insertPoint': ['id', 'index', 'fraction', 'contourIndex'],
  'shape.movePoint': ['id', 'index', 'x', 'y', 'contourIndex'],
  'shape.setHandle': ['id', 'index', 'side', 'position', 'contourIndex'],
  'shape.removePoint': ['id', 'index', 'contourIndex'],
  'assembly.attach': ['id', 'parentId', 'type', 'min', 'max', 'preserveWorldPose', 'timeSeconds'],
  'assembly.detach': ['id', 'preserveWorldPose', 'timeSeconds'],
  'track.ensure': ['elementId', 'property'],
  'keyframe.upsert': ['elementId', 'property', 'timeSeconds', 'value', 'id', 'alias', 'easing', 'direction', 'mode', 'steps'],
  'caption.create': ['id', 'alias', 'sceneId', 'text', 'start', 'end'],
  'asset.add': ['id', 'alias', 'handle', 'name', 'duration', 'reuseExisting'],
};
export const HYDE_COMMAND_KEYS: Record<string, readonly string[]> = { ...coreCommandKeys, ...timelineCommandKeys, ...MEDIA_AUTHORING_COMMAND_KEYS, ...CATALOG_COMMAND_KEYS };
const elementCreateKeys = ['name', 'x', 'y', 'width', 'height', 'rotation', 'scaleX', 'scaleY', 'pivotX', 'pivotY', 'fill', 'stroke', 'strokeWidth', 'opacity', 'start', 'duration', 'assetId', 'text', 'fontFamily', 'fontSize', 'parentId', 'hidden', 'locked'];
const transformKeys = ['x', 'y', 'width', 'height', 'rotation', 'scaleX', 'scaleY', 'pivotX', 'pivotY'];
const appearanceKeys = ['fill', 'stroke', 'strokeWidth', 'opacity', 'hidden', 'optimize', 'shadow'];
function assertKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const unknown = Object.keys(value).find(key => !allowed.includes(key) || ['__proto__', 'constructor', 'prototype'].includes(key));
  if (unknown) throw new Error(`${label} does not support ${unknown}.`);
}

function diagnostic(code: string, message: string, commandIndex?: number): HydeDiagnostic {
  return { code, severity: 'error', message, commandIndex };
}
function commandDiagnostic(cause: unknown, command: HydeCommand, commandIndex: number, aliases: Map<string, string>): HydeDiagnostic {
  const message = cause instanceof Error ? cause.message : 'Command failed.';
  const input = command && typeof command === 'object' ? command as Record<string, unknown> : {};
  const args = input.args && typeof input.args === 'object' && !Array.isArray(input.args) ? input.args as Record<string, unknown> : {};
  const op = typeof input.op === 'string' ? input.op : '';
  const requested = /scene does not exist/i.test(message) && typeof args.sceneId === 'string' ? args.sceneId
    : /parent.*does not exist/i.test(message) && typeof args.parentId === 'string' ? args.parentId
      : /^keyframe\.|^track\.|^motion\./.test(op) && typeof args.elementId === 'string' ? args.elementId
        : ['id', 'elementId', 'sceneId', 'assetId', 'sourceId', 'parentId', 'targetId', 'clipId', 'instanceId']
          .map(key => args[key]).find(value => typeof value === 'string') as string | undefined;
  const unsupported = /\bdoes not support ([A-Za-z][A-Za-z0-9_]*)\b/.exec(message);
  const explicitField = cause instanceof MediaAuthoringError || cause instanceof CatalogError ? cause.field
    : op === 'asset.add' && message.startsWith('duration must') ? 'duration' : undefined;
  const patch = op === 'element.updateAppearance' ? args.appearance
    : op === 'element.setTransform' ? args.transform
      : op === 'project.updateMetadata' ? args : undefined;
  const patchKeys = patch && typeof patch === 'object' && !Array.isArray(patch) ? Object.keys(patch) : [];
  return {
    ...diagnostic(failureCode(cause), message, commandIndex),
    ...(requested ? { targetId: aliases.get(requested) ?? requested } : {}),
    ...(explicitField ? { field: explicitField } : unsupported ? { field: unsupported[1] } : patchKeys.length === 1 ? { field: patchKeys[0] } : {}),
  };
}
function failureCode(cause: unknown): string {
  if (cause instanceof MediaAuthoringError || cause instanceof CatalogError) return cause.code;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/Unsupported operation/.test(message)) return 'OPERATION_UNSUPPORTED';
  if (/duplicate|already exists|collision/i.test(message)) return 'DUPLICATE_ID';
  if (/cycle/i.test(message)) return 'ATTACHMENT_CYCLE';
  if (/attachment|reparent|parent/i.test(message)) return 'INVALID_ATTACHMENT';
  if (/time|duration|range|start|end|fps/i.test(message)) return 'INVALID_TIMING';
  if (/path|point|geometry|shape/i.test(message)) return 'INVALID_GEOMETRY';
  if (/asset|MIME|SVG|media/i.test(message)) return 'INVALID_ASSET';
  if (/does not exist|not found|unavailable|missing/i.test(message)) return 'TARGET_NOT_FOUND';
  return 'INVALID_ARGUMENT';
}
function namedId(id: string | undefined, alias: string | undefined, ids: Map<string, string>): string {
  const value = id ?? uid();
  if (!value || value.startsWith('$')) throw new Error('Native IDs must be nonempty and cannot begin with $.');
  if (alias) {
    if (!alias.startsWith('$') || ids.has(alias)) throw new Error('Alias must be a unique name beginning with $.');
    ids.set(alias, value);
  }
  return value;
}
function resolve(id: Ref, ids: Map<string, string>): string {
  if (!id.startsWith('$')) return id;
  const resolved = ids.get(id);
  if (!resolved) throw new Error(`Unknown batch alias ${id}.`);
  return resolved;
}
function requiredElement(project: Project, id: string): StoryElement {
  const element = project.elements.find(item => item.id === id);
  if (!element) throw new Error(`Element ${id} does not exist.`);
  return element;
}
const spatialProperties = new Set(['x', 'y', 'rotation', 'scaleX', 'scaleY']);

/** Convert a requested stage pose through the exact Hyde parent evaluation at
 * one story time. Authored base values cannot override an active local track,
 * placed clip, or procedural behavior, so those cases fail explicitly. */
function setWorldTransform(project: Project, id: string, requested: WorldTransform, time: number): void {
  if (!Number.isFinite(time) || time < 0) throw new Error('World transform timeSeconds must be finite and nonnegative.');
  const target = requiredElement(project, id);
  if (Object.keys(requested).some(key => !spatialProperties.has(key))) throw new Error('World transform supports x, y, rotation, scaleX, and scaleY only; edit dimensions and pivot in local space.');
  const affected = new Set(Object.keys(requested));
  if (affected.has('x') || affected.has('y')) { affected.add('x'); affected.add('y'); }
  if (target.tracks.some(track => affected.has(track.property) && track.keyframes.length)
    || target.motionBehaviors?.some(behavior => behavior.enabled)
    || project.elements.some(owner => owner.clipInstances?.length && (
      owner.assemblyClips?.some(clip => clip.tracks.some(track => track.elementId === id && affected.has(track.property)))
      || owner.clipInstances.some(instance => instance.trackOverrides?.some(track => track.elementId === id && affected.has(track.property)))
    ))) throw new Error('World transform cannot change a part with authored transform animation; edit its keys, clip, or motion behavior.');

  const poses = worldPoses(project, time);
  const current = poses.get(id);
  if (!current) throw new Error('World transform target has no evaluable source pose at timeSeconds.');
  const parent = parentId(target) ? poses.get(parentId(target)!) : undefined;
  if (parentId(target) && !parent) throw new Error('World transform parent has no evaluable source pose at timeSeconds.');
  if (requested.x !== undefined || requested.y !== undefined) {
    const x = (requested.x ?? current.x) - (parent?.x ?? 0);
    const y = (requested.y ?? current.y) - (parent?.y ?? 0);
    if (parent) {
      if (Math.abs(parent.scaleX) < 1e-10 || Math.abs(parent.scaleY) < 1e-10) throw new Error('World transform cannot invert a zero-scale parent.');
      const radians = -parent.rotation * Math.PI / 180;
      target.x = (x * Math.cos(radians) - y * Math.sin(radians)) / parent.scaleX;
      target.y = (x * Math.sin(radians) + y * Math.cos(radians)) / parent.scaleY;
    } else { target.x = x; target.y = y; }
  }
  if (requested.rotation !== undefined) target.rotation = requested.rotation - (parent?.rotation ?? 0);
  for (const field of ['scaleX', 'scaleY'] as const) if (requested[field] !== undefined) {
    const factor = parent?.[field] ?? 1;
    if (Math.abs(factor) < 1e-10) throw new Error('World transform cannot invert a zero-scale parent.');
    target[field] = requested[field] / factor;
  }
  const result = worldPoses(project, time).get(id);
  if (!result || Object.entries(requested).some(([key, value]) =>
    Math.abs((result[key as keyof WorldTransform] as number) - (value as number)) > 1e-6 * Math.max(1, Math.abs(value as number)))) {
    throw new Error('World transform cannot produce the requested pose under this attachment or active scene.');
  }
}
function bytesDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}
function summarize(before: Project, after: Project): ChangeSummary {
  const collect = (model: Project) => new Map<string, unknown>([
    ...model.sequences.map(item => [`scene:${item.id}`, item] as const),
    ...model.elements.map(item => [`element:${item.id}`, item] as const),
    ...model.assets.map(item => [`asset:${item.id}`, { ...item, dataUrl: undefined }] as const),
    ...model.captions.map(item => [`caption:${item.id}`, item] as const),
  ]);
  const old = collect(before), next = collect(after);
  return {
    added: [...next.keys()].filter(id => !old.has(id)).sort(),
    removed: [...old.keys()].filter(id => !next.has(id)).sort(),
    changed: [...next.keys()].filter(id => old.has(id) && JSON.stringify(next.get(id)) !== JSON.stringify(old.get(id))).sort(),
  };
}
function projectFields(value: Record<string, unknown>, fields?: string[] | string): Record<string, unknown> {
  if (fields === undefined) return value;
  const selected = typeof fields === 'string' ? fields.split(',').map(part => part.trim()).filter(Boolean) : fields;
  if (!Array.isArray(selected) || selected.length > 40 || selected.some(field => typeof field !== 'string' || field.length > 100)) throw new Error('Inspection fields must contain at most 40 field names.');
  return Object.fromEntries(Object.entries(value).filter(([field]) => selected.includes(field)));
}
function inspectedScene(project: Project, scene: Project['sequences'][number]) {
  const source = scene.sourceSceneId && project.sequences.find(item => item.id === scene.sourceSceneId);
  return {
    ...structuredClone(scene),
    ...(source && scene.duration > 0 ? { speed: ((scene.sourceOut ?? source.duration) - (scene.sourceIn ?? 0)) / scene.duration } : {}),
  };
}

export class HydeAuthoringSession {
  private project: Project;
  private readonly canCreateProject: boolean;
  private currentRevision = 0;
  private undoStack: Project[] = [];
  private redoStack: Project[] = [];
  private readonly staged = new Map<string, { bytes: Uint8Array; mime: string; kind: Asset['kind']; licenseNotice?: string }>();
  private readonly stagedAssemblies = new Map<string, Assembly>();
  private readonly changes = new Map<number, ChangeSummary>();
  private readonly replay = new Map<string, { signature: string; result: Extract<ExecuteResult, { ok: true }> }>();

  constructor(project: Project, canCreateProject = false) {
    validateDocument(project, false);
    this.project = structuredClone(project);
    this.canCreateProject = canCreateProject;
  }
  static create(name?: string): HydeAuthoringSession { return new HydeAuthoringSession(createProject(name), true); }
  static open(bytes: Uint8Array): HydeAuthoringSession { return new HydeAuthoringSession(decodeProjectBytes(bytes)); }
  get revision(): number { return this.currentRevision; }
  capabilities(environment: 'node' | 'browser' = typeof window === 'undefined' ? 'node' : 'browser') {
    return {
      protocolVersion: 1 as const, sdkVersion: '0.1.0', projectVersions: [1], assemblyVersions: [1],
      operations: [...HYDE_OPERATIONS], environment,
      preview: { frames: false, audio: false, video: false },
      exports: ['hyde', 'hy', 'hyproj'] as const,
      resourceLimits: { maxArchiveBytes: 512 * 1024 * 1024, maxCommandsPerBatch: 1000 },
    };
  }
  stageAsset(bytes: Uint8Array, mime: string, kind: Asset['kind'], licenseNotice?: string): string {
    if (!bytes.byteLength || bytes.byteLength > 128 * 1024 * 1024 || !/^[\w.+-]+\/[\w.+-]+$/.test(mime)) throw new Error('Invalid or oversized asset bytes.');
    validateStagedAsset(bytes, mime, kind);
    if (licenseNotice !== undefined && (kind !== 'font' || licenseNotice.length > 100000)) throw new Error('Only font assets can have a bounded license notice.');
    const handle = uid();
    this.staged.set(handle, { bytes: Uint8Array.from(bytes), mime, kind, licenseNotice });
    return handle;
  }
  discardAsset(handle: string): void { this.staged.delete(handle); }
  stageAssembly(bytes: Uint8Array): string {
    const assembly = decodeAssemblyBytes(bytes);
    const handle = uid();
    this.stagedAssemblies.set(handle, assembly);
    return handle;
  }
  discardAssembly(handle: string): void { this.stagedAssemblies.delete(handle); }
  snapshot(): Project { return structuredClone(this.project); }
  exportProject(): Uint8Array { return encodeProjectBytes(this.project); }
  exportAssembly(rootId: string, timeSeconds?: number): Uint8Array { return encodeAssemblyBytes(makeAssembly(this.project, [rootId], timeSeconds)); }
  evaluate(timeSeconds: number): StoryElement[] { return evaluateProject(this.project, timeSeconds).map(item => structuredClone(item)); }
  inspect(query: InspectRequest) {
    const invalid = (field: string, message: string) => ({ revision: this.revision, error: { ...diagnostic('INVALID_ARGUMENT', message), field } });
    if (!query || typeof query !== 'object' || Array.isArray(query)) return invalid('query', 'Inspection query must be an object.');
    if (!['project', 'scenes', 'scene', 'elements', 'element', 'assets', 'asset', 'changes', 'tree', 'timeline', 'assembly', 'environment', 'jobs'].includes(query.target))
      return { revision: this.revision, error: diagnostic('OPERATION_UNSUPPORTED', 'Inspection target is unsupported.') };
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)) return invalid('limit', 'Inspection limit must be an integer from 1 to 100.');
    if (query.cursor !== undefined && (!Number.isSafeInteger(query.cursor) || query.cursor < 0)) return invalid('cursor', 'Inspection cursor must be a nonnegative integer.');
    if (query.depth !== undefined && (!Number.isSafeInteger(query.depth) || query.depth < 0 || query.depth > 8)) return invalid('depth', 'Inspection depth must be an integer from 0 to 8.');
    if (query.fields !== undefined) {
      const fields = typeof query.fields === 'string' ? query.fields.split(',').map(part => part.trim()).filter(Boolean) : query.fields;
      if (!Array.isArray(fields) || !fields.length || fields.length > 40 || fields.some(field => typeof field !== 'string' || !field || field.length > 100))
        return invalid('fields', 'Inspection fields must contain 1 to 40 nonempty field names.');
    }
    if (query.sinceRevision !== undefined && (!Number.isSafeInteger(query.sinceRevision) || query.sinceRevision < 0)) return invalid('sinceRevision', 'sinceRevision must be a nonnegative integer.');
    if (query.timeStart !== undefined && (!Number.isFinite(query.timeStart) || query.timeStart < 0)) return invalid('timeStart', 'Timeline start must be finite and nonnegative.');
    if (query.timeEnd !== undefined && (!Number.isFinite(query.timeEnd) || query.timeEnd < 0)) return invalid('timeEnd', 'Timeline end must be finite and nonnegative.');
    if (query.timeStart !== undefined && query.timeEnd !== undefined && query.timeEnd < query.timeStart) return invalid('timeEnd', 'Timeline end must not precede start.');
    if (query.sceneId !== undefined && !this.project.sequences.some(scene => scene.id === query.sceneId))
      return { revision: this.revision, error: { ...diagnostic('TARGET_NOT_FOUND', 'Scene does not exist.'), targetId: query.sceneId, field: 'sceneId' } };
    const limit = query.limit ?? 25;
    const cursor = query.cursor ?? 0;
    if (query.target === 'environment') return { revision: this.revision, environment: projectFields({ ...this.capabilities(), pendingJobCount: 0 }, query.fields) };
    if (query.target === 'jobs') return { revision: this.revision, items: [] as Record<string, unknown>[], nextCursor: undefined };
    if (query.target === 'project') return { revision: this.revision, project: projectFields({ id: this.project.id, name: this.project.name, width: this.project.width, height: this.project.height, fps: this.project.fps, duration: this.project.duration, sceneCount: this.project.sequences.length, elementCount: this.project.elements.length, assetCount: this.project.assets.length, captionCount: this.project.captions.length, folderCount: this.project.folders?.length ?? 0 }, query.fields), warnings: [] as HydeDiagnostic[] };
    if (query.target === 'changes') {
      const from = query.sinceRevision ?? this.revision;
      if (from < 0 || from > this.revision || [...Array(this.revision - from)].some((_, i) => !this.changes.has(from + i + 1))) return { revision: this.revision, error: diagnostic('DIFF_UNAVAILABLE', 'Revision changes are no longer available; inspect the current project.') };
      return { revision: this.revision, changes: [...this.changes.entries()].filter(([revision]) => revision > from).map(([revision, changes]) => ({ revision, changes })) };
    }
    if (query.target === 'element') {
      const element = this.project.elements.find(item => item.id === query.id);
      if (!element) return { revision: this.revision, error: { ...diagnostic('TARGET_NOT_FOUND', 'Element does not exist.'), targetId: query.id } };
      return { revision: this.revision, element: projectFields(structuredClone(element) as unknown as Record<string, unknown>, query.fields) };
    }
    if (query.target === 'asset') {
      const asset = this.project.assets.find(item => item.id === query.id);
      if (!asset) return { revision: this.revision, error: { ...diagnostic('TARGET_NOT_FOUND', 'Asset does not exist.'), targetId: query.id } };
      const { dataUrl: _data, ...metadata } = asset;
      return { revision: this.revision, asset: projectFields(structuredClone(metadata), query.fields) };
    }
    if (query.target === 'scene') {
      const scene = this.project.sequences.find(item => item.id === query.id);
      if (!scene) return { revision: this.revision, error: { ...diagnostic('TARGET_NOT_FOUND', 'Scene does not exist.'), targetId: query.id } };
      return { revision: this.revision, scene: projectFields(inspectedScene(this.project, scene), query.fields), elements: this.project.elements.filter(item => item.sceneId === scene.id).slice(cursor, cursor + limit).map(item => structuredClone(item)), nextCursor: cursor + limit < this.project.elements.filter(item => item.sceneId === scene.id).length ? cursor + limit : undefined };
    }
    if (query.target === 'tree' || query.target === 'assembly') {
      const assemblyRoot = query.target === 'assembly' ? this.project.elements.find(item => item.id === query.id) : undefined;
      if (query.target === 'assembly' && !assemblyRoot) return { revision: this.revision, error: { ...diagnostic('TARGET_NOT_FOUND', 'Assembly root does not exist.'), targetId: query.id } };
      const roots = assemblyRoot ? [assemblyRoot] : this.project.elements.filter(item => (query.sceneId === undefined || item.sceneId === query.sceneId) && !item.parentId);
      const maxDepth = query.depth ?? 3;
      const visit = (item: StoryElement, depth: number): Record<string, unknown> => ({ id: item.id, name: item.name, kind: item.kind, sceneId: item.sceneId, parentId: item.parentId, attachment: item.attachment, childCount: this.project.elements.filter(child => child.parentId === item.id).length, ...(depth < maxDepth ? { children: this.project.elements.filter(child => child.parentId === item.id).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 100).map(child => visit(child, depth + 1)) } : {}) });
      const ordered = [...roots].sort((a, b) => a.id.localeCompare(b.id));
      return { revision: this.revision, items: ordered.slice(cursor, cursor + limit).map(root => visit(root, 0)), nextCursor: cursor + limit < ordered.length ? cursor + limit : undefined };
    }
    if (query.target === 'timeline') {
      const start = query.timeStart ?? 0, end = query.timeEnd ?? this.project.duration;
      if (end < start) return invalid('timeEnd', 'Timeline end must not precede start.');
      const items = this.project.elements.filter(item => (query.sceneId === undefined || item.sceneId === query.sceneId) && item.start < end && item.start + item.duration >= start).sort((a, b) => a.id.localeCompare(b.id));
      const captions = this.project.captions.filter(caption => (query.sceneId === undefined || caption.sceneId === query.sceneId) && caption.start < end && caption.end >= start).sort((a, b) => a.id.localeCompare(b.id));
      return { revision: this.revision, range: { start, end }, items: items.slice(cursor, cursor + limit).map(item => {
        const visibleInstances = item.clipInstances?.filter(instance => item.start + instance.start < end && item.start + instance.start + instance.duration >= start) ?? [];
        return { id: item.id, name: item.name, kind: item.kind, sceneId: item.sceneId, start: item.start, duration: item.duration,
          tracks: item.tracks.map(track => { const keys = track.keyframes.filter(key => key.time >= start - item.start && key.time <= end - item.start);
            return { property: track.property, keyframes: keys.slice(0, 100), visibleKeyframeCount: keys.length, keyframesTruncated: keys.length > 100 }; }),
          motionBehaviors: item.motionBehaviors?.slice(0, 100).map(behavior => ({ id: behavior.id, type: behavior.type })),
          motionBehaviorCount: item.motionBehaviors?.length ?? 0, motionBehaviorsTruncated: (item.motionBehaviors?.length ?? 0) > 100,
          assemblyClips: item.assemblyClips?.slice(0, 100).map(clip => ({ id: clip.id, name: clip.name, duration: clip.duration, trackCount: clip.tracks.length })),
          assemblyClipCount: item.assemblyClips?.length ?? 0, assemblyClipsTruncated: (item.assemblyClips?.length ?? 0) > 100,
          clipInstances: visibleInstances.slice(0, 100).map(instance => ({ id: instance.id, clipId: instance.clipId, start: instance.start, timelineStart: item.start + instance.start, duration: instance.duration,
            overrideCount: instance.trackOverrides?.length ?? 0, gapTransitionCount: instance.gapTransitions?.length ?? 0,
            priorityOverrideCount: instance.priorityOverrides?.length ?? 0, textureOverlapCount: instance.textureOverlaps?.length ?? 0 })),
          visibleClipInstanceCount: visibleInstances.length, clipInstancesTruncated: visibleInstances.length > 100 };
      }), captions: captions.slice(cursor, cursor + limit).map(caption => ({ id: caption.id, text: caption.text, start: caption.start, end: caption.end })),
        visibleCaptionCount: captions.length, captionsTruncated: cursor + limit < captions.length,
        nextCaptionCursor: cursor + limit < captions.length ? cursor + limit : undefined,
        nextCursor: cursor + limit < items.length ? cursor + limit : undefined };
    }
    const list = query.target === 'scenes' ? this.project.sequences.map(scene => inspectedScene(this.project, scene)) : query.target === 'assets'
      ? this.project.assets.map(({ dataUrl: _bytes, ...metadata }) => metadata)
      : this.project.elements.filter(item => query.sceneId === undefined || item.sceneId === query.sceneId).map(({ tracks, assemblyClips, clipInstances, motionBehaviors, shapePath, ...summary }) => ({ ...summary, trackCount: tracks.length, clipCount: assemblyClips?.length ?? 0, instanceCount: clipInstances?.length ?? 0, motionCount: motionBehaviors?.length ?? 0, pathPointCount: shapePath?.points.length ?? 0 }));
    const ordered = [...list].sort((a, b) => a.id.localeCompare(b.id));
    return { revision: this.revision, items: structuredClone(ordered.slice(cursor, cursor + limit)).map(item => projectFields(item as Record<string, unknown>, query.fields)), nextCursor: cursor + limit < ordered.length ? cursor + limit : undefined };
  }
  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    if (request.protocolVersion !== 1) return { ok: false, revision: this.revision, errors: [diagnostic('SCHEMA_UNSUPPORTED', 'Command protocol version is unsupported.')], warnings: [] };
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) return { ok: false, revision: this.revision, errors: [{ ...diagnostic('INVALID_ARGUMENT', 'expectedRevision must be a nonnegative integer.'), field: 'expectedRevision' }], warnings: [] };
    if (request.correlationId !== undefined && (typeof request.correlationId !== 'string' || request.correlationId.length < 1 || request.correlationId.length > 128)) return { ok: false, revision: this.revision, errors: [diagnostic('INVALID_ARGUMENT', 'correlationId must contain 1 to 128 characters.')], warnings: [] };
    let signature = '';
    if (request.correlationId) {
      try { signature = JSON.stringify({ commands: request.commands, dryRun: request.dryRun }); }
      catch { return { ok: false, revision: this.revision, errors: [diagnostic('INVALID_ARGUMENT', 'Commands must be JSON-compatible data.')], warnings: [] }; }
    }
    const replayed = request.correlationId ? this.replay.get(request.correlationId) : undefined;
    if (replayed) return replayed.signature === signature ? structuredClone(replayed.result) : { ok: false, revision: this.revision, errors: [diagnostic('INVALID_ARGUMENT', 'correlationId was reused for a different batch.')], warnings: [] };
    if (request.expectedRevision !== this.revision) {
      const changed = [...this.changes.entries()].filter(([revision]) => revision > request.expectedRevision);
      const changes = changed.slice(0, 25).map(([revision, change]) => ({ revision, added: change.added.slice(0, 50), changed: change.changed.slice(0, 50), removed: change.removed.slice(0, 50) }));
      const truncated = changed.length > changes.length || changed.slice(0, 25).some(([, change]) => change.added.length > 50 || change.changed.length > 50 || change.removed.length > 50);
      return { ok: false, revision: this.revision, errors: [{ ...diagnostic('REVISION_CONFLICT', `Expected revision ${request.expectedRevision}; current revision is ${this.revision}.`), field: 'expectedRevision', details: { expectedRevision: request.expectedRevision, currentRevision: this.revision, changes, truncated }, suggestions: ['Inspect changed IDs, then retry with the current revision.'] }], warnings: [] };
    }
    if (!Array.isArray(request.commands) || request.commands.length < 1 || request.commands.length > 1000) return { ok: false, revision: this.revision, errors: [diagnostic('RESOURCE_LIMIT', 'A batch must contain between 1 and 1000 commands.')], warnings: [] };
    let candidate = structuredClone(this.project);
    const aliases = new Map<string, string>(), usedHandles = new Set<string>(), usedAssemblyHandles = new Set<string>(), seenCommands = new Set<string>();
    for (let index = 0; index < request.commands.length; index++) {
      const command = request.commands[index];
      try {
        assertKeys(command, ['op', 'args', 'clientCommandId'], 'Command');
        if (typeof command.op !== 'string' || !command.op || command.clientCommandId !== undefined && (typeof command.clientCommandId !== 'string' || !command.clientCommandId || command.clientCommandId.length > 128)) throw new Error('Operation and clientCommandId must be valid strings.');
        if (command.clientCommandId) {
          if (seenCommands.has(command.clientCommandId)) throw new Error('Repeated clientCommandId in one batch.');
          seenCommands.add(command.clientCommandId);
        }
        candidate = this.apply(candidate, command, aliases, usedHandles, usedAssemblyHandles);
      } catch (error) {
        return { ok: false, revision: this.revision, errors: [commandDiagnostic(error, command, index, aliases)], warnings: [] };
      }
    }
    candidate.updatedAt = new Date().toISOString();
    try { validateDocument(candidate, false); }
    catch (error) {
      const cause = request.commands.length === 1
        ? commandDiagnostic(error, request.commands[0], 0, aliases)
        : diagnostic(failureCode(error), error instanceof Error ? error.message : 'Project validation failed.');
      return { ok: false, revision: this.revision, errors: [cause], warnings: [] };
    }
    const changes = summarize(this.project, candidate);
    const result = { ok: true as const, revision: this.revision + (request.dryRun ? 0 : 1), applied: request.commands.length, idMap: Object.fromEntries(aliases), changes, warnings: [] };
    if (!request.dryRun) {
      this.undoStack.push(this.project);
      this.redoStack = [];
      this.project = candidate;
      this.currentRevision++;
      this.changes.set(this.revision, changes);
      for (const handle of usedHandles) this.staged.delete(handle);
      for (const handle of usedAssemblyHandles) this.stagedAssemblies.delete(handle);
      if (request.correlationId) {
        this.replay.set(request.correlationId, { signature, result });
        if (this.replay.size > 128) this.replay.delete(this.replay.keys().next().value!);
      }
    }
    return result;
  }
  undo(expectedRevision: number): boolean {
    if (expectedRevision !== this.revision || !this.undoStack.length) return false;
    const previous = this.undoStack.pop()!;
    this.redoStack.push(this.project);
    this.changes.set(++this.currentRevision, summarize(this.project, previous));
    this.project = previous;
    this.replay.clear();
    return true;
  }
  redo(expectedRevision: number): boolean {
    if (expectedRevision !== this.revision || !this.redoStack.length) return false;
    const next = this.redoStack.pop()!;
    this.undoStack.push(this.project);
    this.changes.set(++this.currentRevision, summarize(this.project, next));
    this.project = next;
    this.replay.clear();
    return true;
  }
  private apply(project: Project, command: HydeCommand, aliases: Map<string, string>, usedHandles: Set<string>, usedAssemblyHandles: Set<string>): Project {
    // The public discriminated union types callers; incoming bridge/CLI JSON is
    // checked again by command preconditions and the full native validator.
    const args = command.args as any;
    if (!Object.hasOwn(HYDE_COMMAND_KEYS, command.op)) throw new Error(`Unsupported operation ${command.op}.`);
    assertKeys(args, HYDE_COMMAND_KEYS[command.op], `${command.op} arguments`);
    if (Object.hasOwn(timelineCommandKeys, command.op)) return applyTimelineCommand(project, command as TimelineCommand, {
      resolve: ref => resolve(ref, aliases),
      register: (alias, id) => { if (alias !== undefined) namedId(id, alias, aliases); },
    });
    if (Object.hasOwn(MEDIA_AUTHORING_COMMAND_KEYS, command.op)) return applyMediaAuthoringCommand(project, command as MediaAuthoringCommand, {
      resolveAlias: ref => resolve(ref, aliases),
      bindAlias: (alias, id) => { namedId(id, alias, aliases); },
    });
    if (Object.hasOwn(CATALOG_COMMAND_KEYS, command.op)) return applyCatalogCommand(project, command as CatalogCommand, {
      resolve: ref => resolve(ref, aliases),
      register: (alias, id) => { if (alias !== undefined) namedId(id, alias, aliases); },
      stagedAsset: handle => {
        const payload = this.staged.get(handle);
        return payload && { kind: payload.kind, mime: payload.mime, dataUrl: bytesDataUrl(payload.bytes, payload.mime), licenseNotice: payload.licenseNotice };
      },
      useHandle: handle => { if (usedHandles.has(handle)) throw new Error('Asset handle is already used in this batch.'); usedHandles.add(handle); },
      stagedAssembly: handle => this.stagedAssemblies.get(handle),
      useAssemblyHandle: handle => { if (usedAssemblyHandles.has(handle)) throw new Error('Assembly handle is already used in this batch.'); usedAssemblyHandles.add(handle); },
    });
    if (command.op === 'element.create' && args.properties !== undefined) assertKeys(args.properties, elementCreateKeys, 'Element properties');
    if (command.op === 'element.setTransform') assertKeys(args.transform, transformKeys, 'Transform');
    if (command.op === 'element.updateAppearance') assertKeys(args.appearance, appearanceKeys, 'Appearance');
    switch (command.op) {
      case 'project.create': {
        if (!this.canCreateProject || this.currentRevision !== 0 || project.elements.length || project.assets.length || project.sequences.length !== 1 || project.captions.length) throw new Error('project.create is available only in a new, empty SDK project.');
        if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('project.create requires a name.');
        Object.assign(project, args);
        break;
      }
      case 'project.updateMetadata': Object.assign(project, args); break;
      case 'scene.create': {
        const id = namedId(args.id, args.alias, aliases);
        if (project.sequences.some(scene => scene.id === id)) throw new Error(`Scene ${id} already exists.`);
        project.sequences.push({ id, name: args.name, start: args.start, duration: args.duration, color: args.color ?? '#ffc857' });
        project.duration = Math.max(project.duration, args.start + args.duration);
        break;
      }
      case 'scene.rename': {
        const scene = project.sequences.find(item => item.id === resolve(args.id, aliases));
        if (!scene) throw new Error('Scene does not exist.'); scene.name = args.name; break;
      }
      case 'scene.duplicate': {
        const result = duplicateScene(project, resolve(args.id, aliases)); project = result.project;
        if (args.alias) aliases.set(args.alias, result.sceneId); break;
      }
      case 'scene.delete': project = deleteScene(project, resolve(args.id, aliases)); break;
      case 'scene.retime': project = retimeScene(project, resolve(args.id, aliases), args.duration ?? NaN); break;
      case 'scene.move': project = moveScene(project, resolve(args.id, aliases), args.beforeId ? resolve(args.beforeId, aliases) : undefined); break;
      case 'scene.link': {
        const result = placeLinkedScene(project, resolve(args.sourceId, aliases), args.start); project = result.project;
        if (args.alias) aliases.set(args.alias, result.sceneId); break;
      }
      case 'scene.unlink': project = makeSceneIndependent(project, resolve(args.id, aliases)); break;
      case 'element.create': {
        const id = namedId(args.id, args.alias, aliases);
        if (project.elements.some(item => item.id === id)) throw new Error(`Element ${id} already exists.`);
        const sceneId = args.sceneId ? resolve(args.sceneId, aliases) : project.sequences[0]?.id;
        if (!project.sequences.some(item => item.id === sceneId)) throw new Error('Scene does not exist.');
        const properties = structuredClone(args.properties ?? {});
        if (properties.parentId) properties.parentId = resolve(properties.parentId, aliases);
        if (properties.assetId) properties.assetId = resolve(properties.assetId, aliases);
        project.elements.push(createElement(args.kind, { ...properties, id, sceneId }));
        break;
      }
      case 'element.remove': {
        const id = resolve(args.id, aliases); requiredElement(project, id);
        const descendants = descendantIds(project, [id]);
        if (!args.descendants && descendants.size > 1) throw new Error('Element has descendants; request descendants=true to remove the complete hierarchy.');
        project.elements = project.elements.filter(item => !descendants.has(item.id)); break;
      }
      case 'element.setTransform': {
        const targetId = resolve(args.id, aliases);
        if (args.space !== undefined && args.space !== 'local' && args.space !== 'world') throw new Error('Transform space must be local or world.');
        for (const [field, value] of Object.entries(args.transform as Record<string, unknown>)) {
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Transform ${field} must be a finite number.`);
        }
        if (args.space === 'world') setWorldTransform(project, targetId, args.transform, args.timeSeconds ?? requiredElement(project, targetId).start);
        else {
          if (args.timeSeconds !== undefined) throw new Error('timeSeconds is only meaningful for a world transform.');
          Object.assign(requiredElement(project, targetId), args.transform);
        }
        break;
      }
      case 'element.updateAppearance': Object.assign(requiredElement(project, resolve(args.id, aliases)), args.appearance); break;
      case 'shape.setPath': requiredElement(project, resolve(args.id, aliases)).shapePath = structuredClone(args.path); break;
      case 'shape.convertToPath': {
        const element = requiredElement(project, resolve(args.id, aliases)); Object.assign(element, withEditablePath(element)); break;
      }
      case 'shape.insertPoint': {
        const element = requiredElement(project, resolve(args.id, aliases)); element.shapePath = splitPathSegment(withEditablePath(element).shapePath!, args.index, args.fraction, args.contourIndex); break;
      }
      case 'shape.movePoint': {
        const element = requiredElement(project, resolve(args.id, aliases)); element.shapePath = movePathAnchor(withEditablePath(element).shapePath!, args.index, args.x, args.y, args.contourIndex); break;
      }
      case 'shape.setHandle': {
        const element = requiredElement(project, resolve(args.id, aliases)); element.shapePath = setPathHandle(withEditablePath(element).shapePath!, args.index, args.side, args.position, args.contourIndex); break;
      }
      case 'shape.removePoint': {
        const element = requiredElement(project, resolve(args.id, aliases)); element.shapePath = removePathPoint(withEditablePath(element).shapePath!, args.index, args.contourIndex); break;
      }
      case 'assembly.attach': {
        const id = resolve(args.id, aliases), parentId = resolve(args.parentId, aliases);
        if (args.preserveWorldPose) project = reparentElement(project, id, parentId, args.timeSeconds ?? 0);
        const element = requiredElement(project, id); requiredElement(project, parentId);
        element.parentId = parentId;
        element.attachment = { type: args.type, parentId, ...(args.min === undefined ? {} : { min: args.min }), ...(args.max === undefined ? {} : { max: args.max }) };
        break;
      }
      case 'assembly.detach': {
        const id = resolve(args.id, aliases);
        if (args.preserveWorldPose) project = reparentElement(project, id, undefined, args.timeSeconds ?? 0);
        const element = requiredElement(project, id); delete element.parentId; delete element.attachment; break;
      }
      case 'track.ensure': {
        const element = requiredElement(project, resolve(args.elementId, aliases));
        if (!element.tracks.some(track => track.property === args.property)) element.tracks.push({ property: args.property, keyframes: [] });
        break;
      }
      case 'keyframe.upsert': {
        const element = requiredElement(project, resolve(args.elementId, aliases));
        let track = element.tracks.find(item => item.property === args.property);
        if (!track) { track = { property: args.property, keyframes: [] }; element.tracks.push(track); }
        const id = namedId(args.id, args.alias, aliases);
        const key = track.keyframes.find(item => item.id === id);
        const value: Keyframe = { id, time: args.timeSeconds, value: args.value, easing: args.easing ?? 'linear', direction: args.direction ?? 'inOut', mode: args.mode ?? 'smooth', ...(args.steps === undefined ? {} : { steps: args.steps }) };
        if (key) Object.assign(key, value); else track.keyframes.push(value);
        track.keyframes.sort((a, b) => a.time - b.time); break;
      }
      case 'caption.create': {
        const id = namedId(args.id, args.alias, aliases);
        project.captions.push({ id, text: args.text, start: args.start, end: args.end, ...(args.sceneId ? { sceneId: resolve(args.sceneId, aliases) } : {}) }); break;
      }
      case 'asset.add': {
        const payload = this.staged.get(args.handle);
        if (!payload) throw new Error('Asset handle does not exist or has already been consumed.');
        if (usedHandles.has(args.handle)) throw new Error('Asset handle is already used in this batch.');
        if (args.duration !== undefined && (!(payload.kind === 'audio' || payload.kind === 'video') || !Number.isFinite(args.duration) || args.duration <= 0 || args.duration > 86_400)) throw new Error('duration must be positive source seconds (at most 24 hours) for an audio or video asset.');
        if (args.reuseExisting !== undefined && typeof args.reuseExisting !== 'boolean') throw new Error('reuseExisting must be a boolean.');
        if (args.reuseExisting && args.id !== undefined) throw new Error('reuseExisting cannot be combined with an explicit native asset ID.');
        const dataUrl = bytesDataUrl(payload.bytes, payload.mime);
        if (args.reuseExisting) {
          const existing = project.assets.find(asset => asset.kind === payload.kind && asset.mime === payload.mime &&
            asset.dataUrl === dataUrl && asset.licenseNotice === payload.licenseNotice && asset.duration === args.duration);
          if (existing) {
            namedId(existing.id, args.alias, aliases);
            usedHandles.add(args.handle);
            break;
          }
        }
        const id = namedId(args.id, args.alias, aliases);
        if (project.assets.some(asset => asset.id === id)) throw new Error(`Asset ${id} already exists.`);
        project.assets.push({ id, name: args.name, mime: payload.mime, kind: payload.kind, dataUrl,
          ...(args.duration === undefined ? {} : { duration: args.duration }),
          ...(payload.licenseNotice === undefined ? {} : { licenseNotice: payload.licenseNotice }) });
        usedHandles.add(args.handle); break;
      }
      default: throw new Error(`Unsupported operation ${(command as { op: string }).op}.`);
    }
    return project;
  }
}
