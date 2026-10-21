import { collectAssemblyClipTracks, type PlacedAssemblyTrack } from './assemblyClipGaps';
import { evaluateProject } from './engine';
import { elementWindow, type Asset, type Project, type StoryElement } from './model';
import { materializeScenePlacements } from './scenePlacement';
import { DEFAULT_TEXTURE_CONFLICT } from './textureConflict';

export interface MediaAudioSegment {
  /** The original element supplies source time, volume automation, fades and effects. */
  element: StoryElement;
  asset: Asset;
  start: number;
  end: number;
}

const EPSILON = 1e-8;
const audioAsset = (asset: Asset | undefined): asset is Asset => !!asset && (asset.kind === 'audio' || asset.kind === 'video');

/** IDs whose source can change because of either authored keys or a placed
 * assembly clip. Linked-scene IDs are resolved on the materialized view. */
export function animatedAssetElementIds(project: Project): Set<string> {
  const composed = materializeScenePlacements(project);
  const placed = collectAssemblyClipTracks(composed);
  return new Set(composed.elements.filter(element => element.tracks.some(track => track.property === 'assetId')
    || placed.get(element.id)?.some(track => track.property === 'assetId')).map(element => element.id));
}

function transitionTimes(element: StoryElement, tracks: PlacedAssemblyTrack[], start: number, end: number): number[] {
  const times = [start, end];
  const add = (at: number) => { if (Number.isFinite(at) && at > start + EPSILON && at < end - EPSILON) times.push(at); };
  for (const track of element.tracks) if (track.property === 'assetId') {
    for (const key of track.keyframes) add(element.start + key.time);
  }
  const sorted = tracks.filter(track => track.property === 'assetId').sort((a, b) => a.start - b.start || a.order - b.order);
  let coveredUntil = -Infinity;
  for (const track of sorted) {
    add(track.start); add(track.end);
    if (track.sourceDuration > 0 && track.duration > 0) {
      if (track.loop) {
        const cycle = track.sourceDuration * track.timeScale;
        if (cycle > 0) {
          const first = Math.max(0, Math.floor((start - track.start) / cycle));
          const last = Math.min(Math.ceil((track.end - track.start) / cycle), Math.ceil((end - track.start) / cycle));
          for (let repeat = first; repeat <= last; repeat++) {
            add(track.start + repeat * cycle);
            for (const key of track.track.keyframes) add(track.start + (repeat * track.sourceDuration + key.time) * track.timeScale);
          }
        }
      } else for (const key of track.track.keyframes) add(track.start + key.time / track.sourceDuration * track.duration);
    }
    if (track.start < coveredUntil - EPSILON) {
      const overlapEnd = Math.min(coveredUntil, track.end);
      const setting = track.textureOverlap ?? DEFAULT_TEXTURE_CONFLICT;
      if (setting.mode === 'single') add(track.start + (overlapEnd - track.start) * setting.switchPoint);
      else if (setting.mode === 'alternate' && setting.switchesPerSecond > 0) {
        const rate = setting.switchesPerSecond;
        const first = Math.ceil(track.start * rate - EPSILON);
        const last = Math.floor(overlapEnd * rate + EPSILON);
        for (let phase = first; phase <= last; phase++) add(phase / rate);
      }
    }
    coveredUntil = Math.max(coveredUntil, track.end);
  }
  return times.sort((a, b) => a - b).filter((time, index, all) => index === 0 || time - all[index - 1] > EPSILON);
}

/** Resolve a video's embedded sound at exactly the same project time as its
 * visual texture. Intervals include key/clip boundaries and the absolute-clock
 * overlap cadence; bisection locates an eased discrete switch between keys. */
export function mediaAudioSegments(project: Project, start = 0, end = project.duration, previewId?: string): MediaAudioSegment[] {
  const composed = materializeScenePlacements(project);
  const elements = previewId ? composed.elements.map(element => element.id === previewId ? {...element, hidden: false} : element) : composed.elements;
  const view = previewId ? {...composed, elements} : composed;
  const assets = new Map(view.assets.filter(audioAsset).map(asset => [asset.id, asset]));
  const placed = collectAssemblyClipTracks(view);
  const dynamic = new Set(elements.filter(element => element.tracks.some(track => track.property === 'assetId')
    || placed.get(element.id)?.some(track => track.property === 'assetId')).map(element => element.id));
  const at = new Map<number, Map<string, string | undefined>>();
  const selectedAsset = (id: string, time: number): string | undefined => {
    let frame = at.get(time);
    if (!frame) {
      frame = new Map(evaluateProject(view, time).map(element => [element.id, element.assetId]));
      at.set(time, frame);
    }
    const assetId = frame.get(id);
    return assetId && assets.has(assetId) ? assetId : undefined;
  };
  const result: MediaAudioSegment[] = [];
  for (const element of elements) {
    if (previewId ? element.id !== previewId : element.muted || element.hidden) continue;
    const window = elementWindow(view, element);
    if (!window) continue;
    const first = Math.max(start, window.start), last = Math.min(end, window.end);
    if (last <= first) continue;
    if (!dynamic.has(element.id)) {
      const asset = assets.get(element.assetId ?? '');
      if (asset) result.push({element, asset, start: first, end: last});
      continue;
    }
    const tracks = placed.get(element.id) ?? [];
    const anchors = transitionTimes(element, tracks, first, last);
    const cuts = anchors.slice();
    for (let index = 0; index < anchors.length - 1; index++) {
      const left = anchors[index], right = anchors[index + 1];
      const delta = Math.min(1e-7, (right - left) / 8);
      const from = selectedAsset(element.id, left + delta);
      const to = selectedAsset(element.id, right - delta);
      if (from === to) continue;
      let low = left, high = right;
      for (let iteration = 0; iteration < 36 && high - low > 1e-6; iteration++) {
        const middle = (low + high) / 2;
        if (selectedAsset(element.id, middle) === from) low = middle;
        else high = middle;
      }
      cuts.push(high);
    }
    cuts.sort((a, b) => a - b);
    let previous: MediaAudioSegment | undefined;
    for (let index = 0; index < cuts.length - 1; index++) {
      const intervalStart = cuts[index], intervalEnd = cuts[index + 1];
      if (intervalEnd - intervalStart <= EPSILON) continue;
      const asset = assets.get(selectedAsset(element.id, (intervalStart + intervalEnd) / 2) ?? '');
      if (!asset) { previous = undefined; continue; }
      if (previous?.asset.id === asset.id && Math.abs(previous.end - intervalStart) < 1e-6) previous.end = intervalEnd;
      else {
        previous = {element, asset, start: intervalStart, end: intervalEnd};
        result.push(previous);
      }
    }
  }
  return result;
}
