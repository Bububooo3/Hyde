import { alignSelection, type Alignment } from './alignment';
import { animationAssetIds } from './assemblyClips';
import { editCaption } from './captionEditing';
import { descendantIds, duplicateElements, insertAssemblyAt, moveSceneFolder, parentId, removeSceneFolder, reparentElement } from './editing';
import { evaluateProject } from './engine';
import { assignSceneOwnership, createElement, uid, type Assembly, type Asset, type Caption, type Project, type Sequence, type StoryElement } from './model';
import { materializeScenePlacements, validateSceneLinks } from './scenePlacement';
import { setPivotWithoutMovingArt } from './stageGeometry';

type Ref = string;
type PlacementPatch = Partial<Pick<Sequence, 'start' | 'duration' | 'sourceIn' | 'sourceOut' | 'muted' | 'mutedSourceClipIds' | 'frame' | 'frameFit' | 'frameRotation' | 'opacity'>> & { speed?: number };
type CaptionPatch = Partial<Pick<Caption, 'text' | 'start' | 'end' | 'sceneId'>>;

/** Commands not owned by the foundation, timeline, or media adapters. */
export type CatalogCommand = { clientCommandId?: string } & (
  | { op: 'scene.ripple'; args: { id: Ref; deltaSeconds: number } }
  | { op: 'scene.trimBoundary'; args: { id: Ref; edge: 'start' | 'end'; timeSeconds: number; ripple?: boolean } }
  | { op: 'scene.setPlacement'; args: { id: Ref; placement: PlacementPatch } }
  | { op: 'element.clone'; args: { id: Ref; alias?: string } }
  | { op: 'element.reorder'; args: { id: Ref; beforeId?: Ref } }
  | { op: 'element.setPivot'; args: { id: Ref; pivotX: number; pivotY: number; preserveArtwork?: boolean; timeSeconds?: number } }
  | { op: 'element.setVisibility'; args: { id: Ref; hidden: boolean } }
  | { op: 'element.setLock'; args: { id: Ref; locked: boolean } }
  | { op: 'element.align' | 'element.distribute'; args: { ids: Ref[]; mode: Alignment; timeSeconds: number } }
  | { op: 'folder.create'; args: { id?: string; alias?: string; name: string; parentId?: Ref } }
  | { op: 'folder.rename'; args: { id: Ref; name: string } }
  | { op: 'folder.move'; args: { id: Ref; parentId?: Ref } }
  | { op: 'folder.remove'; args: { id: Ref } }
  | { op: 'folder.assign'; args: { folderId: Ref | null; elementIds: Ref[] } }
  | { op: 'assembly.create'; args: { ids: Ref[]; id?: string; alias?: string; name?: string } }
  | { op: 'assembly.import'; args: { handle: string; timeSeconds: number; alias?: string } }
  | { op: 'assembly.setLimits'; args: { id: Ref; min?: number | null; max?: number | null } }
  | { op: 'assembly.reparent'; args: { id: Ref; parentId: Ref | null; timeSeconds: number } }
  | { op: 'caption.update'; args: { id: Ref; patch: CaptionPatch } }
  | { op: 'caption.delete'; args: { id: Ref } }
  | { op: 'asset.rename'; args: { id: Ref; name: string } }
  | { op: 'asset.replace'; args: { id: Ref; handle: string; name?: string } }
  | { op: 'asset.removeUnused'; args: { ids?: Ref[] } }
);

export const CATALOG_COMMAND_KEYS = {
  'scene.ripple': ['id', 'deltaSeconds'],
  'scene.trimBoundary': ['id', 'edge', 'timeSeconds', 'ripple'],
  'scene.setPlacement': ['id', 'placement'],
  'element.clone': ['id', 'alias'],
  'element.reorder': ['id', 'beforeId'],
  'element.setPivot': ['id', 'pivotX', 'pivotY', 'preserveArtwork', 'timeSeconds'],
  'element.setVisibility': ['id', 'hidden'],
  'element.setLock': ['id', 'locked'],
  'element.align': ['ids', 'mode', 'timeSeconds'],
  'element.distribute': ['ids', 'mode', 'timeSeconds'],
  'folder.create': ['id', 'alias', 'name', 'parentId'],
  'folder.rename': ['id', 'name'],
  'folder.move': ['id', 'parentId'],
  'folder.remove': ['id'],
  'folder.assign': ['folderId', 'elementIds'],
  'assembly.create': ['ids', 'id', 'alias', 'name'],
  'assembly.import': ['handle', 'timeSeconds', 'alias'],
  'assembly.setLimits': ['id', 'min', 'max'],
  'assembly.reparent': ['id', 'parentId', 'timeSeconds'],
  'caption.update': ['id', 'patch'],
  'caption.delete': ['id'],
  'asset.rename': ['id', 'name'],
  'asset.replace': ['id', 'handle', 'name'],
  'asset.removeUnused': ['ids'],
} as const;
export const CATALOG_OPERATIONS = Object.keys(CATALOG_COMMAND_KEYS) as Array<keyof typeof CATALOG_COMMAND_KEYS>;

