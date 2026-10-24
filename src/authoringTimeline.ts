import { addAssemblyClipKey, assemblyTrackView, editAssemblyClipKey, removeAssemblyClipKey, resetAssemblyClipTrackOverride } from './assemblyClipEditing';
import type { AssemblyTrackTarget, AssemblyKeyPatch } from './assemblyClipEditing';
import { captureAssemblyClip, editAssemblyClipGapTransition, editAssemblyClipInstance, editAssemblyClipPriority, editAssemblyTextureOverlap, placeAssemblyClip, removeAssemblyClipInstance } from './assemblyClips';
import { createMotionBehavior } from './motion';
import { uid } from './model';
import type { AnimProperty, AssemblyAnimationClip, AssemblyClipTrack, AssemblyGapTransition, AssemblyTextureOverlap, CameraProperty, CameraState, FollowPathMotion, Keyframe, MotionBehavior, OscillationMotion, Project, ShakeMotion, StoryElement } from './model';

type Ref = string;
type KeyOptions = Partial<Pick<Keyframe, 'easing' | 'direction' | 'mode' | 'steps' | 'switchPoint'>>;
type CameraKeyOptions = Omit<KeyOptions, 'switchPoint'>;
type MotionCreate =
  | { type: 'followPath'; settings?: Partial<Omit<FollowPathMotion, 'id' | 'type'>> }
  | { type: 'oscillation'; settings?: Partial<Omit<OscillationMotion, 'id' | 'type'>> }
  | { type: 'shake'; settings?: Partial<Omit<ShakeMotion, 'id' | 'type'>> };
type MotionSettings = Partial<Omit<FollowPathMotion, 'id' | 'type'>> | Partial<Omit<OscillationMotion, 'id' | 'type'>> | Partial<Omit<ShakeMotion, 'id' | 'type'>>;

/** All times are seconds. Element keys are element-local, camera keys are scene-local,
 * clip definition and placed keys are clip-local, and placements use story time. */
export type TimelineCommand =
  | { op: 'track.ensure'; args: { elementId: Ref; property: AnimProperty } }
  | { op: 'track.remove'; args: { elementId: Ref; property: AnimProperty } }
  | { op: 'keyframe.upsert'; args: { elementId: Ref; property: AnimProperty; timeSeconds: number; value: number | string; id?: Ref; alias?: string } & KeyOptions }
  | { op: 'keyframe.move'; args: { elementId: Ref; property: AnimProperty; id: Ref; timeSeconds: number } }
  | { op: 'keyframe.remove'; args: { elementId: Ref; property: AnimProperty; id: Ref } }
  | { op: 'scene.setCamera'; args: { sceneId: Ref; camera: Partial<CameraState> } }
  | { op: 'camera.upsertKeyframe'; args: { sceneId: Ref; property: CameraProperty; timeSeconds: number; value: number; id?: Ref; alias?: string } & CameraKeyOptions }
  | { op: 'camera.deleteKeyframe'; args: { sceneId: Ref; property: CameraProperty; id: Ref } }
  | { op: 'motion.add'; args: { elementId: Ref; id?: string; alias?: string; behavior: MotionCreate } }
  | { op: 'motion.update'; args: { elementId: Ref; id: Ref; settings: MotionSettings } }
  | { op: 'motion.remove'; args: { elementId: Ref; id: Ref } }
  | { op: 'clip.capture'; args: { rootId: Ref; sourceStart: number; duration: number; name?: string; id?: string; alias?: string } }
  | { op: 'clip.rename'; args: { rootId: Ref; clipId: Ref; name: string } }
  | { op: 'clip.updateDefinition'; args: { rootId: Ref; clipId: Ref; definition: Partial<Pick<AssemblyAnimationClip, 'name' | 'duration' | 'tracks'>> } }
  | { op: 'clip.remove'; args: { rootId: Ref; clipId: Ref; removeInstances?: boolean } }
  | { op: 'clip.place'; args: { rootId: Ref; clipId: Ref; at: number; duration?: number; loop?: boolean; id?: string; alias?: string } }
  | { op: 'clip.move'; args: { rootId: Ref; instanceId: Ref; at: number; alignToFrame?: boolean } }
  | { op: 'clip.retime'; args: { rootId: Ref; instanceId: Ref; duration?: number; loop?: boolean; alignToFrame?: boolean } }
  | { op: 'clip.removeInstance'; args: { rootId: Ref; instanceId: Ref } }
  | { op: 'clip.setGapTransition'; args: { rootId: Ref; instanceId: Ref; elementId: Ref; property: AnimProperty; transition: Partial<Pick<AssemblyGapTransition, 'mode' | 'easing' | 'direction' | 'switchPoint'>> | null } }
  | { op: 'clip.setPriority'; args: { rootId: Ref; instanceId: Ref; elementId: Ref; property: AnimProperty; priority: number } }
  | { op: 'clip.setTextureOverlap'; args: { rootId: Ref; instanceId: Ref; elementId: Ref; overlap: Partial<Omit<AssemblyTextureOverlap, 'elementId'>> | null } }
  | { op: 'clip.editPlacedKey'; args: { rootId: Ref; clipId: Ref; instanceId: Ref; elementId: Ref; property: AnimProperty; action: 'add'; timeSeconds: number; alias?: string } }
  | { op: 'clip.editPlacedKey'; args: { rootId: Ref; clipId: Ref; instanceId: Ref; elementId: Ref; property: AnimProperty; action: 'edit'; keyId: Ref; patch: AssemblyKeyPatch; alignToFrame?: boolean } }
  | { op: 'clip.editPlacedKey'; args: { rootId: Ref; clipId: Ref; instanceId: Ref; elementId: Ref; property: AnimProperty; action: 'remove'; keyId: Ref } }
  | { op: 'clip.editPlacedKey'; args: { rootId: Ref; clipId: Ref; instanceId: Ref; elementId: Ref; property: AnimProperty; action: 'resetOverride' } };

