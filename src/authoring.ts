import { decodeAssemblyBytes, decodeProjectBytes, encodeAssemblyBytes, encodeProjectBytes, validateDocument } from './archive';
import { evaluateProject } from './engine';
import { createElement, createProject, uid } from './model';
import type { AnimProperty, Assembly, Asset, Attachment, ElementKind, Keyframe, Project, ShapePath, StoryElement } from './model';
import { descendantIds, makeAssembly, reparentElement } from './editing';
import { duplicateScene, deleteScene, moveScene, retimeScene } from './sceneOperations';
import { makeSceneIndependent, placeLinkedScene } from './scenePlacement';
import { movePathAnchor, removePathPoint, setPathHandle, splitPathSegment, withEditablePath } from './shapePath';
import { applyMediaAuthoringCommand, MEDIA_AUTHORING_COMMAND_KEYS, MEDIA_AUTHORING_OPERATIONS, MediaAuthoringError } from './authoringMedia';
import type { MediaAuthoringCommand } from './authoringMedia';
import { applyTimelineCommand, timelineCommandKeys, timelineOperations } from './authoringTimeline';
import type { TimelineCommand } from './authoringTimeline';
import { applyCatalogCommand, CATALOG_COMMAND_KEYS, CATALOG_OPERATIONS, CatalogError } from './authoringCatalog';
import type { CatalogCommand } from './authoringCatalog';

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
  | { op: 'element.setTransform'; args: { id: Ref; transform: Transform }; clientCommandId?: string }
  | { op: 'element.updateAppearance'; args: { id: Ref; appearance: Appearance }; clientCommandId?: string }
  | { op: 'shape.setPath'; args: { id: Ref; path: ShapePath }; clientCommandId?: string }
  | { op: 'shape.convertToPath'; args: { id: Ref }; clientCommandId?: string }
  | { op: 'shape.insertPoint'; args: { id: Ref; index: number; fraction?: number }; clientCommandId?: string }
  | { op: 'shape.movePoint'; args: { id: Ref; index: number; x: number; y: number }; clientCommandId?: string }
  | { op: 'shape.setHandle'; args: { id: Ref; index: number; side: 'in' | 'out'; position?: { x: number; y: number } }; clientCommandId?: string }
  | { op: 'shape.removePoint'; args: { id: Ref; index: number }; clientCommandId?: string }
  | { op: 'assembly.attach'; args: { id: Ref; parentId: Ref; type: Attachment['type']; min?: number; max?: number; preserveWorldPose?: boolean; timeSeconds?: number }; clientCommandId?: string }
  | { op: 'assembly.detach'; args: { id: Ref; preserveWorldPose?: boolean; timeSeconds?: number }; clientCommandId?: string }
  | { op: 'track.ensure'; args: { elementId: Ref; property: AnimProperty }; clientCommandId?: string }
  | { op: 'keyframe.upsert'; args: { elementId: Ref; property: AnimProperty; timeSeconds: number; value: number | string; id?: string; alias?: string; easing?: Keyframe['easing']; direction?: Keyframe['direction']; mode?: Keyframe['mode']; steps?: number }; clientCommandId?: string }
  | { op: 'caption.create'; args: { id?: string; alias?: string; sceneId?: Ref; text: string; start: number; end: number }; clientCommandId?: string }
  | { op: 'asset.add'; args: { id?: string; alias?: string; handle: string; name: string }; clientCommandId?: string };

export type HydeCommand = CoreHydeCommand | (TimelineCommand & { clientCommandId?: string }) | MediaAuthoringCommand | CatalogCommand;

