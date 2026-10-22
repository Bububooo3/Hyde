import type { AnimProperty, CameraProperty, CameraState, CameraTrack, EasingDirection, EasingFamily, Keyframe, Project, Sequence, StoryElement, Track } from './model';
import {elementWindow} from './model';
import {materializeScenePlacements} from './scenePlacement';
import {applyMotionBehaviors} from './motion';
import { collectAssemblyClipTracks, deriveAssemblyClipGapSegments, type AssemblyClipGapSegment, type PlacedAssemblyTrack } from './assemblyClipGaps';
import {textureDuringOverlap} from './textureConflict';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;

function bounceOut(t: number): number {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) { t -= 1.5 / d; return n * t * t + .75; }
  if (t < 2.5 / d) { t -= 2.25 / d; return n * t * t + .9375; }
  t -= 2.625 / d;
  return n * t * t + .984375;
}

function easeIn(family: EasingFamily, t: number): number {
  switch (family) {
    case 'linear': return t;
    case 'sine': return 1 - Math.cos(t * Math.PI / 2);
    case 'quad': return t * t;
    case 'cubic': return t ** 3;
    case 'quart': return t ** 4;
    case 'quint': return t ** 5;
    case 'expo': return 2 ** (10 * t - 10);
    case 'circ': return 1 - Math.sqrt(Math.max(0, 1 - t * t));
    case 'back': return 2.70158 * t ** 3 - 1.70158 * t * t;
    case 'bounce': return 1 - bounceOut(1 - t);
    case 'elastic': return -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * (2 * Math.PI / 3));
  }
}

/** Shared, deterministic easing. Overshoot is intentional; bounded properties clamp later. */
export function ease(family: EasingFamily, direction: EasingDirection, time: number): number {
  const t = clamp(finite(time, 0), 0, 1);
  if (t === 0 || t === 1) return t;
  if (direction === 'out') return 1 - easeIn(family, 1 - t);
  if (direction === 'inOut' && t === .5) return .5;
  if (direction === 'inOut') return t < .5 ? easeIn(family, t * 2) / 2 : 1 - easeIn(family, (1 - t) * 2) / 2;
  return easeIn(family, t);
}

type RGBA = [number, number, number, number];
function colorChannels(input: string): RGBA | null {
  const value = input.trim().toLowerCase();
  if (value === 'transparent') return [0, 0, 0, 0];
  if (/^#[\da-f]{3,4}$/.test(value)) {
    const channels = value.slice(1).split('').map(char => parseInt(char + char, 16));
    return [channels[0], channels[1], channels[2], (channels[3] ?? 255) / 255];
  }
  if (/^#[\da-f]{6}([\da-f]{2})?$/.test(value)) {
    return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16), value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1];
  }
  const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(value);
  return match ? [clamp(+match[1], 0, 255), clamp(+match[2], 0, 255), clamp(+match[3], 0, 255), clamp(+(match[4] ?? 1), 0, 1)] : null;
}

function interpolateColor(from: string, to: string, progress: number): string {
  const a = colorChannels(from), b = colorChannels(to);
  if (!a || !b) return progress < .5 ? from : to;
  const result = a.map((value, i) => clamp(value + (b[i] - value) * progress, 0, i === 3 ? 1 : 255));
  if (result[3] === 1) return '#' + result.slice(0, 3).map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('');
  return `rgba(${Math.round(result[0])}, ${Math.round(result[1])}, ${Math.round(result[2])}, ${Number(result[3].toFixed(5))})`;
}

function interpolate(property: AnimProperty | CameraProperty, from: number | string, to: number | string, progress: number): number | string {
  if (typeof from === 'string' || typeof to === 'string') {
    return property === 'fill' && typeof from === 'string' && typeof to === 'string'
      ? interpolateColor(from, to, progress) : progress < .5 ? from : to;
  }
  let difference = to - from;
  // An explicitly authored complete turn is preserved; ordinary angles use the shorter path.
  if (property === 'rotation' && Math.abs(difference) < 360) difference = ((difference + 180) % 360 + 360) % 360 - 180;
  return from + difference * progress;
}

function orderedKeys(track: Pick<Track, 'keyframes'>): Keyframe[] {
  const sorted = track.keyframes.filter(key => Number.isFinite(key.time)).slice().sort((a, b) => a.time - b.time);
  // At equal timestamps the last authored key wins, including when approached from the left.
  return sorted.filter((key, index) => sorted[index + 1]?.time !== key.time);
}