export const timelineOperations = [
  'track.ensure', 'track.remove', 'keyframe.upsert', 'keyframe.move', 'keyframe.remove',
  'scene.setCamera', 'camera.upsertKeyframe', 'camera.deleteKeyframe',
  'motion.add', 'motion.update', 'motion.remove', 'clip.capture', 'clip.rename',
  'clip.updateDefinition', 'clip.remove', 'clip.place', 'clip.move', 'clip.retime',
  'clip.removeInstance', 'clip.setGapTransition', 'clip.setPriority',
  'clip.setTextureOverlap', 'clip.editPlacedKey',
] as const;

export const timelineCommandKeys: Record<TimelineCommand['op'], readonly string[]> = {
  'track.ensure': ['elementId', 'property'], 'track.remove': ['elementId', 'property'],
  'keyframe.upsert': ['elementId', 'property', 'timeSeconds', 'value', 'id', 'alias', 'easing', 'direction', 'mode', 'steps', 'switchPoint'],
  'keyframe.move': ['elementId', 'property', 'id', 'timeSeconds'], 'keyframe.remove': ['elementId', 'property', 'id'],
  'scene.setCamera': ['sceneId', 'camera'],
  'camera.upsertKeyframe': ['sceneId', 'property', 'timeSeconds', 'value', 'id', 'alias', 'easing', 'direction', 'mode', 'steps'],
  'camera.deleteKeyframe': ['sceneId', 'property', 'id'],
  'motion.add': ['elementId', 'id', 'alias', 'behavior'], 'motion.update': ['elementId', 'id', 'settings'], 'motion.remove': ['elementId', 'id'],
  'clip.capture': ['rootId', 'sourceStart', 'duration', 'name', 'id', 'alias'], 'clip.rename': ['rootId', 'clipId', 'name'],
  'clip.updateDefinition': ['rootId', 'clipId', 'definition'], 'clip.remove': ['rootId', 'clipId', 'removeInstances'],
  'clip.place': ['rootId', 'clipId', 'at', 'duration', 'loop', 'id', 'alias'],
  'clip.move': ['rootId', 'instanceId', 'at', 'alignToFrame'], 'clip.retime': ['rootId', 'instanceId', 'duration', 'loop', 'alignToFrame'],
  'clip.removeInstance': ['rootId', 'instanceId'],
  'clip.setGapTransition': ['rootId', 'instanceId', 'elementId', 'property', 'transition'],
  'clip.setPriority': ['rootId', 'instanceId', 'elementId', 'property', 'priority'],
  'clip.setTextureOverlap': ['rootId', 'instanceId', 'elementId', 'overlap'],
  'clip.editPlacedKey': ['rootId', 'clipId', 'instanceId', 'elementId', 'property', 'action', 'timeSeconds', 'alias', 'keyId', 'patch', 'alignToFrame'],
};

