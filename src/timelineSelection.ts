import {captionWindow,elementWindow,type AnimProperty, type CameraProperty, type Project, type StoryElement } from './model';
import { descendantIds } from './editing';

export type TimelineItem =
  | { kind: 'clip'; elementId: string }
  | { kind: 'key'; elementId: string; property: AnimProperty; keyId: string }
  | { kind: 'cameraKey'; sequenceId: string; property: CameraProperty; keyId: string };

const EPSILON = 1e-7;

function frameDuration(project: Project): number {
  if (!Number.isFinite(project.fps) || project.fps <= 0) throw new Error('The project frame rate is invalid.');
  return 1 / project.fps;
}

function finiteDelta(delta: number): void {
  if (!Number.isFinite(delta)) throw new Error('Choose a finite timeline movement.');
}

function within(value: number, min: number, max = Infinity): boolean {
  return Number.isFinite(value) && value >= min - EPSILON && value <= max + EPSILON;
}

function assertElement(project: Project, id: string): StoryElement {
  const element = project.elements.find(item => item.id === id);
  if (!element) throw new Error('One of the selected timeline items no longer exists.');
  return element;
}

function assertKey(project: Project, item: Extract<TimelineItem, {kind: 'key'}>): void {
  const element = assertElement(project, item.elementId);
  const track = element.tracks.find(candidate => candidate.property === item.property);
  if (!track?.keyframes.some(key => key.id === item.keyId)) {
    throw new Error('One of the selected keyframes no longer exists.');
  }
}

function assertCameraKey(project: Project, item: Extract<TimelineItem, {kind: 'cameraKey'}>): void {
  const sequence = project.sequences.find(candidate => candidate.id === item.sequenceId);
  if (!sequence?.camera?.tracks.find(track => track.property === item.property)?.keyframes.some(key => key.id === item.keyId)) {
    throw new Error('One of the selected camera keyframes no longer exists.');
  }
}

function authoredEnd(project:Project):number {
  return Math.max(frameDuration(project),
    ...project.elements.map(element=>elementWindow(project,element)?.end??0),
    ...project.sequences.map(sequence=>sequence.start+sequence.duration),
    ...project.captions.map(caption=>captionWindow(project,caption)?.end??0));
}

function finish(project: Project, requestedDuration: number): Project {
  project.duration = Math.max(authoredEnd(project),requestedDuration);
  project.updatedAt = new Date().toISOString();
  return project;
}

/** Move caption and scene boundaries along with a ripple edit. Clips are handled separately. */
function rippleBoundaries(project: Project, boundaries: readonly number[], delta: number): void {
  const shift = (time: number) => time + delta * boundaries.filter(boundary => time >= boundary - EPSILON).length;
  const frame = frameDuration(project);
  for (const caption of project.captions) {
    const start = shift(caption.start), end = shift(caption.end);
    if (!within(start, 0) || !within(end, start)) throw new Error('Ripple editing would invalidate a caption.');
    caption.start = Math.max(0, start);
    caption.end = Math.max(caption.start, end);
  }
  for (const sequence of project.sequences) {
    const start = shift(sequence.start), end = shift(sequence.start + sequence.duration);
    if (!within(start, 0) || !within(end - start, frame)) throw new Error('Ripple editing would make a scene too short.');
    sequence.start = Math.max(0, start);
    sequence.duration = end - start;
  }
}

/**
 * Translate one rigid selection in time. Selected clip roots carry their complete
 * assemblies; a child selected as well is still translated only once. Keys on
 * clips moved by the same edit retain their local times (their global times have
 * already moved with the clip).
 */
