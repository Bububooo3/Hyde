import { evaluateElement } from './engine';
import { sceneIdAt, uid } from './model';
import type { AnimProperty, Asset, Keyframe, Project, StoryElement, Track } from './model';

const EPSILON = 1e-7;
const finite = (value: number) => Number.isFinite(value);
const clip = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function mediaElement(project: Project, id: string): StoryElement {
  const element = project.elements.find(item => item.id === id);
  const asset = project.assets.find(item => item.id === element?.assetId);
  if (!element || !asset || !['audio', 'video'].includes(asset.kind)) throw new Error('Select a clip with an audio or video source.');
  return element;
}

function sourceDuration(project: Project, element: StoryElement): number {
  const duration = project.assets.find(asset => asset.id === element.assetId)?.duration;
  if (!duration || !finite(duration)) throw new Error('The source duration is unavailable.');
  return duration;
}

export function sourceWindow(element: StoryElement, assetDuration: number): { inTime: number; outTime: number } {
  const inTime = clip(element.sourceOffset ?? 0, 0, assetDuration);
  return { inTime, outTime: clip(inTime + element.duration * (element.speed ?? 1), inTime, assetDuration) };
}

/** Move a recorded take without altering its source audio or effect chain.
 * The stored correction is relative to the capture position, so it can be reset. */
export function setRecordingOffset(base:Project,id:string,offset:number):Project{
  const original=base.elements.find(item=>item.id===id&&item.kind==='audio'&&item.recorded);
  if(!original)throw new Error('Select a microphone recording to adjust its alignment.');
  if(!finite(offset)||Math.abs(offset)>5)throw new Error('Recording offset must be between −5 and +5 seconds.');
  const start=original.start+offset-(original.recordingOffset??0);
  if(start<0)throw new Error('The recording cannot begin before the project starts.');
  const next=structuredClone(base),element=next.elements.find(item=>item.id===id)!;
  element.start=start;element.recordingOffset=offset;element.sceneId=sceneIdAt(next,start);
  next.duration=Math.max(next.duration,start+element.duration);
  return next;
}

/** Keep the chosen source range when changing playback speed. Picture, embedded
 * sound, fades, and clip-local keyframes still share the same timeline span. */
export function setMediaSpeed(base:Project,id:string,speed:number):Project {
  const original=mediaElement(base,id);
  if(!finite(speed)||speed<.25||speed>4)throw new Error('Playback speed must be between 0.25 and 4.');
  const next=structuredClone(base),element=next.elements.find(item=>item.id===id)!;
  if(!original.loop){
    const assetLength=sourceDuration(base,original);
    const window=sourceWindow(original,assetLength);
    const duration=(window.outTime-window.inTime)/speed;
    if(duration+EPSILON<1/base.fps)throw new Error('This speed would make the clip shorter than one frame.');
    const factor=duration/original.duration;
    element.duration=duration;
    element.fadeIn=(original.fadeIn??0)*factor;
    element.fadeOut=(original.fadeOut??0)*factor;
    for(const track of element.tracks)for(const key of track.keyframes)key.time*=factor;
  }
  element.speed=speed;
  next.duration=Math.max(next.duration,element.start+element.duration);
  return next;
}

/** Use source seconds so trim controls remain meaningful when clip speed changes. */
export function setMediaSourceWindow(base: Project, id: string, inTime: number, outTime: number): Project {
  const original = mediaElement(base, id);
  if (original.loop) throw new Error('Turn off Loop before setting a source range.');
  const assetDuration = sourceDuration(base, original);
  const speed = original.speed ?? 1;
  if (!finite(inTime) || !finite(outTime) || !finite(speed) || speed <= 0 || inTime < 0 || outTime > assetDuration + EPSILON || outTime <= inTime) {
    throw new Error('The source range must fit inside the recording and have a positive length.');
  }
  const duration = (outTime - inTime) / speed;
  if (duration + EPSILON < 1 / base.fps) throw new Error('The source range must be at least one project frame.');
  const project = structuredClone(base);
  const element = project.elements.find(item => item.id === id)!;
  element.sourceOffset = inTime;
  element.duration = duration;
  element.fadeIn = Math.min(element.fadeIn ?? 0, duration);
  element.fadeOut = Math.min(element.fadeOut ?? 0, duration);
  project.duration = Math.max(project.duration, element.start + duration);
  return project;
}

export function setMediaFades(base: Project, id: string, fadeIn: number, fadeOut: number): Project {
  const original = mediaElement(base, id);
  if (!finite(fadeIn) || !finite(fadeOut) || fadeIn < 0 || fadeOut < 0 || fadeIn > original.duration || fadeOut > original.duration) {
    throw new Error('Fades must fit inside the clip.');
  }
  const project = structuredClone(base);
  const element = project.elements.find(item => item.id === id)!;
  element.fadeIn = fadeIn;
  element.fadeOut = fadeOut;
  return project;
}

/** Linear amplitude fades. Overlapping fades multiply, avoiding a jump at either edge. */
export function fadeGainAt(element: StoryElement, time: number): number {
  if (!finite(time) || time < element.start || time > element.start + element.duration) return 0;
  const local = time - element.start;
  const fadeIn = Math.max(0, element.fadeIn ?? 0);
  const fadeOut = Math.max(0, element.fadeOut ?? 0);
  const incoming = fadeIn > 0 ? clip(local / fadeIn, 0, 1) : 1;
  const outgoing = fadeOut > 0 ? clip((element.duration - local) / fadeOut, 0, 1) : 1;
  return incoming * outgoing;
}

function cloneTrack(track: Track): Track {
  return { property: track.property, keyframes: track.keyframes.map(key => ({ ...key, id: uid() })) };
}