function numericValues(property: AnimProperty | CameraProperty, keys: Keyframe[]): number[] | null {
  if (!keys.every(key => typeof key.value === 'number' && Number.isFinite(key.value))) return null;
  const values = keys.map(key => key.value as number);
  if (property === 'rotation') {
    // Keep adjacent short turns continuous before deriving velocities. Explicit full turns stay intact.
    for (let i = 1; i < values.length; i++) {
      let difference = (keys[i].value as number) - (keys[i - 1].value as number);
      if (Math.abs(difference) < 360) difference = ((difference + 180) % 360 + 360) % 360 - 180;
      values[i] = values[i - 1] + difference;
    }
  }
  return values;
}

const derivativeStep = 1e-5;
function easingDerivative(key: Keyframe, end: boolean): number {
  return end
    ? (1 - ease(key.easing, key.direction, 1 - derivativeStep)) / derivativeStep
    : ease(key.easing, key.direction, derivativeStep) / derivativeStep;
}

function hermite(from: number, to: number, departure: number, arrival: number, duration: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * from + (t3 - 2 * t2 + t) * duration * departure
    + (-2 * t3 + 3 * t2) * to + (t3 - t2) * duration * arrival;
}

function smoothTangent(keys: Keyframe[], values: number[], index: number): number {
  const last = keys.length - 1;
  if (index > 0 && keys[index - 1].mode !== 'smooth') return 0;
  if (index < last && keys[index].mode !== 'smooth') return 0;
  if (index === 0) return (values[1] - values[0]) / (keys[1].time - keys[0].time) * easingDerivative(keys[0], false);
  if (index === last) return (values[last] - values[last - 1]) / (keys[last].time - keys[last - 1].time) * easingDerivative(keys[last - 1], true);

  const before = keys[index].time - keys[index - 1].time;
  const after = keys[index + 1].time - keys[index].time;
  const incoming = (values[index] - values[index - 1]) / before;
  const outgoing = (values[index + 1] - values[index]) / after;
  // A true reversal should stop at its apex. Otherwise use one common velocity on both sides.
  if (incoming === 0 || outgoing === 0 || Math.sign(incoming) !== Math.sign(outgoing)) return 0;
  const previousWeight = 2 * after + before, nextWeight = after + 2 * before;
  return (previousWeight + nextWeight) / (previousWeight / incoming + nextWeight / outgoing);
}

function smoothNumeric(keys: Keyframe[], values: number[], index: number, t: number): number {
  const from = keys[index], to = keys[index + 1], duration = to.time - from.time;
  const base = hermite(values[index], values[index + 1], smoothTangent(keys, values, index), smoothTangent(keys, values, index + 1), duration, t);
  // Retain the selected easing's shape, but remove its endpoint slopes before adding it to
  // the shared-velocity curve. Two-key tracks therefore retain their original easing exactly.
  const eased = ease(from.easing, from.direction, t);
  const easedBaseline = hermite(0, 1, easingDerivative(from, false), easingDerivative(from, true), 1, t);
  return base + (values[index + 1] - values[index]) * (eased - easedBaseline);
}

export function trackValue(track: Track | CameraTrack, time: number): number | string | undefined {
  const keys = orderedKeys(track);
  if (!keys.length) return undefined;
  const values = numericValues(track.property, keys);
  if (time <= keys[0].time) return values?.[0] ?? keys[0].value;
  for (let i = 1; i < keys.length; i++) {
    const to = keys[i], from = keys[i - 1];
    if (time === to.time) return values?.[i] ?? to.value;
    if (time < to.time) {
      if (from.mode === 'hold') return values?.[i - 1] ?? from.value;
      const duration = to.time - from.time;
      let elapsed = time - from.time;
      if (from.mode === 'stepped') {
        const rate = Math.max(1, finite(from.steps ?? 12, 12));
        elapsed = Math.floor((elapsed + 1e-10) * rate) / rate;
      }
      if(track.property==='assetId')return elapsed/duration<(from.switchPoint??.5)?from.value:to.value;
      if (from.mode === 'smooth' && values) return smoothNumeric(keys, values, i - 1, elapsed / duration);
      return interpolate(track.property, from.value, to.value, ease(from.easing, from.direction, elapsed / duration));
    }
  }
  return values?.[values.length - 1] ?? keys[keys.length - 1].value;
}