export interface CatalogContext {
  resolve(ref: Ref): string;
  register(alias: string | undefined, id: string): void;
  /** The session validates MIME and bytes during staging. Consuming occurs only after commit. */
  stagedAsset?(handle: string): Pick<Asset, 'dataUrl' | 'mime' | 'kind' | 'licenseNotice' | 'duration'> | undefined;
  useHandle?(handle: string): void;
  stagedAssembly?(handle: string): Assembly | undefined;
  useAssemblyHandle?(handle: string): void;
}

export class CatalogError extends Error {
  constructor(public readonly code: 'INVALID_ARGUMENT' | 'TARGET_NOT_FOUND' | 'INVALID_REFERENCE' | 'INVALID_TIMING' | 'INVALID_ATTACHMENT' | 'INVALID_ASSET' | 'ASSET_MISSING' | 'CAPABILITY_UNAVAILABLE' | 'DUPLICATE_ID', message: string, public readonly field?: string) {
    super(message);
    this.name = 'CatalogError';
  }
}
function fail(message: string, code: CatalogError['code'] = 'INVALID_ARGUMENT', field?: string): never { throw new CatalogError(code, message, field); }
function record(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${label} does not support ${key}.`);
}
function finite(value: unknown, label: string, min = -Infinity, max = Infinity): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be a finite number between ${min} and ${max}.`);
}
function name(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) fail(`${label} must be a nonempty string of at most 1024 characters.`);
}
function bool(value: unknown, label: string): asserts value is boolean { if (typeof value !== 'boolean') fail(`${label} must be a boolean.`); }
function ref(value: unknown, context: CatalogContext): string {
  if (typeof value !== 'string' || !value) fail('A nonempty object ID is required.');
  return context.resolve(value);
}
function uniqueId(requested: unknown, context: CatalogContext, project: Project, alias?: string): string {
  const id = requested === undefined ? uid() : requested;
  if (typeof id !== 'string' || !id || id.startsWith('$')) fail('Native IDs must be nonempty and cannot begin with $.');
  if (project.elements.some(item => item.id === id) || project.folders?.some(item => item.id === id) || project.sequences.some(item => item.id === id) || project.assets.some(item => item.id === id) || project.captions.some(item => item.id === id)) fail(`ID ${id} already exists.`, 'DUPLICATE_ID');
  context.register(alias, id);
  return id;
}
function refs(value: unknown, context: CatalogContext, label: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000) fail(`${label} must contain between 1 and 1000 IDs.`);
  const result = value.map(item => ref(item, context));
  if (new Set(result).size !== result.length) fail(`${label} cannot contain duplicate IDs.`);
  return result;
}
function element(project: Project, value: unknown, context: CatalogContext): StoryElement {
  const id = ref(value, context), item = project.elements.find(candidate => candidate.id === id);
  if (!item) fail(`Element ${id} does not exist.`, 'TARGET_NOT_FOUND');
  return item;
}
function scene(project: Project, value: unknown, context: CatalogContext): Sequence {
  const id = ref(value, context), item = project.sequences.find(candidate => candidate.id === id);
  if (!item) fail(`Scene ${id} does not exist.`, 'TARGET_NOT_FOUND');
  return item;
}
function folder(project: Project, value: unknown, context: CatalogContext) {
  const id = ref(value, context), item = project.folders?.find(candidate => candidate.id === id);
  if (!item) fail(`Folder ${id} does not exist.`, 'TARGET_NOT_FOUND');
  return item;
}
function asset(project: Project, value: unknown, context: CatalogContext): Asset {
  const id = ref(value, context), item = project.assets.find(candidate => candidate.id === id);
  if (!item) fail(`Asset ${id} does not exist.`, 'TARGET_NOT_FOUND');
  return item;
}
function caption(project: Project, value: unknown, context: CatalogContext): Caption {
  const id = ref(value, context), item = project.captions.find(candidate => candidate.id === id);
  if (!item) fail(`Caption ${id} does not exist.`, 'TARGET_NOT_FOUND');
  return item;
}
function timelineEnd(project: Project): number {
  return Math.max(1 / project.fps, ...project.sequences.map(item => item.start + item.duration), ...project.elements.map(item => item.start + item.duration), ...project.captions.map(item => item.end));
}
function trimScene(project: Project, sceneId: string, edge: 'start' | 'end', timeSeconds: number, ripple: boolean): Project {
  const normalized = assignSceneOwnership(project);
  const current = normalized.sequences.find(item => item.id === sceneId)!;
  finite(timeSeconds, 'Scene boundary', 0);
  if (ripple && edge === 'start') fail('Ripple is supported for the end boundary only; moving the start boundary only changes visibility.');
  const oldEnd = current.start + current.duration;
  const next = structuredClone(normalized), target = next.sequences.find(item => item.id === sceneId)!;
  const duration = edge === 'start' ? oldEnd - timeSeconds : timeSeconds - target.start;
  if (duration < 1 / normalized.fps - 1e-8) fail('A scene must last at least one project frame.', 'INVALID_TIMING');
  if (edge === 'start') target.start = timeSeconds;
  target.duration = duration;
  if (ripple) {
    const delta = timeSeconds - oldEnd;
    const shifted = new Set(normalized.sequences.filter(item => item.id !== sceneId && item.start >= oldEnd - 1e-8).map(item => item.id));
    const globalRoots = normalized.elements.filter(item => !item.sceneId && !parentId(item) && item.start >= oldEnd - 1e-8).map(item => item.id);
    const shiftedGlobals = descendantIds(normalized, globalRoots);
    for (const sequence of next.sequences) if (shifted.has(sequence.id)) sequence.start += delta;
    for (const item of next.elements) if (item.sceneId && shifted.has(item.sceneId) || shiftedGlobals.has(item.id)) item.start += delta;
    for (const item of next.captions) if (item.sceneId && shifted.has(item.sceneId) || !item.sceneId && item.start >= oldEnd - 1e-8) { item.start += delta; item.end += delta; }
    if (next.sequences.some(item => item.start < -1e-8) || next.elements.some(item => item.start < -1e-8) || next.captions.some(item => item.start < -1e-8)) fail('Ripple would move content before the project start.', 'INVALID_TIMING');
    next.duration = Math.max(timelineEnd(next), normalized.duration + delta);
  } else next.duration = Math.max(normalized.duration, timelineEnd(next));
  next.sequences.sort((a, b) => a.start - b.start);
  return next;
}
function placement(project: Project, sequence: Sequence, patch: PlacementPatch): Project {
  record(patch, ['start', 'duration', 'speed', 'sourceIn', 'sourceOut', 'muted', 'mutedSourceClipIds', 'frame', 'frameFit', 'frameRotation', 'opacity'], 'Placement');
  if (!sequence.sourceSceneId) fail('Scene placement controls require a linked scene.');
  if (patch.start !== undefined) finite(patch.start, 'Placement start', 0);
  if (patch.duration !== undefined) finite(patch.duration, 'Placement duration', 1 / project.fps);
  if (patch.speed !== undefined) {
    finite(patch.speed, 'Placement speed', .01, 100);
    if (patch.duration !== undefined) fail('Specify placement speed or duration, not both.');
  }
  if (patch.sourceIn !== undefined) finite(patch.sourceIn, 'Source in', 0);
  if (patch.sourceOut !== undefined) finite(patch.sourceOut, 'Source out', 0);
  if (patch.frameRotation !== undefined) finite(patch.frameRotation, 'Frame rotation');
  if (patch.opacity !== undefined) finite(patch.opacity, 'Placement opacity', 0, 1);
  if (patch.muted !== undefined) bool(patch.muted, 'Placement mute');
  if (patch.frameFit !== undefined && !['fit', 'fill', 'stretch'].includes(patch.frameFit)) fail('Frame fit must be fit, fill or stretch.');
  if (patch.frame !== undefined) {
    record(patch.frame, ['x', 'y', 'width', 'height'], 'Placement frame');
    finite(patch.frame.x, 'Frame x'); finite(patch.frame.y, 'Frame y');
    finite(patch.frame.width, 'Frame width', Number.EPSILON); finite(patch.frame.height, 'Frame height', Number.EPSILON);
  }
  if (patch.mutedSourceClipIds !== undefined) {
    if (!Array.isArray(patch.mutedSourceClipIds) || patch.mutedSourceClipIds.some(id => typeof id !== 'string' || !id)) fail('Muted source clip IDs must be nonempty strings.');
    const sourceId = sequence.sourceSceneId;
    const available = new Set(materializeScenePlacements(project).elements.filter(item => item.sceneId === sourceId).map(item => item.id));
    if (patch.mutedSourceClipIds.some(id => !available.has(id))) fail('A muted source clip does not belong to the source scene.', 'INVALID_REFERENCE');
  }
  const next = structuredClone(project), target = next.sequences.find(item => item.id === sequence.id)!;
  const delta = (patch.start ?? target.start) - target.start;
  const { speed, ...nativePatch } = patch;
  Object.assign(target, structuredClone(nativePatch));
  const source = next.sequences.find(item => item.id === target.sourceSceneId)!;
  const sourceIn = target.sourceIn ?? 0, sourceOut = target.sourceOut ?? source.duration;
  if (!(sourceOut > sourceIn && sourceOut <= source.duration)) fail('The linked scene source range is invalid.', 'INVALID_TIMING');
  if (speed !== undefined) {
    target.duration = (sourceOut - sourceIn) / speed;
    if (target.duration < 1 / project.fps - 1e-8) fail('Placement speed makes the scene shorter than one project frame.', 'INVALID_TIMING');
  }
  if (delta) {
    for (const item of next.elements) if (item.sceneId === target.id) item.start += delta;
    for (const item of next.captions) if (item.sceneId === target.id) { item.start += delta; item.end += delta; }
  }
  validateSceneLinks(next);
  next.duration = Math.max(project.duration, timelineEnd(next));
  next.sequences.sort((a, b) => a.start - b.start);
  return next;
}

