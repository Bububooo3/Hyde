import type { AnimProperty, AssemblyClipTrack, AssemblyGapTransition, AssemblyTextureOverlap, Project } from './model';

const epsilon = 1e-8;

/** A placed track in story time. Linked scene placements keep their reusable
 * source keys and scale only the instance's time coordinates. */
export interface PlacedAssemblyTrack {
  rootId: string; elementId: string; sourceElementId: string; instanceId: string;
  property: AnimProperty; track: AssemblyClipTrack;
  start: number; end: number; sourceDuration: number; duration: number;
  timeScale: number; loop: boolean; order: number;
  gapTransitions?: AssemblyGapTransition[];
  textureOverlap?: AssemblyTextureOverlap;
  priority: number;
}

export interface AssemblyClipGapSegment {
  /** Stable while the two placements keep their identities. */
  id: string;
  rootId: string; elementId: string; sourceElementId: string;
  property: AnimProperty; fromInstanceId: string; toInstanceId: string;
  start: number; end: number;
  mode: 'tween' | 'hold';
  easing: AssemblyGapTransition['easing']; direction: AssemblyGapTransition['direction'];
  switchPoint: number;
  /** Derived track references are read-only inputs for evaluation/curve preview. */
  from: PlacedAssemblyTrack; to: PlacedAssemblyTrack;
}

/** Shared placement mapping for playback and timeline gap display. Accepts an
 * authored project or an already materialized linked-scene view. */
export function collectAssemblyClipTracks(project: Project): Map<string, PlacedAssemblyTrack[]> {
  const result = new Map<string, PlacedAssemblyTrack[]>();
  const originalById = new Map(project.elements.filter(element => !element.id.includes('::')).map(element => [element.id, element]));
  for (const root of project.elements) {
    if (!root.assemblyClips?.length || !root.clipInstances?.length) continue;
    const separator = root.id.lastIndexOf('::');
    const originalId = separator < 0 ? root.id : root.id.slice(separator + 2);
    const prefix = separator < 0 ? '' : root.id.slice(0, separator + 2);
    const original = originalById.get(originalId);
    const scale = original && original.duration > 0 ? root.duration / original.duration : 1;
    let order = 0;
    for (const instance of root.clipInstances) {
      const clip = root.assemblyClips.find(candidate => candidate.id === instance.clipId);
      if (!clip) continue;
      const start = root.start + instance.start * scale;
      const duration = instance.duration * scale;
      for (const track of clip.tracks) {
        const placedTrack = instance.trackOverrides?.find(item => item.elementId === track.elementId && item.property === track.property) ?? track;
        const targetId = prefix + track.elementId;
        const entries = result.get(targetId) ?? [];
        entries.push({
          rootId: root.id, elementId: targetId, sourceElementId: track.elementId,
          instanceId: instance.id, property: track.property, track: placedTrack,
          start, end: start + duration, duration, sourceDuration: clip.duration,
          timeScale: scale, loop: !!instance.loop, order: order++,
          gapTransitions: instance.gapTransitions,
          textureOverlap: track.property === 'assetId' ? instance.textureOverlaps?.find(item => item.elementId === track.elementId) : undefined,
          priority: instance.priorityOverrides?.find(item => item.elementId === track.elementId && item.property === track.property)?.priority ?? 0,
        });
        result.set(targetId, entries);
      }
    }
  }
  return result;
}

/** Pure, per-part/property selection of positive gaps. Overlapping clips retain
 * their existing priority/blending. A gap begins only after the previous
 * coverage has ended; its outgoing pose is the latest-starting clip's pose. */
export function deriveAssemblyClipGapSegments(
  placed: Map<string, PlacedAssemblyTrack[]>,
  options: { rootId?: string; start?: number; end?: number } = {},
): AssemblyClipGapSegment[] {
  const groups = new Map<string, PlacedAssemblyTrack[]>();
  for (const tracks of placed.values()) for (const item of tracks) {
    if (options.rootId && item.rootId !== options.rootId) continue;
    const key = JSON.stringify([item.rootId, item.elementId, item.property]);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const segments: AssemblyClipGapSegment[] = [];
  for (const tracks of groups.values()) {
    tracks.sort((a, b) => a.start - b.start || a.order - b.order);
    let previous = tracks[0], coveredUntil = previous?.end ?? -Infinity;
    for (const next of tracks.slice(1)) {
      if (next.start > coveredUntil + epsilon && coveredUntil < (options.end ?? Infinity) && next.start > (options.start ?? -Infinity)) {
        const override = next.gapTransitions?.find(item => item.elementId === next.sourceElementId && item.property === next.property);
        segments.push({
          id: JSON.stringify([next.rootId, next.elementId, next.property, previous.instanceId, next.instanceId]),
          rootId: next.rootId, elementId: next.elementId, sourceElementId: next.sourceElementId,
          property: next.property, fromInstanceId: previous.instanceId, toInstanceId: next.instanceId,
          start: coveredUntil, end: next.start,
          mode: override?.mode ?? 'tween', easing: override?.easing ?? 'linear', direction: override?.direction ?? 'inOut',
          switchPoint: override?.switchPoint ?? .5,
          from: previous, to: next,
        });
      }
      coveredUntil = Math.max(coveredUntil, next.end);
      previous = next;
    }
  }
  return segments.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
}

/** Timeline-facing selector. The returned segments are derived, never stored. */
export function selectAssemblyClipGapSegments(
  project: Project,
  options: { rootId?: string; start?: number; end?: number } = {},
): AssemblyClipGapSegment[] {
  return deriveAssemblyClipGapSegments(collectAssemblyClipTracks(project), options);
}
