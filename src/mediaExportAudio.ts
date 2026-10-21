import {type Project,type StoryElement} from './model';
import { evaluateElement, sourceTime } from './engine';
import { connectAudioEffects, MAX_EFFECT_TAIL } from './audioEffects';
import { clipEffectTail } from './audioEffectTail';
import {audioPitchPlan,prepareAudioBuffer,preparedSourceTime} from './audioPitch';
import {materializeScenePlacements} from './scenePlacement';
import {mediaAudioSegments} from './mediaAudioSegments';

const SAMPLE_RATE = 48_000;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export { clipEffectTail } from './audioEffectTail';

export function hasProjectAudio(project: Project, start = 0, end = project.duration): boolean {
  return mediaAudioSegments(project,start,end).length > 0;
}

export interface ProjectEffectTail {
  elementId: string;
  start: number;
  end: number;
}

/** Tail spans are presentation data for the editor and the same bounded end
 * times used by offline export. They do not change a clip's authored length. */
export function projectEffectTails(project: Project, rangeEnd = project.duration): ProjectEffectTail[] {
  return mediaAudioSegments(project,0,rangeEnd).flatMap(segment => {
    const tail = clipEffectTail(segment.element.audioEffects);
    return tail > 0 ? [{ elementId:segment.element.id, start:segment.end, end:segment.end + tail }] : [];
  });
}

/** Exporting the full project includes finite effects that continue after its final frame. */
export function projectAudioTail(project: Project, rangeEnd: number): number {
  if (Math.abs(rangeEnd - project.duration) > 1 / Math.max(1, project.fps)) return 0;
  return projectEffectTails(project,rangeEnd).reduce((largest, tail) =>
    tail.start <= rangeEnd && tail.end > rangeEnd ? Math.max(largest,tail.end-rangeEnd) : largest,0);
}

function gainAt(element: StoryElement, time: number): number {
  const evaluated = evaluateElement(element, Math.min(time, element.start + element.duration));
  const base = Math.max(0, evaluated?.volume ?? element.volume ?? 1);
  const local = clamp(time - element.start, 0, element.duration);
  const fadeIn = Math.max(0, element.fadeIn ?? 0);
  const fadeOut = Math.max(0, element.fadeOut ?? 0);
  const inScale = fadeIn > 0 ? clamp(local / fadeIn, 0, 1) : 1;
  const outScale = fadeOut > 0 ? clamp((element.duration - local) / fadeOut, 0, 1) : 1;
  return base * Math.min(inScale, outScale);
}

/**
 * Render an exact-time stereo mix. A short preroll reconstructs bounded effect
 * history at the range start; the same effect definitions drive live playback.
 */
export async function renderExportAudio(project: Project, start: number, end: number, tail: number, signal?: AbortSignal): Promise<AudioBuffer | null> {
  project=materializeScenePlacements(project);
  const clips = mediaAudioSegments(project,Math.max(0,start-MAX_EFFECT_TAIL),end).filter(segment =>
    segment.start < end && segment.end + clipEffectTail(segment.element.audioEffects) > Math.max(0,start-MAX_EFFECT_TAIL));
  if (!clips.length) return null;
  if (typeof OfflineAudioContext === 'undefined') throw new Error('This browser cannot render audio offline.');
  const prerollStart = Math.max(0, start - MAX_EFFECT_TAIL);
  const renderEnd = end + tail;
  const frameCount = Math.max(1, Math.ceil((renderEnd - prerollStart) * SAMPLE_RATE));
  const context = new OfflineAudioContext(2, frameCount, SAMPLE_RATE);
  const decoded = new Map<string, AudioBuffer>();
  const prepared = new Map<string,AudioBuffer>();
  const graphs: ReturnType<typeof connectAudioEffects>[] = [];
  for (const segment of clips) {
    if (signal?.aborted) throw new DOMException('Export canceled.', 'AbortError');
    const {element,asset}=segment;
    let buffer = decoded.get(asset.id);
    if (!buffer) {
      try {
        const response = await fetch(asset.dataUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        buffer = await context.decodeAudioData(await response.arrayBuffer());
      } catch {
        throw new Error(`Could not decode audio from ${asset.name}. Choose a browser that supports this media format.`);
      }
      decoded.set(asset.id, buffer);
    }
    const originalDuration=buffer.duration;
    const plan=audioPitchPlan(element);
    if(plan.processed){
      const key=`${asset.id}:${plan.processSpeed}:${plan.pitchSemitones}`;
      let ready=prepared.get(key);
      if(!ready){ready=await prepareAudioBuffer(context,buffer,plan,signal);prepared.set(key,ready);}
      buffer=ready;
    }
    const clipStart = Math.max(segment.start, prerollStart);
    const clipEnd = Math.min(segment.end, renderEnd);
    if (clipEnd <= clipStart) continue;
    const offset = preparedSourceTime(sourceTime(element, clipStart, originalDuration),plan);
    if (!element.loop && offset >= buffer.duration) continue;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = plan.playbackRate;
    source.loop = !!element.loop;
    if (source.loop) {
      source.loopStart = clamp(preparedSourceTime(element.sourceOffset ?? 0,plan), 0, Math.max(0, buffer.duration - .001));
      source.loopEnd = buffer.duration;
    }
    const gain = context.createGain();
    const graph = connectAudioEffects(context, source, gain, element.audioEffects);
    graphs.push(graph);
    gain.connect(context.destination);
    const startAt = clipStart - prerollStart;
    const stopAt = clipEnd - prerollStart;
    gain.gain.setValueAtTime(gainAt(element, clipStart), startAt);
    // The live transport updates volume once per animation frame. Linear ramps
    // keep that automation smooth in the offline render as well.
    for (let t = clipStart + 1 / 60; t < clipEnd; t += 1 / 60) {
      gain.gain.linearRampToValueAtTime(gainAt(element, t), t - prerollStart);
    }
    const finalGain = gainAt(element, clipEnd);
    gain.gain.linearRampToValueAtTime(finalGain, stopAt);
    gain.gain.setValueAtTime(finalGain, Math.min(renderEnd - prerollStart, stopAt + graph.tailSeconds));
    source.start(startAt, offset);
    source.stop(stopAt);
  }
  try {
    const rendered = await context.startRendering();
    if (signal?.aborted) throw new DOMException('Export canceled.', 'AbortError');
    const first = Math.round((start - prerollStart) * SAMPLE_RATE);
    const length = Math.max(1, Math.round((renderEnd - start) * SAMPLE_RATE));
    const output = context.createBuffer(2, length, SAMPLE_RATE);
    for (let channel = 0; channel < 2; channel++) output.copyToChannel(rendered.getChannelData(channel).subarray(first, first + length), channel);
    return output;
  } finally {
    for (const graph of graphs) graph.dispose();
  }
}