export interface ExecuteRequest { protocolVersion: 1; expectedRevision: number; commands: HydeCommand[]; dryRun?: boolean; correlationId?: string }
export interface ChangeSummary { added: string[]; changed: string[]; removed: string[] }
export interface InspectRequest {
  target: 'project' | 'scenes' | 'scene' | 'elements' | 'element' | 'assets' | 'asset' | 'changes' | 'tree' | 'timeline' | 'assembly';
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
  'element.setTransform': ['id', 'transform'],
  'element.updateAppearance': ['id', 'appearance'],
  'shape.setPath': ['id', 'path'],
  'shape.convertToPath': ['id'],
  'shape.insertPoint': ['id', 'index', 'fraction'],
  'shape.movePoint': ['id', 'index', 'x', 'y'],
  'shape.setHandle': ['id', 'index', 'side', 'position'],
  'shape.removePoint': ['id', 'index'],
  'assembly.attach': ['id', 'parentId', 'type', 'min', 'max', 'preserveWorldPose', 'timeSeconds'],
  'assembly.detach': ['id', 'preserveWorldPose', 'timeSeconds'],
  'track.ensure': ['elementId', 'property'],
  'keyframe.upsert': ['elementId', 'property', 'timeSeconds', 'value', 'id', 'alias', 'easing', 'direction', 'mode', 'steps'],
  'caption.create': ['id', 'alias', 'sceneId', 'text', 'start', 'end'],
  'asset.add': ['id', 'alias', 'handle', 'name'],
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
function bytesDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}
function sniffAsset(bytes: Uint8Array): string | undefined {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 8 && bytes.subarray(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 3) === 'ID3' || bytes.length >= 2 && bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (ascii(4, 8) === 'ftyp') return 'video/mp4';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  if (ascii(0, 4) === 'wOFF') return 'font/woff';
  if (ascii(0, 4) === 'wOF2') return 'font/woff2';
  if (ascii(0, 4) === 'OTTO') return 'font/otf';
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) return 'font/ttf';
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096))).trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(prefix)) return 'image/svg+xml';
  return undefined;
}
function validateStagedAsset(bytes: Uint8Array, mime: string, kind: Asset['kind']): void {
  const detected = sniffAsset(bytes);
  const expectedKind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('font/') ? 'font' : undefined;
  if (!detected || detected !== mime || expectedKind !== kind) throw new Error(`Asset MIME/kind mismatch: declared ${kind} ${mime}, detected ${detected ?? 'unknown'}.`);
  if (mime === 'image/svg+xml') {
    const xml = new TextDecoder().decode(bytes);
    if (/<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|\b(?:href|src)\s*=\s*['"](?:https?:|data:|\/\/)|url\s*\(\s*['"]?(?:https?:|data:|\/\/)|@import/i.test(xml)) throw new Error('SVG contains scripts, external resources or unsupported declarations.');
  }
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
    const limit = Math.min(100, Math.max(1, query.limit ?? 25));
    const cursor = Math.max(0, Math.floor(query.cursor ?? 0));
    if (!Number.isFinite(limit) || !Number.isFinite(cursor)) throw new Error('Inspection limit and cursor must be finite.');
    if (query.target === 'project') return { revision: this.revision, project: projectFields({ id: this.project.id, name: this.project.name, width: this.project.width, height: this.project.height, fps: this.project.fps, duration: this.project.duration, sceneCount: this.project.sequences.length, elementCount: this.project.elements.length, assetCount: this.project.assets.length, captionCount: this.project.captions.length, folderCount: this.project.folders?.length ?? 0 }, query.fields), warnings: [] as HydeDiagnostic[] };
    if (query.target === 'changes') {
      const from = query.sinceRevision ?? this.revision;
      if (from < 0 || from > this.revision || [...Array(this.revision - from)].some((_, i) => !this.changes.has(from + i + 1))) return { revision: this.revision, error: diagnostic('DIFF_UNAVAILABLE', 'Revision changes are no longer available; inspect the current project.') };
      return { revision: this.revision, changes: [...this.changes.entries()].filter(([revision]) => revision > from).map(([revision, changes]) => ({ revision, changes })) };
    }
    if (query.target === 'element') return { revision: this.revision, element: projectFields(structuredClone(requiredElement(this.project, query.id ?? '')) as unknown as Record<string, unknown>, query.fields) };
    if (query.target === 'asset') {
      const asset = this.project.assets.find(item => item.id === query.id);
      if (!asset) return { revision: this.revision, error: diagnostic('TARGET_NOT_FOUND', 'Asset does not exist.') };
      const { dataUrl: _data, ...metadata } = asset;
      return { revision: this.revision, asset: projectFields(structuredClone(metadata), query.fields) };
    }
    if (query.target === 'scene') {
      const scene = this.project.sequences.find(item => item.id === query.id);
      if (!scene) return { revision: this.revision, error: diagnostic('TARGET_NOT_FOUND', 'Scene does not exist.') };
      return { revision: this.revision, scene: structuredClone(scene), elements: this.project.elements.filter(item => item.sceneId === scene.id).slice(cursor, cursor + limit).map(item => structuredClone(item)), nextCursor: cursor + limit < this.project.elements.filter(item => item.sceneId === scene.id).length ? cursor + limit : undefined };
    }
    if (query.target === 'tree' || query.target === 'assembly') {
      const roots = query.target === 'assembly' ? [requiredElement(this.project, query.id ?? '')] : this.project.elements.filter(item => (query.sceneId === undefined || item.sceneId === query.sceneId) && !item.parentId);
      const maxDepth = Math.min(8, Math.max(0, Math.floor(query.depth ?? 3)));
      const visit = (item: StoryElement, depth: number): Record<string, unknown> => ({ id: item.id, name: item.name, kind: item.kind, sceneId: item.sceneId, parentId: item.parentId, attachment: item.attachment, childCount: this.project.elements.filter(child => child.parentId === item.id).length, ...(depth < maxDepth ? { children: this.project.elements.filter(child => child.parentId === item.id).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 100).map(child => visit(child, depth + 1)) } : {}) });
      const ordered = [...roots].sort((a, b) => a.id.localeCompare(b.id));
      return { revision: this.revision, items: ordered.slice(cursor, cursor + limit).map(root => visit(root, 0)), nextCursor: cursor + limit < ordered.length ? cursor + limit : undefined };
    }
    if (query.target === 'timeline') {
      const start = query.timeStart ?? 0, end = query.timeEnd ?? this.project.duration;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('Timeline range is invalid.');
      const items = this.project.elements.filter(item => (query.sceneId === undefined || item.sceneId === query.sceneId) && item.start < end && item.start + item.duration >= start).sort((a, b) => a.id.localeCompare(b.id));
      return { revision: this.revision, range: { start, end }, items: items.slice(cursor, cursor + limit).map(item => ({ id: item.id, name: item.name, kind: item.kind, sceneId: item.sceneId, start: item.start, duration: item.duration, tracks: item.tracks.map(track => ({ property: track.property, keyframes: track.keyframes.filter(key => key.time >= start - item.start && key.time <= end - item.start).slice(0, 100) })), motionBehaviors: item.motionBehaviors?.map(behavior => ({ id: behavior.id, type: behavior.type })), assemblyClips: item.assemblyClips?.map(clip => ({ id: clip.id, name: clip.name, duration: clip.duration })), clipInstances: item.clipInstances?.map(instance => ({ id: instance.id, clipId: instance.clipId, start: instance.start, duration: instance.duration })) })), captions: this.project.captions.filter(caption => (query.sceneId === undefined || caption.sceneId === query.sceneId) && caption.start < end && caption.end >= start).slice(0, 100).map(caption => ({ id: caption.id, text: caption.text, start: caption.start, end: caption.end })), nextCursor: cursor + limit < items.length ? cursor + limit : undefined };
    }
    const list = query.target === 'scenes' ? this.project.sequences : query.target === 'assets'
      ? this.project.assets.map(({ dataUrl: _bytes, ...metadata }) => metadata)
      : this.project.elements.filter(item => query.sceneId === undefined || item.sceneId === query.sceneId).map(({ tracks, assemblyClips, clipInstances, motionBehaviors, shapePath, ...summary }) => ({ ...summary, trackCount: tracks.length, clipCount: assemblyClips?.length ?? 0, instanceCount: clipInstances?.length ?? 0, motionCount: motionBehaviors?.length ?? 0, pathPointCount: shapePath?.points.length ?? 0 }));
    const ordered = [...list].sort((a, b) => a.id.localeCompare(b.id));
    return { revision: this.revision, items: structuredClone(ordered.slice(cursor, cursor + limit)).map(item => projectFields(item as Record<string, unknown>, query.fields)), nextCursor: cursor + limit < ordered.length ? cursor + limit : undefined };
  }
  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    if (request.protocolVersion !== 1) return { ok: false, revision: this.revision, errors: [diagnostic('SCHEMA_UNSUPPORTED', 'Command protocol version is unsupported.')], warnings: [] };
    if (request.correlationId !== undefined && (typeof request.correlationId !== 'string' || request.correlationId.length < 1 || request.correlationId.length > 128)) return { ok: false, revision: this.revision, errors: [diagnostic('INVALID_ARGUMENT', 'correlationId must contain 1 to 128 characters.')], warnings: [] };
    let signature = '';
    if (request.correlationId) {
      try { signature = JSON.stringify({ commands: request.commands, dryRun: request.dryRun }); }
      catch { return { ok: false, revision: this.revision, errors: [diagnostic('INVALID_ARGUMENT', 'Commands must be JSON-compatible data.')], warnings: [] }; }
    }
    const replayed = request.correlationId ? this.replay.get(request.correlationId) : undefined;
    if (replayed) return replayed.signature === signature ? structuredClone(replayed.result) : { ok: false, revision: this.revision, errors: [diagnostic('INVALID_ARGUMENT', 'correlationId was reused for a different batch.')], warnings: [] };
    if (request.expectedRevision !== this.revision) {
      const changes = [...this.changes.entries()].filter(([revision]) => revision > request.expectedRevision).slice(0, 25).map(([revision, change]) => ({ revision, ...change }));
      return { ok: false, revision: this.revision, errors: [{ ...diagnostic('REVISION_CONFLICT', `Expected revision ${request.expectedRevision}; current revision is ${this.revision}.`), details: { changes, truncated: this.revision - request.expectedRevision > changes.length }, suggestions: ['Inspect changed IDs, then retry with the current revision.'] }], warnings: [] };
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
        const code = failureCode(error);
        return { ok: false, revision: this.revision, errors: [diagnostic(code, error instanceof Error ? error.message : 'Command failed.', index)], warnings: [] };
      }
    }
    candidate.updatedAt = new Date().toISOString();
    try { validateDocument(candidate, false); }
    catch (error) { return { ok: false, revision: this.revision, errors: [diagnostic(failureCode(error) === 'INVALID_ARGUMENT' ? 'INVALID_REFERENCE' : failureCode(error), error instanceof Error ? error.message : 'Project validation failed.')], warnings: [] }; }
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
      case 'element.setTransform': Object.assign(requiredElement(project, resolve(args.id, aliases)), args.transform); break;
      case 'element.updateAppearance': Object.assign(requiredElement(project, resolve(args.id, aliases)), args.appearance); break;
      case 'shape.setPath': requiredElement(project, resolve(args.id, aliases)).shapePath = structuredClone(args.path); break;
      case 'shape.convertToPath': {
        const element = requiredElement(project, resolve(args.id, aliases)); Object.assign(element, withEditablePath(element)); break;
      }
      case 'shape.insertPoint': {
        const element = requiredElement(project, resolve(args.id, aliases)); element.shapePath = splitPathSegment(withEditablePath(element).shapePath!, args.index, args.fraction); break;
      }
      case 'shape.movePoint': {
        const element = requiredElement(project, resolve(args.id, aliases)); element.shapePath = movePathAnchor(withEditablePath(element).shapePath!, args.index, args.x, args.y); break;
      }
      case 'shape.setHandle': {
        const element = requiredElement(project, resolve(args.id, aliases)); element.shapePath = setPathHandle(withEditablePath(element).shapePath!, args.index, args.side, args.position); break;
      }
      case 'shape.removePoint': {
        const element = requiredElement(project, resolve(args.id, aliases)); element.shapePath = removePathPoint(withEditablePath(element).shapePath!, args.index); break;
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
        const id = namedId(args.id, args.alias, aliases);
        if (project.assets.some(asset => asset.id === id)) throw new Error(`Asset ${id} already exists.`);
        project.assets.push({ id, name: args.name, mime: payload.mime, kind: payload.kind, dataUrl: bytesDataUrl(payload.bytes, payload.mime), ...(payload.licenseNotice === undefined ? {} : { licenseNotice: payload.licenseNotice }) });
        usedHandles.add(args.handle); break;
      }
      default: throw new Error(`Unsupported operation ${(command as { op: string }).op}.`);
    }
    return project;
  }
}