const requiredKeys: Record<TimelineCommand['op'], readonly string[]> = {
  'track.ensure': ['elementId', 'property'], 'track.remove': ['elementId', 'property'],
  'keyframe.upsert': ['elementId', 'property', 'timeSeconds', 'value'],
  'keyframe.move': ['elementId', 'property', 'id', 'timeSeconds'], 'keyframe.remove': ['elementId', 'property', 'id'],
  'scene.setCamera': ['sceneId', 'camera'],
  'camera.upsertKeyframe': ['sceneId', 'property', 'timeSeconds', 'value'],
  'camera.deleteKeyframe': ['sceneId', 'property', 'id'],
  'motion.add': ['elementId', 'behavior'], 'motion.update': ['elementId', 'id', 'settings'], 'motion.remove': ['elementId', 'id'],
  'clip.capture': ['rootId', 'sourceStart', 'duration'], 'clip.rename': ['rootId', 'clipId', 'name'],
  'clip.updateDefinition': ['rootId', 'clipId', 'definition'], 'clip.remove': ['rootId', 'clipId'],
  'clip.place': ['rootId', 'clipId', 'at'], 'clip.move': ['rootId', 'instanceId', 'at'],
  'clip.retime': ['rootId', 'instanceId'], 'clip.removeInstance': ['rootId', 'instanceId'],
  'clip.setGapTransition': ['rootId', 'instanceId', 'elementId', 'property', 'transition'],
  'clip.setPriority': ['rootId', 'instanceId', 'elementId', 'property', 'priority'],
  'clip.setTextureOverlap': ['rootId', 'instanceId', 'elementId', 'overlap'],
  'clip.editPlacedKey': ['rootId', 'clipId', 'instanceId', 'elementId', 'property', 'action'],
};

export interface TimelineCommandContext {
  resolve(ref: Ref): string;
  register(alias: string | undefined, id: string): void;
}

function object(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const unknown = Object.keys(value).find(key => !keys.includes(key) || ['__proto__', 'constructor', 'prototype'].includes(key));
  if (unknown) throw new Error(`${label} does not support ${unknown}.`);
}
function element(project: Project, id: string): StoryElement {
  const found = project.elements.find(item => item.id === id);
  if (!found) throw new Error(`Element ${id} does not exist.`);
  return found;
}
function rootClip(project: Project, rootId: string, clipId: string): AssemblyAnimationClip {
  const clip = element(project, rootId).assemblyClips?.find(item => item.id === clipId);
  if (!clip) throw new Error(`Assembly clip ${clipId} does not exist on root ${rootId}.`);
  return clip;
}
function keyId(project: Project, proposed: string | undefined, context: TimelineCommandContext): string {
  const id = proposed ? context.resolve(proposed) : uid();
  if (!id || id.startsWith('$')) throw new Error('Native IDs must be nonempty and cannot begin with $.');
  return id;
}
function explicitId(id: string | undefined, existing: readonly string[], label: string): string | undefined {
  if (id === undefined) return undefined;
  if (typeof id !== 'string' || !id || id.startsWith('$')) throw new Error(`${label} must be a nonempty native ID that does not begin with $.`);
  if (existing.includes(id)) throw new Error(`${label} ${id} is already used.`);
  return id;
}
function allKeyIds(project: Project): Set<string> {
  const ids = new Set<string>();
  for (const item of project.elements) {
    for (const track of item.tracks) for (const key of track.keyframes) ids.add(key.id);
    for (const clip of item.assemblyClips ?? []) for (const track of clip.tracks) for (const key of track.keyframes) ids.add(key.id);
    for (const instance of item.clipInstances ?? []) for (const track of instance.trackOverrides ?? []) for (const key of track.keyframes) ids.add(key.id);
  }
  for (const scene of project.sequences) for (const track of scene.camera?.tracks ?? []) for (const key of track.keyframes) ids.add(key.id);
  return ids;
}
function keyOptions(args: KeyOptions, previous?: Keyframe): KeyOptions {
  return {
    easing: args.easing ?? previous?.easing ?? 'linear', direction: args.direction ?? previous?.direction ?? 'inOut',
    mode: args.mode ?? previous?.mode ?? 'smooth',
    ...(args.steps ?? previous?.steps) === undefined ? {} : { steps: args.steps ?? previous?.steps },
    ...(args.switchPoint ?? previous?.switchPoint) === undefined ? {} : { switchPoint: args.switchPoint ?? previous?.switchPoint },
  };
}
function uniqueTime(keys: readonly Keyframe[], time: number, exceptId?: string): void {
  if (!Number.isFinite(time) || time < 0) throw new Error('Keyframe time must be finite and at or after zero.');
  if (keys.some(key => key.id !== exceptId && Math.abs(key.time - time) < 1e-8)) throw new Error('A keyframe already exists at this time.');
}
function resolvedTrackTarget(args: { rootId: Ref; clipId: Ref; instanceId?: Ref; elementId: Ref; property: AnimProperty }, context: TimelineCommandContext): AssemblyTrackTarget {
  return { rootId: context.resolve(args.rootId), clipId: context.resolve(args.clipId), ...(args.instanceId ? { instanceId: context.resolve(args.instanceId) } : {}), elementId: context.resolve(args.elementId), property: args.property };
}
function validateTrackProperty(property: string): asserts property is AnimProperty {
  if (!['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity', 'fill', 'volume', 'assetId'].includes(property)) throw new Error(`Unsupported animation property ${property}.`);
}
function resolvedTextureValue(value: number | string, property: AnimProperty, context: TimelineCommandContext): number | string {
  return property === 'assetId' && typeof value === 'string' && value.startsWith('$') ? context.resolve(value) : value;
}