/** The active sequence's camera. In gaps it holds the previous view; a new scene cuts to its view. */
export function evaluateCameraForScene(project:Project,scene:Sequence,time:number):CameraState {
  const neutral: CameraState = { x: project.width / 2, y: project.height / 2, zoom: 1, rotation: 0 };
  const visited=new Set<string>();
  const resolve=(current:Sequence,at:number):CameraState=>{
    if(visited.has(current.id))return neutral;
    visited.add(current.id);
    if(current.camera){
      const authored=current.camera,local=clamp(at-current.start,0,current.duration);
      const result:CameraState={x:finite(authored.x,neutral.x),y:finite(authored.y,neutral.y),zoom:finite(authored.zoom,1),rotation:finite(authored.rotation,0)};
      for(const track of authored.tracks??[]){const value=trackValue(track,local);if(typeof value==='number'&&Number.isFinite(value)&&track.property in result)result[track.property]=value;}
      result.zoom=Math.max(.01,result.zoom);
      return result;
    }
    const source=current.sourceSceneId?project.sequences.find(item=>item.id===current.sourceSceneId):undefined;
    if(!source||current.duration<=0)return neutral;
    const sourceSpan=(current.sourceOut??source.duration)-(current.sourceIn??0);
    const sourceTime=source.start+(current.sourceIn??0)+(at-current.start)*sourceSpan/current.duration;
    return resolve(source,sourceTime);
  };
  return resolve(scene,time);
}

export function evaluateCamera(project: Project, time: number): CameraState {
  const neutral: CameraState = { x: project.width / 2, y: project.height / 2, zoom: 1, rotation: 0 };
  const scenes = project.sequences.filter(scene => Number.isFinite(scene.start) && Number.isFinite(scene.duration) && scene.duration > 0)
    .slice().sort((a, b) => a.start - b.start);
  if (!scenes.length) return neutral;
  const at = finite(time, 0);
  const active = scenes.filter(scene => at >= scene.start && at < scene.start + scene.duration).at(-1);
  const scene = active ?? scenes.filter(candidate => candidate.start <= at).at(-1) ?? scenes[0];
  return evaluateCameraForScene(project,scene,at);
}

export interface CameraPoint { x: number; y: number }

/** Convert authored world coordinates to pixels within the story stage. */
export function cameraToStage(point: CameraPoint, camera: CameraState, project: Pick<Project, 'width' | 'height'>): CameraPoint {
  const radians = -camera.rotation * Math.PI / 180;
  const c = Math.cos(radians), s = Math.sin(radians);
  const dx = point.x - camera.x, dy = point.y - camera.y;
  const zoom = Math.max(.01, finite(camera.zoom, 1));
  return { x: project.width / 2 + zoom * (dx * c - dy * s), y: project.height / 2 + zoom * (dx * s + dy * c) };
}

/** Inverse of cameraToStage, for hit testing, guides, and direct manipulation. */
export function stageToCamera(point: CameraPoint, camera: CameraState, project: Pick<Project, 'width' | 'height'>): CameraPoint {
  const radians = camera.rotation * Math.PI / 180;
  const c = Math.cos(radians), s = Math.sin(radians);
  const zoom = Math.max(.01, finite(camera.zoom, 1));
  const dx = (point.x - project.width / 2) / zoom, dy = (point.y - project.height / 2) / zoom;
  return { x: camera.x + dx * c - dy * s, y: camera.y + dx * s + dy * c };
}

/** Evaluate an element without parents. Key times are relative to its start. */
export function evaluateElement(element: StoryElement, time: number): StoryElement | null {
  if (!Number.isFinite(time) || !Number.isFinite(element.duration) || element.duration <= 0 || element.hidden || time < element.start || time > element.start + element.duration) return null;
  const evaluated = { ...element };
  for (const track of element.tracks) {
    const value = trackValue(track, time - element.start);
    if (track.property === 'assetId') {
      if(typeof value==='string')evaluated.assetId=value||undefined;
    } else if (track.property === 'fill') {
      if (typeof value === 'string') evaluated.fill = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      evaluated[track.property] = track.property === 'opacity' ? clamp(value, 0, 1) : track.property === 'volume' ? Math.max(0, value) : value;
    }
  }
  evaluated.opacity = clamp(evaluated.opacity, 0, 1);
  return evaluated;
}

