import {elementWindow,type Project} from './model';
import { evaluateElement, evaluateProject, sourceTime } from './engine';
import { connectAudioEffects } from './audioEffects';
import type { AudioEffectsGraph } from './audioEffects';
import { fadeGainAt } from './audioClipEditing';
import {audioPitchPlan,prepareAudioBuffer,preparedSourceTime} from './audioPitch';
import {materializeScenePlacements} from './scenePlacement';
import {mediaAudioSegments} from './mediaAudioSegments';
import { MAX_EFFECT_TAIL } from './audioEffects';
import { renderSeekEffectTail, seekEffectHistory } from './audioSeekTail';

interface ActiveClip {
  id: string;
  gain: GainNode;
  fadeGain: GainNode;
  graph: AudioEffectsGraph;
  tail: number;
  lastVolume: number;
  end: number;
  disposed: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

interface PreviewSession {
  id: string;
  onEnded?: () => void;
}

/** Playback-only audio graph. Sources are rebuilt from an explicit timeline anchor. */
export class AudioTransport {
  private context: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private sources: AudioBufferSourceNode[] = [];
  private gains: ActiveClip[] = [];
  private generation = 0;
  private anchor = 0;
  private offset = 0;
  private loading = new Map<string, Promise<AudioBuffer>>();
  private prepared = new Map<string,Promise<AudioBuffer>>();
  private previewSession: PreviewSession | null = null;
  private seekTailPlaying = false;
  get time() { return this.context ? this.offset + Math.max(0, this.context.currentTime - this.anchor) : this.offset; }
  get ready() { return !!this.context && this.context.state === 'running'; }
  get previewingId() { return this.previewSession?.id ?? null; }

  /** Isolate one existing timeline clip without changing its saved mute state.
   * Starting another transport operation cancels this preview and notifies the UI. */
  async preview(project: Project, elementId: string, time?: number, onEnded?: () => void) {
    const composed = materializeScenePlacements(project);
    const element = composed.elements.find(item => item.id === elementId);
    const window = element ? elementWindow(composed, element) : null;
    if (!element || !window || !mediaAudioSegments(composed, window.start, window.end, elementId).length) {
      throw new Error('Select an audio object with a visible clip to preview.');
    }
    const start = time !== undefined && Number.isFinite(time) && time >= window.start && time < window.end ? time : window.start;
    const session = { id: elementId, onEnded };
    try { await this.start(composed, start, session); }
    catch (error) {
      if (this.previewSession === session) this.stop();
      throw error;
    }
  }

  async play(project: Project, time: number) {
    await this.start(project, time);
  }