function copyMediaElement(element: StoryElement): StoryElement {
  return {
    ...structuredClone(element), id: uid(), name: `${element.name} copy`,
    tracks: element.tracks.map(cloneTrack),
    audioEffects: element.audioEffects?.map(effect => ({ ...effect, id: uid() })),
  };
}

/** Duplicate in the same lane using the same embedded source asset. */
export function duplicateMediaClip(base: Project, id: string, start?: number): { project: Project; clipId: string } {
  const original = mediaElement(base, id);
  const newStart = start ?? original.start + original.duration;
  if (!finite(newStart) || newStart < 0) throw new Error('The duplicate start must be zero or later.');
  const project = structuredClone(base);
  const copy = copyMediaElement(original);
  copy.start = newStart;
  const index = project.elements.findIndex(item => item.id === id);
  project.elements.splice(index + 1, 0, copy);
  project.duration = Math.max(project.duration, copy.start + copy.duration);
  return { project, clipId: copy.id };
}

function boundaryValue(element: StoryElement, property: AnimProperty, time: number): number | string {
  const evaluated = evaluateElement(element, time) ?? element;
  return evaluated[property] as number | string;
}

function boundaryKey(value: number | string, time: number, previous?: Keyframe): Keyframe {
  return { id: uid(), time, value, easing: previous?.easing ?? 'linear', direction: previous?.direction ?? 'inOut', mode: previous?.mode ?? 'smooth', steps: previous?.steps };
}

function splitTracks(element: StoryElement, offset: number, time: number): { left: Track[]; right: Track[] } {
  const left: Track[] = [], right: Track[] = [];
  for (const track of element.tracks) {
    const keys = [...track.keyframes].sort((a, b) => a.time - b.time);
    const previous = keys.filter(key => key.time <= offset + EPSILON).at(-1);
    const value = boundaryValue(element, track.property, time);
    const before = keys.filter(key => key.time < offset - EPSILON).map(key => ({ ...key }));
    const after: Keyframe[] = keys.filter(key => key.time > offset + EPSILON).map(key => ({ ...key, id: uid(), time: key.time - offset }));
    before.push(boundaryKey(value, offset, previous));
    after.unshift(boundaryKey(value, 0, previous));
    left.push({ property: track.property, keyframes: before });
    right.push({ property: track.property, keyframes: after });
  }
  return { left, right };
}

/** Split a non-looping audio or video clip without unlinking its picture and sound. */
export function splitMediaClip(base: Project, id: string, at: number): { project: Project; rightId: string } {
  const original = mediaElement(base, id);
  if (original.loop) throw new Error('Turn off Loop before splitting this clip.');
  const frame = 1 / base.fps;
  if (!finite(at) || at < original.start + frame - EPSILON || at > original.start + original.duration - frame + EPSILON) {
    throw new Error('Split at least one frame away from each clip edge.');
  }
  const offset = at - original.start;
  const project = structuredClone(base);
  const left = project.elements.find(item => item.id === id)!;
  const right = copyMediaElement(original);
  right.name = original.name;
  right.start = at;
  right.duration = original.duration - offset;
  right.sourceOffset = (original.sourceOffset ?? 0) + offset * (original.speed ?? 1);
  left.duration = offset;
  const split = splitTracks(original, offset, at);
  left.tracks = split.left;
  right.tracks = split.right;
  // Fades remain at the outside boundaries; a split does not create an
  // unintended fade to silence at the new edit point.
  left.fadeIn = Math.min(original.fadeIn ?? 0, left.duration);
  left.fadeOut = 0;
  right.fadeIn = 0;
  right.fadeOut = Math.min(original.fadeOut ?? 0, right.duration);
  const index = project.elements.findIndex(item => item.id === id);
  project.elements.splice(index + 1, 0, right);
  return { project, rightId: right.id };
}

/** Peak envelope from decoded PCM; the waveform cache retains only these small arrays. */
export function waveformPeaks(buffer: AudioBuffer, bins = 192): number[] {
  const count = Math.max(1, Math.min(1024, Math.floor(bins)));
  const peaks = new Array<number>(count).fill(0);
  if (!buffer.length || !buffer.numberOfChannels) return peaks;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  for (let index = 0; index < count; index++) {
    const from = Math.floor(index * buffer.length / count);
    const to = Math.max(from + 1, Math.floor((index + 1) * buffer.length / count));
    const stride = Math.max(1, Math.floor((to - from) / 256));
    let peak = 0;
    for (const samples of channels) for (let sample = from; sample < to; sample += stride) peak = Math.max(peak, Math.abs(samples[sample] ?? 0));
    peaks[index] = clip(peak, 0, 1);
  }
  return peaks;
}

const waveformCache = new Map<string, Promise<{ peaks: number[]; duration: number }>>();
/** Browser decoding is best effort for embedded video; audio recordings use the same path. */
export function loadWaveform(asset: Asset): Promise<{ peaks: number[]; duration: number }> {
  const cached = waveformCache.get(asset.id);
  if (cached) return cached;
  const pending = (async () => {
    const response = await fetch(asset.dataUrl);
    const bytes = await response.arrayBuffer();
    const context = new AudioContext();
    try {
      const buffer = await context.decodeAudioData(bytes);
      return { peaks: waveformPeaks(buffer), duration: buffer.duration };
    } finally { await context.close(); }
  })();
  waveformCache.set(asset.id, pending);
  pending.catch(() => waveformCache.delete(asset.id));
  if (waveformCache.size > 24) waveformCache.delete(waveformCache.keys().next().value!);
  return pending;
}