function placedTrackValue(item: PlacedAssemblyTrack, time: number): number | string | undefined {
  const elapsed = Math.min(item.duration, Math.max(0, time - item.start));
  const sourceElapsed = elapsed / item.timeScale;
  const remainder = sourceElapsed % item.sourceDuration;
  const local = item.loop
    ? sourceElapsed > 0 && Math.abs(remainder) < 1e-8 ? item.sourceDuration : remainder
    : elapsed / item.duration * item.sourceDuration;
  return trackValue(item.track, local);
}

function applyAssemblyTracks(element: StoryElement, tracks: PlacedAssemblyTrack[] | undefined, gaps: AssemblyClipGapSegment[] | undefined, time: number): StoryElement {
  if (!tracks?.length) return element;
  const result = { ...element };
  for (const property of new Set(tracks.map(item => item.property))) {
    const ordered = tracks.filter(item => item.property === property && time >= item.start)
      .sort((a, b) => a.start - b.start || a.order - b.order);
    const priorityTrack = ordered.filter(item => item.priority > 0 && time < item.end)
      .sort((a, b) => b.priority - a.priority || b.start - a.start || b.order - a.order)[0];
    let value: number | string | undefined;
    let previousEnd = -Infinity;
    for (const item of ordered) {
      const next = placedTrackValue(item, time);
      if (next === undefined) continue;
      if (value !== undefined && item.start < previousEnd && time < previousEnd) {
        const progress = clamp((time - item.start) / (previousEnd - item.start), 0, 1);
        value = property === 'assetId' && typeof value === 'string' && typeof next === 'string'
          ? textureDuringOverlap(value,next,time,item.start,previousEnd,item.textureOverlap)
          : interpolate(property, value, next, progress);
      } else value = next;
      previousEnd = Math.max(previousEnd, item.end);
    }
    if (priorityTrack) value = placedTrackValue(priorityTrack, time);
    const gap = gaps?.find(segment => segment.property === property && time > segment.start && time < segment.end);
    // The selector excludes overlap itself; if a different assembly currently
    // supplies this property, retain its authored priority and blend behavior.
    if (!priorityTrack && gap && !ordered.some(item => item.rootId !== gap.rootId && time < item.end && item.start >= gap.from.start)) {
      const from = placedTrackValue(gap.from, gap.from.end);
      const to = placedTrackValue(gap.to, gap.to.start);
      if (from !== undefined && to !== undefined) {
        const progress=(time-gap.start)/(gap.end-gap.start);
        value = gap.mode === 'hold' ? from
          : property==='assetId'&&typeof from==='string'&&typeof to==='string'
            ? progress<gap.switchPoint?from:to
            : interpolate(property, from, to, ease(gap.easing, gap.direction, progress));
      }
    }
    if (property === 'assetId' && typeof value === 'string')result.assetId=value||undefined;
    else if (property === 'fill' && typeof value === 'string') result.fill = value;
    else if (property !== 'fill' && property !== 'assetId' && typeof value === 'number' && Number.isFinite(value)) {
      result[property] = property === 'opacity' ? clamp(value, 0, 1) : property === 'volume' ? Math.max(0, value) : value;
    }
  }
  return result;
}

function constrain(evaluated: StoryElement, original: StoryElement): StoryElement {
  const attachment = original.attachment;
  if (!attachment) return evaluated;
  const result = { ...evaluated };
  const min = attachment.min ?? -Infinity, max = attachment.max ?? Infinity;
  if (attachment.type === 'fixed') {
    result.x = original.x;
    result.y = original.y;
    result.rotation = original.rotation;
  } else if (attachment.type === 'hinge') {
    result.x = original.x;
    result.y = original.y;
    result.rotation = clamp(result.rotation, Math.min(min, max), Math.max(min, max));
  } else {
    // Slider limits are distances from its authored anchor, along the parent's local X axis.
    result.x = original.x + clamp(result.x - original.x, Math.min(min, max), Math.max(min, max));
    result.y = original.y;
    result.rotation = original.rotation;
  }
  return result;
}