  private async start(project: Project, time: number, preview?: PreviewSession) {
    project=materializeScenePlacements(project);
    this.stop();
    this.previewSession = preview ?? null;
    const token = this.generation;
    this.context ??= new AudioContext();
    await this.context.resume();
    if (token !== this.generation) return;
    const ctx = this.context;
    const segments = mediaAudioSegments(project, Math.max(0, time - MAX_EFFECT_TAIL), project.duration, preview?.id);
    const audible = segments.filter(segment => segment.end > time);
    const history = seekEffectHistory(segments, time).segments;
    const historySet = new Set(history);
    const decoded = await Promise.all([...new Set([...audible, ...history])].map(async segment => {
      const {element:e,asset}=segment;
      let buffer = this.buffers.get(asset.id);
      if (!buffer) {
        let pending = this.loading.get(asset.id);
        if (!pending) {
          pending = fetch(asset.dataUrl).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b));
          this.loading.set(asset.id, pending);
        }
        try { buffer = await pending; this.buffers.set(asset.id, buffer); }
        catch { return null; }
        finally { this.loading.delete(asset.id); }
      }
      const plan=audioPitchPlan(e);
      const originalDuration=buffer.duration;
      if(plan.processed){
        const key=`${asset.id}:${plan.processSpeed}:${plan.pitchSemitones}`;
        let ready=this.prepared.get(key);
        if(!ready){ready=prepareAudioBuffer(ctx,buffer,plan);this.prepared.set(key,ready);ready.catch(()=>this.prepared.delete(key));}
        buffer=await ready;
      }
      return {e, buffer,originalDuration,plan,segment};
    }));
    if (token !== this.generation) return;
    let seekTail: AudioBuffer | null = null;
    if (history.length) {
      try {
        seekTail = await renderSeekEffectTail(project, time, decoded.filter((item): item is NonNullable<typeof item> =>
          !!item && historySet.has(item.segment)), preview?.id);
      } catch (error) {
        // Offline reconstruction is optional; a failed tail must never prevent
        // the current-time live sources from playing.
        console.warn('Could not reconstruct the audio effect tail at this seek.', error);
      }
    }
    if (token !== this.generation) return;
    this.offset = time; this.anchor = ctx.currentTime + .025;
    if (seekTail) {
      const tailSource = ctx.createBufferSource();
      tailSource.buffer = seekTail;
      tailSource.connect(ctx.destination);
      this.seekTailPlaying = true;
      tailSource.onended = () => {
        tailSource.disconnect();
        if (token !== this.generation) return;
        this.seekTailPlaying = false;
        if (preview && this.previewSession === preview && token === this.generation && this.gains.every(other => other.disposed)) this.stop();
      };
      tailSource.start(this.anchor);
      tailSource.stop(this.anchor + seekTail.duration);
      this.sources.push(tailSource);
    }
    for (const item of decoded) {
      if (!item) continue;
      const {e,buffer,originalDuration,plan,segment} = item;
      if (segment.end <= time) continue;
      const start=Math.max(time,segment.start);
      const sourceOffset = preparedSourceTime(sourceTime(e,start,originalDuration),plan);
      if (sourceOffset >= buffer.duration) continue;
      const source = ctx.createBufferSource(); source.buffer = buffer; source.playbackRate.value = plan.playbackRate; source.loop = !!e.loop;
      if(e.loop){source.loopStart=Math.min(preparedSourceTime(e.sourceOffset??0,plan),buffer.duration);source.loopEnd=buffer.duration;}
      const fadeGain = ctx.createGain();
      fadeGain.gain.value = fadeGainAt(e, Math.max(time, e.start));
      source.connect(fadeGain);
      const gain = ctx.createGain(); gain.gain.value = e.volume ?? 1;
      const graph = connectAudioEffects(ctx, fadeGain, gain, e.audioEffects);
      gain.connect(ctx.destination);
      const active: ActiveClip = {id:e.id,gain,fadeGain,graph,tail:graph.tailSeconds,lastVolume:e.volume??1,end:segment.end,disposed:false};
      source.onended = () => {
        if (active.disposed || active.cleanupTimer !== undefined) return;
        active.cleanupTimer = setTimeout(() => {
          if (active.disposed) return;
          active.disposed = true;
          graph.dispose(); fadeGain.disconnect(); gain.disconnect();
          if (preview && this.previewSession === preview && token === this.generation && !this.seekTailPlaying && this.gains.every(other => other.disposed)) this.stop();
        }, Math.ceil(graph.tailSeconds * 1000));
      };
      source.start(this.anchor + Math.max(0,start-time), sourceOffset);
      source.stop(this.anchor + segment.end - time);
      this.sources.push(source); this.gains.push(active);
    }
    if (preview && !this.gains.length && !this.seekTailPlaying) {
      this.stop();
      throw new Error('This audio object could not be decoded for preview.');
    }
    this.update(project,time);
  }
  update(project: Project, time: number) {
    project=materializeScenePlacements(project);
    const elements = evaluateProject(project,time);
    for (const g of this.gains) {
      if (g.disposed) continue;
      const evaluated = elements.find(v=>v.id===g.id);
      const original = project.elements.find(v=>v.id===g.id);
      const previewed = this.previewSession?.id === g.id;
      const audible = original && (previewed || !original.muted && !original.hidden);
      // Hidden/muted authoring flags do not prevent an explicitly requested
      // preview, but the original element still supplies its automation.
      const pose = previewed && original ? evaluateElement({...original,hidden:false},time) : evaluated;
      g.fadeGain.gain.value = audible ? fadeGainAt(original,time) : 0;
      if (time < g.end && pose && (previewed || !pose.muted)) g.lastVolume = pose.volume ?? 1;
      // A source's effect tail can continue just past its visible clip boundary.
      const inTail = audible && time >= g.end && time < g.end + g.tail;
      g.gain.gain.value = audible && time < g.end && pose && (previewed || !pose.muted) ? g.lastVolume : inTail ? g.lastVolume : 0;
    }
  }
  stop() {
    this.generation++;
    const preview = this.previewSession;
    this.previewSession = null;
    for (const s of this.sources) { try { s.stop(); } catch { /* source already ended */ } s.disconnect(); }
    this.sources=[];
    for(const g of this.gains) {
      g.disposed = true;
      if (g.cleanupTimer !== undefined) clearTimeout(g.cleanupTimer);
      g.graph.dispose(); g.fadeGain.disconnect(); g.gain.disconnect();
    }
    this.gains=[];
    this.seekTailPlaying = false;
    preview?.onEnded?.();
  }
  destroy() {this.stop(); void this.context?.close(); this.context=null; this.buffers.clear();this.prepared.clear();}
}