/** Pure adapter over Hyde's model and clip editing functions. The caller validates
 * the returned project and commits it as part of one transaction. */
export function applyTimelineCommand(input: Project, command: TimelineCommand, context: TimelineCommandContext): Project {
  if (!Object.hasOwn(timelineCommandKeys, command.op)) throw new Error(`Unsupported operation ${command.op}.`);
  object(command.args, timelineCommandKeys[command.op], `${command.op} arguments`);
  for (const key of requiredKeys[command.op]) if (!Object.hasOwn(command.args, key) || (command.args as Record<string, unknown>)[key] === undefined) {
    throw new Error(`${command.op} requires ${key}.`);
  }
  const project = structuredClone(input);
  // JSON from the CLI/bridge is guarded by operation-specific key lists here;
  // the exported discriminated union provides static typing to SDK callers.
  const args = command.args as any;
  switch (command.op) {
    case 'track.ensure': {
      validateTrackProperty(args.property);
      const target = element(project, context.resolve(args.elementId));
      if (!target.tracks.some(track => track.property === args.property)) target.tracks.push({ property: args.property, keyframes: [] });
      return project;
    }
    case 'track.remove': {
      validateTrackProperty(args.property);
      const target = element(project, context.resolve(args.elementId));
      if (!target.tracks.some(track => track.property === args.property)) throw new Error('Animation track does not exist.');
      target.tracks = target.tracks.filter(track => track.property !== args.property);
      return project;
    }
    case 'keyframe.upsert': {
      validateTrackProperty(args.property);
      const target = element(project, context.resolve(args.elementId));
      let track = target.tracks.find(item => item.property === args.property);
      if (!track) { track = { property: args.property, keyframes: [] }; target.tracks.push(track); }
      const id = keyId(project, args.id, context), previous = track.keyframes.find(item => item.id === id);
      if (!previous && allKeyIds(project).has(id)) throw new Error(`Keyframe ID ${id} is already used.`);
      uniqueTime(track.keyframes, args.timeSeconds, id);
      const key: Keyframe = { id, time: args.timeSeconds, value: resolvedTextureValue(args.value, args.property, context), ...keyOptions(args, previous) } as Keyframe;
      if (previous) Object.assign(previous, key); else track.keyframes.push(key);
      track.keyframes.sort((a, b) => a.time - b.time);
      context.register(args.alias, id);
      return project;
    }
    case 'keyframe.move': {
      const track = element(project, context.resolve(args.elementId)).tracks.find(item => item.property === args.property);
      const id = context.resolve(args.id), key = track?.keyframes.find(item => item.id === id);
      if (!key) throw new Error('Keyframe does not exist on this track.');
      uniqueTime(track!.keyframes, args.timeSeconds, id);
      key.time = args.timeSeconds; track!.keyframes.sort((a, b) => a.time - b.time);
      return project;
    }
    case 'keyframe.remove': {
      const track = element(project, context.resolve(args.elementId)).tracks.find(item => item.property === args.property);
      const id = context.resolve(args.id);
      if (!track?.keyframes.some(item => item.id === id)) throw new Error('Keyframe does not exist on this track.');
      track.keyframes = track.keyframes.filter(item => item.id !== id);
      return project;
    }
    case 'scene.setCamera': {
      object(args.camera, ['x', 'y', 'zoom', 'rotation'], 'Camera');
      const scene = project.sequences.find(item => item.id === context.resolve(args.sceneId));
      if (!scene) throw new Error('Scene does not exist.');
      scene.camera ??= { x: project.width / 2, y: project.height / 2, zoom: 1, rotation: 0, tracks: [] };
      Object.assign(scene.camera, args.camera);
      return project;
    }
    case 'camera.upsertKeyframe': {
      const scene = project.sequences.find(item => item.id === context.resolve(args.sceneId));
      if (!scene) throw new Error('Scene does not exist.');
      if (!['x', 'y', 'zoom', 'rotation'].includes(args.property)) throw new Error(`Unsupported camera property ${args.property}.`);
      scene.camera ??= { x: project.width / 2, y: project.height / 2, zoom: 1, rotation: 0, tracks: [] };
      let track = scene.camera.tracks.find(item => item.property === args.property);
      if (!track) { track = { property: args.property, keyframes: [] }; scene.camera.tracks.push(track); }
      const id = keyId(project, args.id, context), previous = track.keyframes.find(item => item.id === id);
      if (!previous && allKeyIds(project).has(id)) throw new Error(`Keyframe ID ${id} is already used.`);
      if (args.timeSeconds > scene.duration) throw new Error('Camera keyframe lies outside its scene.');
      uniqueTime(track.keyframes, args.timeSeconds, id);
      const key: Keyframe = { id, time: args.timeSeconds, value: args.value, ...keyOptions(args, previous) } as Keyframe;
      if (previous) Object.assign(previous, key); else track.keyframes.push(key);
      track.keyframes.sort((a, b) => a.time - b.time);
      context.register(args.alias, id);
      return project;
    }
    case 'camera.deleteKeyframe': {
      const scene = project.sequences.find(item => item.id === context.resolve(args.sceneId));
      const track = scene?.camera?.tracks.find(item => item.property === args.property), id = context.resolve(args.id);
      if (!track?.keyframes.some(item => item.id === id)) throw new Error('Camera keyframe does not exist on this track.');
      track.keyframes = track.keyframes.filter(item => item.id !== id);
      return project;
    }
    case 'motion.add': {
      const target = element(project, context.resolve(args.elementId));
      object(args.behavior, ['type', 'settings'], 'Motion behavior');
      if (!['followPath', 'oscillation', 'shake'].includes(args.behavior.type)) throw new Error(`Unsupported motion behavior ${args.behavior.type}.`);
      const defaults = createMotionBehavior(args.behavior.type, target.duration);
      const id = args.id ?? defaults.id;
      if (!id || id.startsWith('$') || project.elements.some(item => item.motionBehaviors?.some(motion => motion.id === id))) throw new Error('Motion ID is invalid or already used.');
      const settings = args.behavior.settings ?? {};
      object(settings, motionKeys(args.behavior.type), 'Motion settings');
      target.motionBehaviors = [...(target.motionBehaviors ?? []), { ...defaults, ...structuredClone(settings), id } as MotionBehavior];
      context.register(args.alias, id);
      return project;
    }
    case 'motion.update': {
      const target = element(project, context.resolve(args.elementId));
      const behavior = target.motionBehaviors?.find(item => item.id === context.resolve(args.id));
      if (!behavior) throw new Error('Motion behavior does not exist.');
      object(args.settings, motionKeys(behavior.type), 'Motion settings');
      Object.assign(behavior, structuredClone(args.settings));
      return project;
    }
    case 'motion.remove': {
      const target = element(project, context.resolve(args.elementId)), id = context.resolve(args.id);
      if (!target.motionBehaviors?.some(item => item.id === id)) throw new Error('Motion behavior does not exist.');
      target.motionBehaviors = target.motionBehaviors.filter(item => item.id !== id);
      if (!target.motionBehaviors.length) delete target.motionBehaviors;
      return project;
    }
    case 'clip.capture': {
      const result = captureAssemblyClip(project, context.resolve(args.rootId), args.sourceStart, args.duration, args.name);
      const id = explicitId(args.id, project.elements.flatMap(item => item.assemblyClips?.map(clip => clip.id) ?? []), 'Clip ID') ?? result.clipId;
      if (id !== result.clipId) result.project.elements.find(item => item.id === context.resolve(args.rootId))!.assemblyClips!.find(item => item.id === result.clipId)!.id = id;
      context.register(args.alias, id);
      return result.project;
    }
    case 'clip.rename': {
      const clip = rootClip(project, context.resolve(args.rootId), context.resolve(args.clipId));
      if (!args.name.trim()) throw new Error('Clip name cannot be empty.');
      clip.name = args.name;
      return project;
    }
    case 'clip.updateDefinition': {
      object(args.definition, ['name', 'duration', 'tracks'], 'Clip definition');
      if (!Object.keys(args.definition).length) throw new Error('Clip definition update needs at least one changed field.');
      const clip = rootClip(project, context.resolve(args.rootId), context.resolve(args.clipId));
      if (args.definition.name !== undefined) { if (!args.definition.name.trim()) throw new Error('Clip name cannot be empty.'); clip.name = args.definition.name; }
      if (args.definition.duration !== undefined) {
        if (!Number.isFinite(args.definition.duration) || args.definition.duration < 1 / project.fps) throw new Error('Clip definition must last at least one frame.');
        if (clip.tracks.some(track => track.keyframes.some(key => key.time > args.definition.duration!))) throw new Error('Retiming would place an existing clip key beyond the definition.');
        clip.duration = args.definition.duration;
      }
      if (args.definition.tracks !== undefined) {
        if (!Array.isArray(args.definition.tracks) || !args.definition.tracks.length) throw new Error('Clip definition needs at least one track.');
        const partIds = new Set([context.resolve(args.rootId)]);
        let changed = true;
        while (changed) { changed = false; for (const item of project.elements) { const parentId = item.attachment?.parentId ?? item.parentId; if (parentId && partIds.has(parentId) && !partIds.has(item.id)) { partIds.add(item.id); changed = true; } } }
        clip.tracks = (structuredClone(args.definition.tracks) as AssemblyClipTrack[]).map((track: AssemblyClipTrack) => {
          track.elementId = context.resolve(track.elementId);
          if (!partIds.has(track.elementId)) throw new Error('Clip track target is outside its assembly.');
          if (track.property === 'assetId') for (const key of track.keyframes) if (typeof key.value === 'string' && key.value.startsWith('$')) key.value = context.resolve(key.value);
          return track;
        });
      }
      return project;
    }
    case 'clip.remove': {
      const root = element(project, context.resolve(args.rootId)), clipId = context.resolve(args.clipId);
      rootClip(project, root.id, clipId);
      const instances = root.clipInstances?.filter(item => item.clipId === clipId) ?? [];
      if (instances.length && !args.removeInstances) throw new Error('Clip definition has placed instances; request removeInstances=true to delete them.');
      root.assemblyClips = root.assemblyClips!.filter(item => item.id !== clipId);
      if (instances.length) root.clipInstances = root.clipInstances!.filter(item => item.clipId !== clipId);
      if (!root.assemblyClips.length) delete root.assemblyClips;
      if (!root.clipInstances?.length) delete root.clipInstances;
      return project;
    }
    case 'clip.place': {
      const rootId = context.resolve(args.rootId), clipId = context.resolve(args.clipId);
      const result = placeAssemblyClip(project, rootId, clipId, args.at, args.duration);
      const id = explicitId(args.id, project.elements.flatMap(item => item.clipInstances?.map(instance => instance.id) ?? []), 'Placed clip ID') ?? result.instanceId;
      if (id !== result.instanceId) result.project.elements.find(item => item.id === rootId)!.clipInstances!.find(item => item.id === result.instanceId)!.id = id;
      context.register(args.alias, id);
      return args.loop === undefined ? result.project : editAssemblyClipInstance(result.project, rootId, id, { loop: args.loop, alignToFrame: false });
    }
    case 'clip.move': return editAssemblyClipInstance(project, context.resolve(args.rootId), context.resolve(args.instanceId), { at: args.at, alignToFrame: args.alignToFrame ?? false });
    case 'clip.retime': {
      if (args.duration === undefined && args.loop === undefined) throw new Error('Clip retime needs duration or loop.');
      return editAssemblyClipInstance(project, context.resolve(args.rootId), context.resolve(args.instanceId), { duration: args.duration, loop: args.loop, alignToFrame: args.alignToFrame ?? false });
    }
    case 'clip.removeInstance': return removeAssemblyClipInstance(project, context.resolve(args.rootId), context.resolve(args.instanceId));
    case 'clip.setGapTransition': {
      if (args.transition) object(args.transition, ['mode', 'easing', 'direction', 'switchPoint'], 'Gap transition');
      return editAssemblyClipGapTransition(project, context.resolve(args.rootId), context.resolve(args.instanceId), context.resolve(args.elementId), args.property, args.transition);
    }
    case 'clip.setPriority': return editAssemblyClipPriority(project, context.resolve(args.rootId), context.resolve(args.instanceId), context.resolve(args.elementId), args.property, args.priority);
    case 'clip.setTextureOverlap': {
      if (args.overlap) object(args.overlap, ['mode', 'switchesPerSecond', 'switchPoint'], 'Texture overlap');
      return editAssemblyTextureOverlap(project, context.resolve(args.rootId), context.resolve(args.instanceId), context.resolve(args.elementId), args.overlap);
    }
    case 'clip.editPlacedKey': {
      if (!args.instanceId) throw new Error('Editing a placed key requires an instance.');
      if (!['add', 'edit', 'remove', 'resetOverride'].includes(args.action)) throw new Error(`Unsupported placed key action ${args.action}.`);
      const target = resolvedTrackTarget(args, context);
      if (args.action === 'resetOverride') {
        if (!target.instanceId) throw new Error('Resetting a placed track requires an instance.');
        return resetAssemblyClipTrackOverride(project, target);
      }
      const view = assemblyTrackView(project, target);
      if (args.action === 'add') {
        if (args.timeSeconds === undefined) throw new Error('Adding a placed key requires timeSeconds.');
        const previous = new Set(view.track.keyframes.map(key => key.id));
        const next = addAssemblyClipKey(project, target, args.timeSeconds);
        const effective = assemblyTrackView(next, target).track.keyframes;
        const added = effective.find(key => !previous.has(key.id));
        // First edits of an instance clone all source keys with fresh IDs. The
        // requested key is the one at the snapped time that was not in source.
        const key = added && (!target.instanceId || effective.filter(item => !previous.has(item.id)).length === 1)
          ? added : effective.find(item => Math.abs(item.time - Math.round(args.timeSeconds * project.fps) / project.fps) < 1e-8);
        if (!key) throw new Error('Could not identify the added clip keyframe.');
        context.register(args.alias, key.id);
        return next;
      }
      if (!args.keyId) throw new Error(`${args.action} requires keyId.`);
      const id = context.resolve(args.keyId), index = view.track.keyframes.findIndex(key => key.id === id);
      if (index < 0) throw new Error('Clip keyframe does not exist on this track.');
      if (args.action === 'remove') return removeAssemblyClipKey(project, target, index);
      object(args.patch, ['time', 'value', 'easing', 'direction', 'mode', 'steps', 'switchPoint'], 'Clip key patch');
      const patch = structuredClone(args.patch);
      if (patch.value !== undefined) patch.value = resolvedTextureValue(patch.value, target.property, context);
      return editAssemblyClipKey(project, target, index, patch, { alignToFrame: args.alignToFrame ?? false });
    }
    default: throw new Error(`Unsupported operation ${(command as { op: string }).op}.`);
  }
}

function motionKeys(type: MotionBehavior['type']): string[] {
  const common = ['enabled', 'start', 'duration'];
  if (type === 'followPath') return [...common, 'points', 'loop', 'orient', 'easing', 'direction'];
  if (type === 'oscillation') return [...common, 'property', 'amplitude', 'frequency', 'phase', 'fadeIn', 'fadeOut'];
  return [...common, 'seed', 'frequency', 'amplitudeX', 'amplitudeY', 'amplitudeRotation', 'smooth', 'fadeIn', 'fadeOut'];
}