export function moveTimelineItems(
  base: Project,
  items: Iterable<TimelineItem>,
  deltaSeconds: number,
  options: {ripple?: boolean} = {},
): Project {
  finiteDelta(deltaSeconds);
  const selected = [...items];
  if (!selected.length || Math.abs(deltaSeconds) < EPSILON) return base;
  const clips = new Set<string>();
  const keys = new Map<string, Extract<TimelineItem, {kind: 'key'}>>();
  const cameraKeys = new Map<string, Extract<TimelineItem, {kind: 'cameraKey'}>>();
  for (const item of selected) {
    if (item.kind === 'clip') {
      assertElement(base, item.elementId);
      clips.add(item.elementId);
    } else if (item.kind === 'key') {
      assertKey(base, item);
      keys.set(`${item.elementId}\u0000${item.property}\u0000${item.keyId}`, item);
    } else {
      assertCameraKey(base, item);
      cameraKeys.set(`${item.sequenceId}\u0000${item.property}\u0000${item.keyId}`, item);
    }
  }
  const movedClipIds = descendantIds(base, clips);
  const selectedClips = base.elements.filter(element => clips.has(element.id));
  const boundary = selectedClips.length
    ? Math.max(...selectedClips.map(element => element.start + element.duration))
    : Infinity;
  const next = structuredClone(base);
  const shiftedClipIds = new Set(movedClipIds);
  for (const element of next.elements) {
    const selectedClip = movedClipIds.has(element.id);
    const rippleClip = options.ripple && element.start >= boundary - EPSILON;
    if (!selectedClip && !rippleClip) continue;
    const start = element.start + deltaSeconds;
    if (!within(start, 0)) throw new Error('This move would put a clip before the beginning of the story.');
    element.start = Math.max(0, start);
    shiftedClipIds.add(element.id);
  }
  const changedKeysByTrack = new Map<string, Set<string>>();
  for (const item of keys.values()) {
    if (shiftedClipIds.has(item.elementId)) continue;
    const element = assertElement(next, item.elementId);
    const track = element.tracks.find(candidate => candidate.property === item.property)!;
    const key = track.keyframes.find(candidate => candidate.id === item.keyId)!;
    const time = key.time + deltaSeconds;
    if (!within(time, 0, element.duration)) throw new Error('This move would put a keyframe outside its clip.');
    key.time = Math.min(element.duration, Math.max(0, time));
    const trackId = `${item.elementId}\u0000${item.property}`;
    if (!changedKeysByTrack.has(trackId)) changedKeysByTrack.set(trackId, new Set());
    changedKeysByTrack.get(trackId)!.add(key.id);
  }
  for (const [trackId, changedIds] of changedKeysByTrack) {
    const [elementId, property] = trackId.split('\u0000') as [string, AnimProperty];
    const track = assertElement(next, elementId).tracks.find(candidate => candidate.property === property)!;
    track.keyframes.sort((a, b) => a.time - b.time);
    for (let index = 1; index < track.keyframes.length; index++) {
      const before = track.keyframes[index - 1], after = track.keyframes[index];
      if (Math.abs(after.time - before.time) < EPSILON && (changedIds.has(before.id) || changedIds.has(after.id))) {
        throw new Error('This move would place two keyframes at the same time.');
      }
    }
  }
  const changedCameraTracks = new Map<string, Set<string>>();
  for (const item of cameraKeys.values()) {
    const sequence = next.sequences.find(candidate => candidate.id === item.sequenceId)!;
    const track = sequence.camera!.tracks.find(candidate => candidate.property === item.property)!;
    const key = track.keyframes.find(candidate => candidate.id === item.keyId)!;
    const local = key.time + deltaSeconds;
    if (!within(local, 0, sequence.duration)) throw new Error('This move would put a camera keyframe outside its scene.');
    key.time = Math.min(sequence.duration, Math.max(0, local));
    const trackId = `${item.sequenceId}\u0000${item.property}`;
    if (!changedCameraTracks.has(trackId)) changedCameraTracks.set(trackId, new Set());
    changedCameraTracks.get(trackId)!.add(key.id);
  }
  for (const [trackId, changedIds] of changedCameraTracks) {
    const [sequenceId, property] = trackId.split('\u0000') as [string, CameraProperty];
    const track = next.sequences.find(sequence => sequence.id === sequenceId)!.camera!.tracks.find(candidate => candidate.property === property)!;
    track.keyframes.sort((a, b) => a.time - b.time);
    for (let index = 1; index < track.keyframes.length; index++) {
      const before = track.keyframes[index - 1], after = track.keyframes[index];
      if (Math.abs(after.time - before.time) < EPSILON && (changedIds.has(before.id) || changedIds.has(after.id))) {
        throw new Error('This move would place two camera keyframes at the same time.');
      }
    }
  }
  if (options.ripple && selectedClips.length) rippleBoundaries(next, [boundary], deltaSeconds);
  const manualDuration=base.duration>authoredEnd(base)+EPSILON?base.duration:0;
  return finish(next, manualDuration + (options.ripple && selectedClips.length ? deltaSeconds : 0));
}

