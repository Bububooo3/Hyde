import type { AnimProperty, Project } from './model';
import { descendantIds, translateAssemblyTime } from './editing';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Keep ruler labels near a readable screen distance as the visible scale changes. */
export function rulerStep(duration: number, laneWidth: number): number {
  const ideal = duration * 76 / Math.max(1, laneWidth);
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(ideal, 0.001)));
  return [1, 2, 2.5, 5, 10].map(multiplier => multiplier * magnitude).find(step => step >= ideal) ?? 10 * magnitude;
}

export function rulerTicks(duration: number, laneWidth: number): {time: number; label: string}[] {
  const step = rulerStep(duration, laneWidth);
  const count = Math.min(300, Math.floor(duration / step + 1e-8));
  return Array.from({length: count + 1}, (_, index) => {
    const time = Number((index * step).toFixed(6));
    return {time, label: `${time}s`};
  });
}

function shiftLater(project: Project, excluded: Set<string>, boundary: number, delta: number) {
  if (Math.abs(delta) < 1e-9) return;
  const later = project.elements.filter(element => !excluded.has(element.id) && element.start >= boundary - 1e-8).map(element => element.id);
  const ids = descendantIds(project, later);
  for (const element of project.elements) if (ids.has(element.id) && !excluded.has(element.id)) element.start = Math.max(0, element.start + delta);
  for (const caption of project.captions) {
    if (caption.start >= boundary - 1e-8) { caption.start = Math.max(0, caption.start + delta); caption.end = Math.max(caption.start, caption.end + delta); }
    else if (caption.end > boundary) caption.end = Math.max(caption.start, caption.end + delta);
  }
  for (const sequence of project.sequences) {
    if (sequence.start >= boundary - 1e-8) sequence.start = Math.max(0, sequence.start + delta);
    else if (sequence.start + sequence.duration >= boundary - 1e-8) sequence.duration = Math.max(1 / project.fps, sequence.duration + delta);
  }
}

function setDuration(project: Project, preserve: number) {
  project.duration = Math.max(1 / project.fps, preserve, ...project.elements.map(element => element.start + element.duration), ...project.sequences.map(sequence => sequence.start + sequence.duration), ...project.captions.map(caption => caption.end));
}

/** A ripple move carries subsequent material with the moved clip. */
export function moveTimelineClip(base: Project, id: string, requestedStart: number, ripple: boolean): Project {
  const original = base.elements.find(element => element.id === id);
  if (!original) return base;
  const start = Math.max(0, requestedStart);
  const delta = start - original.start;
  const movedIds = descendantIds(base, [id]);
  const next = translateAssemblyTime(base, id, start);
  if (ripple) shiftLater(next, movedIds, original.start + original.duration, delta);
  setDuration(next, ripple ? base.duration + delta : base.duration);
  return next;
}

/** A ripple trim changes the length of the current scene and shifts later clips. */
export function trimTimelineClip(base: Project, id: string, requestedDuration: number, ripple: boolean): Project {
  const original = base.elements.find(element => element.id === id);
  if (!original) return base;
  const next = structuredClone(base);
  const element = next.elements.find(item => item.id === id)!;
  const asset = next.assets.find(item => item.id === element.assetId);
  const available = asset?.duration === undefined ? 3600 : (asset.duration - (element.sourceOffset ?? 0)) / Math.max(0.001, element.speed ?? 1);
  element.duration = clamp(requestedDuration, 1 / next.fps, Math.max(1 / next.fps, available));
  const delta = element.duration - original.duration;
  if (ripple) shiftLater(next, descendantIds(base, [id]), original.start + original.duration, delta);
  setDuration(next, ripple ? base.duration + delta : base.duration);
  return next;
}

export function moveTimelineKey(base: Project, elementId: string, property: AnimProperty, keyId: string, requestedTime: number): Project {
  const next = structuredClone(base);
  const element = next.elements.find(item => item.id === elementId);
  const track = element?.tracks.find(item => item.property === property);
  const key = track?.keyframes.find(item => item.id === keyId);
  if (!element || !track || !key) return base;
  key.time = clamp(requestedTime, 0, element.duration);
  track.keyframes.sort((a, b) => a.time - b.time);
  return next;
}
