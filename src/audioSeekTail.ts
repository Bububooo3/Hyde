import { connectAudioEffects, MAX_EFFECT_TAIL } from './audioEffects';
import { clipEffectTail } from './audioEffectTail';
import { fadeGainAt } from './audioClipEditing';
import { preparedSourceTime, type AudioPitchPlan } from './audioPitch';
import { evaluateElement, evaluateProject, sourceTime } from './engine';
import type { MediaAudioSegment } from './mediaAudioSegments';
import type { Project, StoryElement } from './model';

const SAMPLE_RATE = 48_000;
const EPSILON = 1 / SAMPLE_RATE;

export interface PreparedSeekClip {
  segment: MediaAudioSegment;
  buffer: AudioBuffer;
  originalDuration: number;
  plan: AudioPitchPlan;
}

/** Only input that can leave an audible effect tail at the seek timestamp
 * needs reconstruction. The input lookback never exceeds MAX_EFFECT_TAIL. */
export function seekEffectHistory(segments: readonly MediaAudioSegment[], time: number): {
  segments: MediaAudioSegment[];
  tailDuration: number;
} {
  if (!Number.isFinite(time) || time <= 0) return { segments: [], tailDuration: 0 };
  const historyStart = Math.max(0, time - MAX_EFFECT_TAIL);
  const eligible: MediaAudioSegment[] = [];
  let tailDuration = 0;
  for (const segment of segments) {
    const tail = clipEffectTail(segment.element.audioEffects);
    if (tail <= 0 || segment.start >= time || segment.end <= historyStart || segment.end + tail <= time + EPSILON) continue;
    eligible.push(segment);
    tailDuration = Math.max(tailDuration, Math.min(time, segment.end) + tail - time);
  }
  return { segments: eligible, tailDuration: Math.min(MAX_EFFECT_TAIL, tailDuration) };
}

/** Render only the previous four seconds into a short tail that starts at the
 * new playhead time. The normal live graph begins at that same time, so no old
 * dry signal is replayed and future automation remains editable. */
export async function renderSeekEffectTail(
  project: Project,
  time: number,
  clips: readonly PreparedSeekClip[],
  previewId?: string,
): Promise<AudioBuffer | null> {
  const { segments, tailDuration } = seekEffectHistory(clips.map(clip => clip.segment), time);
  if (!segments.length || tailDuration <= 0 || typeof OfflineAudioContext === 'undefined') return null;
  const selected = new Set(segments);
  const historyStart = Math.max(0, time - MAX_EFFECT_TAIL);
  const frameCount = Math.max(1, Math.ceil((time - historyStart + tailDuration) * SAMPLE_RATE));
  const context = new OfflineAudioContext(2, frameCount, SAMPLE_RATE);
  const graphs: ReturnType<typeof connectAudioEffects>[] = [];
  const nodes: AudioNode[] = [];
  const poses = new Map<number, Map<string, StoryElement>>();
  const volumeAt = (element: StoryElement, at: number): number => {
    const evaluatedAt = Math.max(element.start, Math.min(at, element.start + element.duration - EPSILON));
    if (previewId === element.id) {
      const pose = evaluateElement({ ...element, hidden: false }, evaluatedAt);
      return Math.max(0, pose?.volume ?? element.volume ?? 1);
    }
    let frame = poses.get(evaluatedAt);
    if (!frame) {
      frame = new Map(evaluateProject(project, evaluatedAt).map(pose => [pose.id, pose]));
      poses.set(evaluatedAt, frame);
    }
    const pose = frame.get(element.id);
    return pose && !pose.muted ? Math.max(0, pose.volume ?? 1) : 0;
  };
  let sourceCount = 0;
  try {
    for (const clip of clips) {
      if (!selected.has(clip.segment)) continue;
      const { segment, buffer, originalDuration, plan } = clip;
      const element = segment.element;
      const clipStart = Math.max(historyStart, segment.start);
      const clipEnd = Math.min(time, segment.end);
      if (clipEnd - clipStart <= EPSILON) continue;
      const offset = preparedSourceTime(sourceTime(element, clipStart, originalDuration), plan);
      if (!element.loop && offset >= buffer.duration) continue;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = plan.playbackRate;
      source.loop = !!element.loop;
      if (source.loop) {
        source.loopStart = Math.min(preparedSourceTime(element.sourceOffset ?? 0, plan), buffer.duration);
        source.loopEnd = buffer.duration;
      }
      const fade = context.createGain(), volume = context.createGain();
      nodes.push(source, fade, volume);
      source.connect(fade);
      const graph = connectAudioEffects(context, fade, volume, element.audioEffects);
      graphs.push(graph);
      volume.connect(context.destination);
      const startAt = clipStart - historyStart;
      const stopAt = clipEnd - historyStart;
      fade.gain.setValueAtTime(fadeGainAt(element, clipStart), startAt);
      volume.gain.setValueAtTime(volumeAt(element, clipStart), startAt);
      for (let at = clipStart + 1 / 60; at < clipEnd; at += 1 / 60) {
        const clock = at - historyStart;
        fade.gain.linearRampToValueAtTime(fadeGainAt(element, at), clock);
        volume.gain.linearRampToValueAtTime(volumeAt(element, at), clock);
      }
      fade.gain.linearRampToValueAtTime(fadeGainAt(element, clipEnd), stopAt);
      const finalVolume = volumeAt(element, Math.max(clipStart, clipEnd - EPSILON));
      volume.gain.linearRampToValueAtTime(finalVolume, stopAt);
      volume.gain.setValueAtTime(finalVolume, Math.min(frameCount / SAMPLE_RATE, stopAt + graph.tailSeconds));
      source.start(startAt, offset);
      source.stop(stopAt);
      sourceCount++;
    }
    if (!sourceCount) return null;
    const rendered = await context.startRendering();
    const first = Math.round((time - historyStart) * SAMPLE_RATE);
    const length = Math.max(1, Math.round(tailDuration * SAMPLE_RATE));
    const output = context.createBuffer(2, length, SAMPLE_RATE);
    for (let channel = 0; channel < 2; channel++) {
      output.copyToChannel(rendered.getChannelData(channel).subarray(first, first + length), channel);
    }
    return output;
  } finally {
    for (const graph of graphs) graph.dispose();
    for (const node of nodes) node.disconnect();
  }
}