/** Flatten the parent graph into stage-space transforms, preserving source layer order. */
export function evaluateProject(project: Project, time: number): StoryElement[] {
  if (!Number.isFinite(time)) return [];
  project=materializeScenePlacements(project);
  const clipTracks = collectAssemblyClipTracks(project);
  const clipGaps = new Map<string, AssemblyClipGapSegment[]>();
  for (const gap of deriveAssemblyClipGapSegments(clipTracks)) {
    const list = clipGaps.get(gap.elementId) ?? [];
    list.push(gap);
    clipGaps.set(gap.elementId, list);
  }
  const elements = new Map(project.elements.map(element => [element.id, element]));
  const resolved = new Map<string, StoryElement | null>();
  const visiting = new Set<string>();
  const resolve = (id: string): StoryElement | null => {
    if (resolved.has(id)) return resolved.get(id)!;
    if (visiting.has(id)) return null;
    const original = elements.get(id);
    if (!original) return null;
    const visible=elementWindow(project,original);
    if(!visible||time<visible.start||time>=visible.end){resolved.set(id,null);return null;}
    const local = evaluateElement(original, time);
    if (!local) { resolved.set(id, null); return null; }
    visiting.add(id);
    const animated=applyAssemblyTracks(local,clipTracks.get(id),clipGaps.get(id),time);
    const firstActivePath=original.motionBehaviors?.find(behavior=>behavior.type==='followPath'&&behavior.enabled&&time-original.start>=behavior.start);
    const pathStart=firstActivePath?original.start+firstActivePath.start:time;
    const startPose=firstActivePath?evaluateElement(original,pathStart):null;
    const pathAnchor=startPose?applyAssemblyTracks(startPose,clipTracks.get(id),clipGaps.get(id),pathStart):undefined;
    let world = constrain(applyMotionBehaviors(animated,original,time,ease,pathAnchor), original);
    const parentId = original.attachment?.parentId ?? original.parentId;
    if (parentId) {
      const parent = resolve(parentId);
      if (!parent) {
        visiting.delete(id);
        resolved.set(id, null);
        return null;
      }
      const radians = parent.rotation * Math.PI / 180;
      const x = world.x * parent.scaleX, y = world.y * parent.scaleY;
      world = {
        ...world,
        x: parent.x + x * Math.cos(radians) - y * Math.sin(radians),
        y: parent.y + x * Math.sin(radians) + y * Math.cos(radians),
        rotation: parent.rotation + world.rotation,
        scaleX: parent.scaleX * world.scaleX,
        scaleY: parent.scaleY * world.scaleY,
        opacity: parent.opacity * world.opacity,
      };
    }
    visiting.delete(id);
    resolved.set(id, world);
    return world;
  };
  return project.elements.map(element => resolve(element.id)).filter((element): element is StoryElement => element !== null);
}

/** Map story time to media time. Pass intrinsic media duration for exact loop/end handling. */
export function sourceTime(element: StoryElement, time: number, sourceDuration?: number): number {
  const local = clamp(finite(time, element.start) - element.start, 0, Math.max(0, element.duration));
  const speed = Math.max(0, finite(element.speed ?? 1, 1));
  const offset = Math.max(0, finite(element.sourceOffset ?? 0, 0));
  const position = offset + local * speed;
  if (sourceDuration === undefined || !Number.isFinite(sourceDuration) || sourceDuration <= 0) return position;
  if (element.loop) {
    // A trimmed source loops over its remaining range, preserving the source offset.
    const start = Math.min(offset, sourceDuration);
    const length = sourceDuration - start;
    return length > 0 ? start + (local * speed % length) : sourceDuration;
  }
  return Math.min(position, sourceDuration);
}

/** Applies only to video visuals; its audio has its own finite source window. */
export function videoVisualExpired(element: StoryElement, time: number, sourceDuration: number): boolean {
  if (element.videoEndBehavior !== 'hide' || element.loop || !Number.isFinite(sourceDuration) || sourceDuration <= 0) return false;
  const local = clamp(finite(time, element.start) - element.start, 0, Math.max(0, element.duration));
  const speed = Math.max(0, finite(element.speed ?? 1, 1));
  const offset = Math.max(0, finite(element.sourceOffset ?? 0, 0));
  return offset + local * speed >= sourceDuration;
}