/**
 * Change all selected clip durations together. In ripple mode, each original
 * selected out-point contributes one time shift to everything after it.
 */
export function trimTimelineClips(
  base: Project,
  clipElementIds: Iterable<string>,
  deltaSeconds: number,
  options: {ripple?: boolean} = {},
): Project {
  finiteDelta(deltaSeconds);
  const ids = new Set(clipElementIds);
  if (!ids.size || Math.abs(deltaSeconds) < EPSILON) return base;
  const frame = frameDuration(base);
  const selected = [...ids].map(id => assertElement(base, id));
  const boundaries = selected.map(element => element.start + element.duration);
  const next = structuredClone(base);
  const shift = (time: number) => options.ripple
    ? deltaSeconds * boundaries.filter(boundary => time >= boundary - EPSILON).length
    : 0;
  for (const element of next.elements) {
    const originalStart = element.start;
    element.start += shift(originalStart);
    if (!within(element.start, 0)) throw new Error('This trim would put a clip before the beginning of the story.');
    element.start = Math.max(0, element.start);
    if (!ids.has(element.id)) continue;
    const duration = element.duration + deltaSeconds;
    if (!within(duration, frame)) throw new Error('A clip must be at least one project frame long.');
    const asset = next.assets.find(item => item.id === element.assetId);
    if (!element.loop && asset?.duration !== undefined) {
      const speed = element.speed ?? 1;
      const offset = element.sourceOffset ?? 0;
      if (!Number.isFinite(speed) || speed <= 0 || !within(offset, 0, asset.duration) || duration * speed > asset.duration - offset + EPSILON) {
        throw new Error('This trim would run past the end of its source.');
      }
    }
    for (const track of element.tracks) for (const key of track.keyframes) {
      if (!within(key.time, 0, duration)) throw new Error('This trim would leave a keyframe outside its clip.');
    }
    element.duration = duration;
    if (element.fadeIn !== undefined) element.fadeIn = Math.min(element.fadeIn, duration);
    if (element.fadeOut !== undefined) element.fadeOut = Math.min(element.fadeOut, duration);
  }
  if (options.ripple) rippleBoundaries(next, boundaries, deltaSeconds);
  const manualDuration=base.duration>authoredEnd(base)+EPSILON?base.duration:0;
  return finish(next, manualDuration + (options.ripple ? deltaSeconds * boundaries.length : 0));
}

/** A power-of-ten nudge: 2 s on screen gives 0.1 s, 20 s gives 1 s. */
export function timelineNudgeStep(visibleSpanSeconds: number, fps: number, snap: boolean): number {
  const span = Number.isFinite(visibleSpanSeconds) && visibleSpanSeconds > 0 ? visibleSpanSeconds : 2;
  const raw = 10 ** (Math.floor(Math.log10(span)) - 1);
  if (!snap || !Number.isFinite(fps) || fps <= 0) return raw;
  return Math.max(1, Math.round(raw * fps)) / fps;
}
