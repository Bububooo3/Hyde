import { evaluateElement } from './engine';
import { uid, type AnimProperty, type AssemblyAnimationClip, type AssemblyGapTransition, type AssemblyTextureOverlap, type Keyframe, type Project, type StoryElement } from './model';
import {DEFAULT_TEXTURE_CONFLICT} from './textureConflict';
export { selectAssemblyClipGapSegments } from './assemblyClipGaps';
export type { AssemblyClipGapSegment } from './assemblyClipGaps';

const properties: AnimProperty[] = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity', 'fill', 'volume', 'assetId'];
const epsilon = 1e-8;

function validTime(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite time at or after zero.`);
}

function rootAndParts(project: Project, rootId: string): { root: StoryElement; parts: StoryElement[] } {
  const root = project.elements.find(element => element.id === rootId);
  if (!root) throw new Error('The assembly root no longer exists.');
  const included = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const element of project.elements) {
      const parent = element.attachment?.parentId ?? element.parentId;
      if (parent && included.has(parent) && !included.has(element.id)) { included.add(element.id); changed = true; }
    }
  }
  return { root, parts: project.elements.filter(element => included.has(element.id)) };
}

function poseAt(element: StoryElement, time: number): StoryElement {
  const at = Math.min(Math.max(time, element.start), element.start + element.duration);
  return evaluateElement({ ...element, hidden: false }, at) ?? element;
}

function boundary(time: number, value: number | string, preceding?: Keyframe): Keyframe {
  return { id: uid(), time, value, easing: preceding?.easing ?? 'linear', direction: preceding?.direction ?? 'in', mode: preceding?.mode ?? 'smooth', ...(preceding?.steps ? { steps: preceding.steps } : {}), ...(preceding?.switchPoint!==undefined?{switchPoint:preceding.switchPoint}:{}) };
}

/** Capture a reusable assembly pose or motion sequence from an absolute story
 * interval. Keys in the definition use clip-local time and preserve authored
 * easing; all captured values remain in the parts' local coordinate spaces. */
export function captureAssemblyClip(project: Project, rootId: string, sourceStart: number, duration: number, name = 'Animation clip'): { project: Project; clipId: string } {
  validTime(sourceStart, 'Clip start');
  if (!Number.isFinite(duration) || duration < 1 / project.fps - epsilon) throw new Error('An assembly clip must last at least one project frame.');
  const { root, parts } = rootAndParts(project, rootId);
  if (sourceStart < root.start - epsilon || sourceStart + duration > root.start + root.duration + epsilon) {
    throw new Error('Capture an interval within the assembly root’s active span.');
  }
  const next = structuredClone(project);
  const nextRoot = next.elements.find(element => element.id === rootId)!;
  const clipId = uid();
  const hasChildren = parts.length > 1;
  const tracks: AssemblyAnimationClip['tracks'] = [];
  for (const part of parts) {
    for (const property of properties) {
      if (part.id === rootId && part.kind === 'group' && hasChildren && ['x', 'y', 'rotation', 'scaleX', 'scaleY'].includes(property)) continue;
      if (property === 'volume' && part.kind !== 'audio' && part.kind !== 'video') continue;
      if (property === 'assetId' && (!['rectangle','ellipse','polygon','text','image','video'].includes(part.kind) ||
          (!part.assetId && !part.tracks.some(track => track.property === 'assetId')))) continue;
      const authored = part.tracks.find(track => track.property === property);
      const sourceKeys = authored?.keyframes.slice().sort((a, b) => a.time - b.time) ?? [];
      const absolute = sourceKeys.map(key => ({ ...key, absolute: part.start + key.time }));
      const preceding = absolute.filter(key => key.absolute <= sourceStart + epsilon).at(-1);
      const initial = property === 'assetId' ? poseAt(part, sourceStart).assetId ?? '' : poseAt(part, sourceStart)[property];
      if (typeof initial !== 'number' && typeof initial !== 'string') continue;
      const keys: Keyframe[] = [boundary(0, initial, preceding)];
      for (const key of absolute) {
        const localTime = key.absolute - sourceStart;
        if (localTime <= epsilon || localTime > duration + epsilon) continue;
        keys.push({ ...key, id: uid(), time: Math.min(duration, localTime) });
      }
      if (sourceKeys.length && keys.at(-1)!.time < duration - epsilon) {
        const value = property === 'assetId' ? poseAt(part, sourceStart + duration).assetId ?? '' : poseAt(part, sourceStart + duration)[property];
        if (typeof value === 'number' || typeof value === 'string') keys.push(boundary(duration, value, sourceKeys.at(-1)));
      }
      tracks.push({ elementId: part.id, property, keyframes: keys });
    }
  }
  if (!tracks.length) throw new Error('This assembly has no properties to capture.');
  nextRoot.assemblyClips = [...(nextRoot.assemblyClips ?? []), { id: clipId, name: name.trim() || 'Animation clip', duration, tracks }];
  next.updatedAt = new Date().toISOString();
  return { project: next, clipId };
}

/** Place a linked instance. Changing its definition affects every instance;
 * changing instance timing leaves the reusable definition untouched. */
export function placeAssemblyClip(project: Project, rootId: string, clipId: string, at: number, duration?: number): { project: Project; instanceId: string } {
  validTime(at, 'Clip position');
  const { root } = rootAndParts(project, rootId);
  const clip = root.assemblyClips?.find(candidate => candidate.id === clipId);
  if (!clip) throw new Error('The assembly clip no longer exists.');
  const length = duration ?? clip.duration;
  if (!Number.isFinite(length) || length < 1 / project.fps - epsilon) throw new Error('A placed clip must last at least one project frame.');
  if (at < root.start - epsilon) throw new Error('Place the clip at or after the assembly begins.');
  const end = at + length;
  const scene = root.sceneId ? project.sequences.find(sequence => sequence.id === root.sceneId) : undefined;
  if (scene && end > scene.start + scene.duration + epsilon && project.sequences.length !== 1) {
    throw new Error('Extend the scene before placing this clip beyond its boundary.');
  }
  const next = structuredClone(project), nextRoot = next.elements.find(element => element.id === rootId)!;
  const instanceId = uid();
  nextRoot.clipInstances = [...(nextRoot.clipInstances ?? []), { id: instanceId, clipId, start: at - root.start, duration: length }];
  nextRoot.duration = Math.max(nextRoot.duration, end - nextRoot.start);
  for (const id of new Set(clip.tracks.map(track => track.elementId))) {
    const part = next.elements.find(element => element.id === id)!;
    part.duration = Math.max(part.duration, end - part.start);
  }
  next.duration = Math.max(next.duration, end);
  if (scene && project.sequences.length === 1) next.sequences[0].duration = Math.max(next.sequences[0].duration, end - scene.start);
  next.updatedAt = new Date().toISOString();
  return { project: next, instanceId };
}

/** Remove one placement without deleting its reusable source clip. */
export function removeAssemblyClipInstance(project: Project, rootId: string, instanceId: string): Project {
  const { root } = rootAndParts(project, rootId);
  if (!root.clipInstances?.some(instance => instance.id === instanceId)) throw new Error('The placed assembly clip no longer exists.');
  const next = structuredClone(project), nextRoot = next.elements.find(element => element.id === rootId)!;
  nextRoot.clipInstances = nextRoot.clipInstances!.filter(instance => instance.id !== instanceId);
  next.updatedAt = new Date().toISOString();
  return next;
}

/** Retiming a placed clip changes only that instance. Its shared source clip
 * remains reusable by every other placement. Absolute `at` matches the story
 * timeline while the stored start stays relative to the assembly root. */
export function editAssemblyClipInstance(project:Project,rootId:string,instanceId:string,patch:{at?:number;duration?:number;loop?:boolean;alignToFrame?:boolean}):Project{
  const {root}=rootAndParts(project,rootId);
  const existing=root.clipInstances?.find(item=>item.id===instanceId);
  if(!existing)throw new Error('The placed assembly clip no longer exists.');
  const rawAt=patch.at??root.start+existing.start,rawDuration=patch.duration??existing.duration;
  const at=patch.alignToFrame===false?rawAt:Math.round(rawAt*project.fps)/project.fps;
  const duration=patch.alignToFrame===false?rawDuration:Math.round(rawDuration*project.fps)/project.fps;
  if(!Number.isFinite(at)||!Number.isFinite(duration)||at<root.start-epsilon||duration<1/project.fps-epsilon)
    throw new Error('A placed clip must start within its assembly and last at least one frame.');
  const end=at+duration;
  const scene=root.sceneId?project.sequences.find(item=>item.id===root.sceneId):undefined;
  if(scene&&project.sequences.length!==1&&end>scene.start+scene.duration+epsilon)
    throw new Error('Extend the scene before moving this clip beyond its boundary.');
  const next=structuredClone(project),nextRoot=next.elements.find(item=>item.id===rootId)!;
  const instance=nextRoot.clipInstances!.find(item=>item.id===instanceId)!;
  instance.start=at-nextRoot.start;instance.duration=duration;
  if(patch.loop!==undefined)instance.loop=patch.loop;
  nextRoot.duration=Math.max(nextRoot.duration,end-nextRoot.start);
  const clip=nextRoot.assemblyClips?.find(item=>item.id===instance.clipId);
  for(const id of new Set(clip?.tracks.map(track=>track.elementId)??[])){
    const part=next.elements.find(item=>item.id===id);
    if(part)part.duration=Math.max(part.duration,end-part.start);
  }
  next.duration=Math.max(next.duration,end);
  if(scene&&project.sequences.length===1)next.sequences[0].duration=Math.max(next.sequences[0].duration,end-scene.start);
  return next;
}

/** Edit one part/property's transition into a placed clip. `null` restores the
 * default tween; placement timing and the reusable source are untouched. */
export function editAssemblyClipGapTransition(
  project: Project, rootId: string, toInstanceId: string, elementId: string,
  property: AnimProperty, patch: Partial<Pick<AssemblyGapTransition, 'mode' | 'easing' | 'direction' | 'switchPoint'>> | null,
): Project {
  const { root } = rootAndParts(project, rootId);
  const instance = root.clipInstances?.find(item => item.id === toInstanceId);
  if (!instance) throw new Error('The incoming placed assembly clip no longer exists.');
  const clip = root.assemblyClips?.find(item => item.id === instance.clipId);
  if (!clip?.tracks.some(track => track.elementId === elementId && track.property === property)) {
    throw new Error('The incoming clip does not animate this part and property.');
  }
  const next = structuredClone(project);
  const target = next.elements.find(item => item.id === rootId)!.clipInstances!.find(item => item.id === toInstanceId)!;
  const current = target.gapTransitions?.find(item => item.elementId === elementId && item.property === property);
  target.gapTransitions = (target.gapTransitions ?? []).filter(item => item.elementId !== elementId || item.property !== property);
  if (patch) {
    const setting: AssemblyGapTransition = {
      elementId, property,
      mode: patch.mode ?? current?.mode ?? 'tween',
      easing: patch.easing ?? current?.easing ?? 'linear',
      direction: patch.direction ?? current?.direction ?? 'inOut',
      ...((patch.switchPoint??current?.switchPoint)!==undefined?{switchPoint:patch.switchPoint??current?.switchPoint}:{}),
    };
    if (!['tween', 'hold'].includes(setting.mode) || !['linear', 'sine', 'quad', 'cubic', 'quart', 'quint', 'expo', 'circ', 'back', 'bounce', 'elastic'].includes(setting.easing) || !['in', 'out', 'inOut'].includes(setting.direction)) {
      throw new Error('Choose a valid assembly gap transition.');
    }
    if(setting.switchPoint!==undefined&&(property!=='assetId'||!Number.isFinite(setting.switchPoint)||setting.switchPoint<0||setting.switchPoint>1))
      throw new Error('Texture gap switch point must be between zero and one.');
    target.gapTransitions.push(setting);
  }
  if (!target.gapTransitions.length) delete target.gapTransitions;
  next.updatedAt = new Date().toISOString();
  return next;
}

/** Override one placed clip's overlap mixing for one part/property. Zero restores
 * automatic blending. The reusable source clip is never modified. */
export function editAssemblyClipPriority(project: Project, rootId: string, instanceId: string,
  elementId: string, property: AnimProperty, priority: number): Project {
  if (!Number.isInteger(priority) || priority < 0 || priority > 10) throw new Error('Priority must be a whole number from 0 to 10.');
  const {root} = rootAndParts(project, rootId);
  const instance = root.clipInstances?.find(item => item.id === instanceId);
  if (!instance) throw new Error('The placed assembly clip no longer exists.');
  const clip = root.assemblyClips?.find(item => item.id === instance.clipId);
  if (!clip?.tracks.some(track => track.elementId === elementId && track.property === property)) {
    throw new Error('This clip does not animate that part and property.');
  }
  const next = structuredClone(project);
  const target = next.elements.find(item => item.id === rootId)!.clipInstances!.find(item => item.id === instanceId)!;
  target.priorityOverrides = (target.priorityOverrides ?? []).filter(item => item.elementId !== elementId || item.property !== property);
  if (priority) target.priorityOverrides.push({elementId, property, priority});
  if (!target.priorityOverrides.length) delete target.priorityOverrides;
  next.updatedAt = new Date().toISOString();
  return next;
}

/** Set one incoming texture conflict policy without changing its source clip. */
export function editAssemblyTextureOverlap(project: Project, rootId: string, instanceId: string,
  elementId: string, patch: Partial<Omit<AssemblyTextureOverlap,'elementId'>> | null): Project {
  const {root}=rootAndParts(project,rootId);
  const instance=root.clipInstances?.find(item=>item.id===instanceId);
  if(!instance)throw new Error('The placed assembly clip no longer exists.');
  const clip=root.assemblyClips?.find(item=>item.id===instance.clipId);
  if(!clip?.tracks.some(track=>track.elementId===elementId&&track.property==='assetId'))
    throw new Error('This clip does not animate the selected texture.');
  const next=structuredClone(project);
  const target=next.elements.find(item=>item.id===rootId)!.clipInstances!.find(item=>item.id===instanceId)!;
  const previous=target.textureOverlaps?.find(item=>item.elementId===elementId);
  target.textureOverlaps=(target.textureOverlaps??[]).filter(item=>item.elementId!==elementId);
  if(patch){
    const setting:AssemblyTextureOverlap={elementId,
      mode:patch.mode??previous?.mode??DEFAULT_TEXTURE_CONFLICT.mode,
      switchesPerSecond:patch.switchesPerSecond??previous?.switchesPerSecond??DEFAULT_TEXTURE_CONFLICT.switchesPerSecond,
      switchPoint:patch.switchPoint??previous?.switchPoint??DEFAULT_TEXTURE_CONFLICT.switchPoint,
    };
    if(!['alternate','single','holdOutgoing','useIncoming'].includes(setting.mode)||
      !Number.isFinite(setting.switchesPerSecond)||setting.switchesPerSecond<=0||setting.switchesPerSecond>60||
      !Number.isFinite(setting.switchPoint)||setting.switchPoint<0||setting.switchPoint>1)
      throw new Error('Choose a valid texture overlap setting.');
    target.textureOverlaps.push(setting);
  }
  if(!target.textureOverlaps.length)delete target.textureOverlaps;
  next.updatedAt=new Date().toISOString();
  return next;
}

/** Asset references in animation are dependencies even when the resting pose
 * has no texture. Assembly export uses this set to include every such source. */
export function animationAssetIds(element: StoryElement): Set<string> {
  const result=new Set<string>();
  const add=(tracks:readonly {property:AnimProperty;keyframes:Keyframe[]}[])=>{
    for(const track of tracks)if(track.property==='assetId')for(const key of track.keyframes)
      if(typeof key.value==='string'&&key.value)result.add(key.value);
  };
  add(element.tracks);
  for(const clip of element.assemblyClips??[])add(clip.tracks);
  for(const instance of element.clipInstances??[])add(instance.trackOverrides??[]);
  return result;
}

/** Remap imported assembly animation to copied/deduplicated project assets. */
export function remapAnimationAssetIds(element: StoryElement, assetIds: Map<string,string>): void {
  const remap=(tracks:readonly {property:AnimProperty;keyframes:Keyframe[]}[])=>{
    for(const track of tracks)if(track.property==='assetId')for(const key of track.keyframes){
      if(key.value==='')continue;
      const mapped=typeof key.value==='string'?assetIds.get(key.value):undefined;
      if(!mapped)throw new Error('An assembly texture key refers to a missing asset.');
      key.value=mapped;
    }
  };
  remap(element.tracks);
  for(const clip of element.assemblyClips??[])remap(clip.tracks);
  for(const instance of element.clipInstances??[])remap(instance.trackOverrides??[]);
}

/** Apply identity remapping whenever a complete assembly subtree is copied. */
export function remapAssemblyClipReferences(element: StoryElement, elementIds: Map<string, string>): void {
  const clipIds = new Map((element.assemblyClips ?? []).map(clip => [clip.id, uid()]));
  for (const clip of element.assemblyClips ?? []) {
    clip.id = clipIds.get(clip.id)!;
    for (const track of clip.tracks) {
      const mapped = elementIds.get(track.elementId);
      if (!mapped) throw new Error('An assembly clip refers to a part outside the copied subtree.');
      track.elementId = mapped;
      for (const key of track.keyframes) key.id = uid();
    }
  }
  for (const instance of element.clipInstances ?? []) {
    instance.id = uid();
    const mapped = clipIds.get(instance.clipId);
    if (!mapped) throw new Error('A placed assembly clip refers to a missing definition.');
    instance.clipId = mapped;
    for (const transition of instance.gapTransitions ?? []) {
      const target = elementIds.get(transition.elementId);
      if (!target) throw new Error('An assembly gap transition refers to a part outside the copied subtree.');
      transition.elementId = target;
    }
    for (const override of instance.priorityOverrides ?? []) {
      const target = elementIds.get(override.elementId);
      if (!target) throw new Error('An assembly priority refers to a part outside the copied subtree.');
      override.elementId = target;
    }
    for (const overlap of instance.textureOverlaps ?? []) {
      const target = elementIds.get(overlap.elementId);
      if (!target) throw new Error('An assembly texture setting refers to a part outside the copied subtree.');
      overlap.elementId = target;
    }
    for (const track of instance.trackOverrides ?? []) {
      const target = elementIds.get(track.elementId);
      if (!target) throw new Error('A placed clip track refers to a part outside the copied subtree.');
      track.elementId = target;
      for (const key of track.keyframes) key.id = uid();
    }
  }
}
