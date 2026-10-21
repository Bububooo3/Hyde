import type {AssemblyClipGapSegment} from './assemblyClips';

export interface AssemblyGapGroup {
  id: string;
  rootId: string;
  fromInstanceId: string;
  toInstanceId: string;
  start: number;
  end: number;
  segments: AssemblyClipGapSegment[];
}

/** One visible timeline band can edit every part/property transition in its gap. */
export function groupAssemblyGapSegments(segments: readonly AssemblyClipGapSegment[]): AssemblyGapGroup[] {
  const groups = new Map<string, AssemblyGapGroup>();
  for (const segment of segments) {
    const id = JSON.stringify([segment.rootId, segment.fromInstanceId, segment.toInstanceId, segment.start, segment.end]);
    let group = groups.get(id);
    if (!group) {
      group = {id, rootId: segment.rootId, fromInstanceId: segment.fromInstanceId,
        toInstanceId: segment.toInstanceId, start: segment.start, end: segment.end, segments: []};
      groups.set(id, group);
    }
    group.segments.push(segment);
  }
  return [...groups.values()].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}