/** Pure adapter. The caller validates the complete candidate before committing it. */
export function applyCatalogCommand(project: Project, command: CatalogCommand, context: CatalogContext): Project {
  if (!Object.hasOwn(CATALOG_COMMAND_KEYS, command.op)) fail(`Unsupported catalog command ${command.op}.`);
  record(command.args, CATALOG_COMMAND_KEYS[command.op], `${command.op} arguments`);
  const next = structuredClone(project);
  // JSON callers are checked against the operation key whitelist above, then
  // each branch validates its fields before touching the cloned project.
  const args = command.args as any;
  switch (command.op) {
    case 'scene.ripple': {
      const target = scene(next, args.id, context);
      finite(args.deltaSeconds, 'Ripple delta');
      return trimScene(next, target.id, 'end', target.start + target.duration + args.deltaSeconds, true);
    }
    case 'scene.trimBoundary': {
      const target = scene(next, args.id, context);
      if (args.edge !== 'start' && args.edge !== 'end') fail('Boundary edge must be start or end.');
      if (args.ripple !== undefined) bool(args.ripple, 'Ripple');
      return trimScene(next, target.id, args.edge, args.timeSeconds, args.ripple ?? false);
    }
    case 'scene.setPlacement': return placement(next, scene(next, args.id, context), args.placement);
    case 'element.clone': {
      const original = element(next, args.id, context);
      const copied = descendantIds(next, [original.id]);
      const oldIds = next.elements.filter(item => copied.has(item.id)).map(item => item.id);
      const result = duplicateElements(next, [original.id]);
      const index = oldIds.indexOf(original.id);
      const copyId = result.ids[index];
      if (!copyId) fail('The element could not be cloned.');
      context.register(args.alias, copyId);
      return result.project;
    }
    case 'element.reorder': {
      const target = element(next, args.id, context);
      const before = args.beforeId === undefined ? undefined : element(next, args.beforeId, context);
      if (before && before.sceneId !== target.sceneId) fail('Drawing order can only change within one scene.');
      if (before?.id === target.id) return next;
      next.elements = next.elements.filter(item => item.id !== target.id);
      const index = before ? next.elements.findIndex(item => item.id === before.id) : next.elements.length;
      next.elements.splice(index, 0, target);
      return next;
    }
    case 'element.setPivot': {
      const target = element(next, args.id, context);
      finite(args.pivotX, 'Pivot X', 0, 1); finite(args.pivotY, 'Pivot Y', 0, 1);
      if (args.preserveArtwork !== undefined) bool(args.preserveArtwork, 'Preserve artwork');
      if (args.preserveArtwork === false) { target.pivotX = args.pivotX; target.pivotY = args.pivotY; return next; }
      if (parentId(target)) fail('Detach a part before preserving its artwork while moving its pivot.', 'INVALID_ATTACHMENT');
      const time = args.timeSeconds ?? target.start;
      finite(time, 'Pivot sample time', 0);
      const pose = evaluateProject(next, time).find(item => item.id === target.id) ?? target;
      setPivotWithoutMovingArt(target, args.pivotX, args.pivotY, pose);
      return next;
    }
    case 'element.setVisibility': element(next, args.id, context).hidden = (bool(args.hidden, 'Hidden'), args.hidden); return next;
    case 'element.setLock': element(next, args.id, context).locked = (bool(args.locked, 'Locked'), args.locked); return next;
    case 'element.align':
    case 'element.distribute': {
      const ids = refs(args.ids, context, 'Selection');
      for (const id of ids) element(next, id, context);
      finite(args.timeSeconds, 'Alignment time', 0);
      if (!['left', 'centerX', 'right', 'top', 'centerY', 'bottom', 'distributeX', 'distributeY'].includes(args.mode)) fail('Unknown alignment mode.');
      if (command.op === 'element.distribute' && !args.mode.startsWith('distribute') || command.op === 'element.align' && args.mode.startsWith('distribute')) fail('Choose a mode belonging to this operation.');
      return alignSelection(next, ids, args.timeSeconds, args.mode);
    }
    case 'folder.create': {
      name(args.name, 'Folder name');
      const id = uniqueId(args.id, context, next, args.alias);
      const parent = args.parentId === undefined ? undefined : folder(next, args.parentId, context).id;
      next.folders ??= [];
      next.folders.push({ id, name: args.name, ...(parent ? { parentId: parent } : {}) });
      return next;
    }
    case 'folder.rename': name(args.name, 'Folder name'); folder(next, args.id, context).name = args.name; return next;
    case 'folder.move': return moveSceneFolder(next, folder(next, args.id, context).id, args.parentId === undefined ? undefined : folder(next, args.parentId, context).id);
    case 'folder.remove': return removeSceneFolder(next, folder(next, args.id, context).id);
    case 'folder.assign': {
      const ids = refs(args.elementIds, context, 'Folder elements');
      const folderId = args.folderId === null ? undefined : folder(next, args.folderId, context).id;
      for (const id of ids) { const target = element(next, id, context); target.folderId = folderId; }
      return next;
    }
    case 'assembly.create': {
      const ids = refs(args.ids, context, 'Assembly parts');
      const normalized = assignSceneOwnership(next);
      const children = ids.map(id => element(normalized, id, context));
      if (children.some(child => parentId(child))) fail('Select top-level parts to form an assembly.', 'INVALID_ATTACHMENT');
      if (new Set(children.map(child => child.sceneId)).size > 1) fail('Assembly parts must belong to one scene.', 'INVALID_ATTACHMENT');
      const id = uniqueId(args.id, context, normalized, args.alias);
      if (args.name !== undefined) name(args.name, 'Assembly name');
      const start = Math.min(...children.map(child => child.start));
      const end = Math.max(...children.map(child => child.start + child.duration));
      const root = createElement('group', { id, name: args.name ?? 'New assembly', x: 0, y: 0, width: 0, height: 0, pivotX: 0, pivotY: 0, start, duration: Math.max(1 / normalized.fps, end - start), sceneId: children[0].sceneId });
      if (children.every(child => child.folderId === children[0].folderId)) root.folderId = children[0].folderId;
      for (const child of children) { child.parentId = id; delete child.folderId; }
      normalized.elements.push(root);
      return normalized;
    }
    case 'assembly.import': {
      name(args.handle, 'Assembly handle');
      finite(args.timeSeconds, 'Assembly start time', 0);
      if (!context.stagedAssembly || !context.useAssemblyHandle) fail('Assembly import requires a staging session.', 'CAPABILITY_UNAVAILABLE');
      const source = context.stagedAssembly(args.handle);
      if (!source) fail('Assembly handle does not exist or has already been consumed.', 'ASSET_MISSING');
      const existing = new Set(next.elements.map(item => item.id));
      const imported = assignSceneOwnership(insertAssemblyAt(next, source, args.timeSeconds));
      const inserted = imported.elements.filter(item => !existing.has(item.id));
      const insertedIds = new Set(inserted.map(item => item.id));
      const root = inserted.find(item => !insertedIds.has(parentId(item) ?? ''));
      if (!root) fail('Imported assembly has no root.', 'INVALID_ATTACHMENT');
      context.register(args.alias, root.id);
      context.useAssemblyHandle(args.handle);
      return imported;
    }
    case 'assembly.setLimits': {
      const target = element(next, args.id, context);
      if (!target.attachment) fail('This part has no attachment.', 'INVALID_ATTACHMENT');
      for (const field of ['min', 'max'] as const) {
        const value = args[field];
        if (value === null) delete target.attachment[field];
        else if (value !== undefined) { finite(value, `Attachment ${field}`); target.attachment[field] = value; }
      }
      if (target.attachment.min !== undefined && target.attachment.max !== undefined && target.attachment.min > target.attachment.max) fail('Attachment minimum exceeds maximum.', 'INVALID_ATTACHMENT');
      return next;
    }
    case 'assembly.reparent': {
      const target = element(next, args.id, context);
      const parent = args.parentId === null ? undefined : element(next, args.parentId, context).id;
      finite(args.timeSeconds, 'Reparent sample time', 0);
      return reparentElement(next, target.id, parent, args.timeSeconds);
    }
    case 'caption.update': {
      const target = caption(next, args.id, context);
      record(args.patch, ['text', 'start', 'end', 'sceneId'], 'Caption patch');
      if (args.patch.text !== undefined) name(args.patch.text, 'Caption text');
      if (args.patch.start !== undefined) finite(args.patch.start, 'Caption start', 0);
      if (args.patch.end !== undefined) finite(args.patch.end, 'Caption end', 0);
      const patch = { ...args.patch, ...(args.patch.sceneId === undefined ? {} : { sceneId: scene(next, args.patch.sceneId, context).id }) };
      return editCaption(next, target.id, patch);
    }
    case 'caption.delete': {
      const target = caption(next, args.id, context);
      next.captions = next.captions.filter(item => item.id !== target.id);
      return next;
    }
    case 'asset.rename': name(args.name, 'Asset name'); asset(next, args.id, context).name = args.name; return next;
    case 'asset.replace': {
      const target = asset(next, args.id, context);
      name(args.handle, 'Asset handle');
      if (args.name !== undefined) name(args.name, 'Asset name');
      if (!context.stagedAsset || !context.useHandle) fail('Asset replacement requires a staging session.', 'CAPABILITY_UNAVAILABLE');
      const staged = context.stagedAsset(args.handle);
      if (!staged) fail('Asset handle does not exist or has already been consumed.', 'ASSET_MISSING');
      if (staged.kind !== target.kind) fail('Replacement must have the same asset kind to preserve native references.', 'INVALID_ASSET');
      target.dataUrl = staged.dataUrl; target.mime = staged.mime; target.duration = staged.duration;
      target.licenseNotice = staged.licenseNotice;
      if (args.name !== undefined) target.name = args.name;
      context.useHandle(args.handle);
      return next;
    }
    case 'asset.removeUnused': {
      const used = new Set(next.elements.flatMap(item => [item.assetId, ...animationAssetIds(item)].filter((id): id is string => !!id)));
      if (next.elements.some(item => item.kind === 'text')) for (const item of next.assets) if (item.kind === 'font') used.add(item.id);
      const selected = args.ids === undefined ? next.assets.filter(item => !used.has(item.id)).map(item => item.id) : refs(args.ids, context, 'Assets to remove');
      for (const id of selected) {
        asset(next, id, context);
        if (used.has(id)) fail(`Asset ${id} is still referenced.`, 'INVALID_REFERENCE', 'ids');
      }
      const remove = new Set(selected);
      next.assets = next.assets.filter(item => !remove.has(item.id));
      return next;
    }
  }
}
