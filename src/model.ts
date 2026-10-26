import type { PinCorners } from './projectivePin';
import type { MediaTransform } from './mediaTransform';

export type ElementKind = 'rectangle' | 'ellipse' | 'polygon' | 'text' | 'image' | 'video' | 'audio' | 'group';
export type AnimProperty = 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY' | 'opacity' | 'fill' | 'volume' | 'assetId';
export type EasingFamily = 'linear' | 'sine' | 'quad' | 'cubic' | 'quart' | 'quint' | 'expo' | 'circ' | 'back' | 'bounce' | 'elastic';
export type EasingDirection = 'in' | 'out' | 'inOut';
export interface Keyframe { id: string; time: number; value: number | string; easing: EasingFamily; direction: EasingDirection; mode: 'smooth' | 'hold' | 'stepped'; steps?: number; /** Fraction of a discrete key interval before switching. */ switchPoint?: number }
export interface Track { property: AnimProperty; keyframes: Keyframe[] }
/** An assembly-local animation definition. Track targets are stable element IDs
 * within the assembly subtree; instances reference the definition by ID. */
export interface AssemblyClipTrack extends Track { elementId: string }
export interface AssemblyAnimationClip { id: string; name: string; duration: number; tracks: AssemblyClipTrack[] }
/** Start is relative to the owning assembly root's start, so the complete
 * construction can move in time without retiming its internal animation. */
/** An override for the automatic transition into this instance. Omitted
 * properties tween linearly, and each part/property can be changed alone. */
export interface AssemblyGapTransition {
  elementId: string; property: AnimProperty; mode: 'tween' | 'hold';
  easing: EasingFamily; direction: EasingDirection;
  /** Raw fraction for a discrete texture switch across a positive gap. */
  switchPoint?: number;
}
/** A positive priority chooses this placed track over automatic overlap blending. */
export interface AssemblyTrackPriority { elementId: string; property: AnimProperty; priority: number }
/** The incoming placement decides how two different textures share an overlap. */
export interface AssemblyTextureOverlap {
  elementId: string;
  mode: 'alternate' | 'single' | 'holdOutgoing' | 'useIncoming';
  switchesPerSecond: number;
  /** Fraction of the overlap at which a single switch selects the incoming texture. */
  switchPoint: number;
}
export interface AssemblyClipInstance {
  id: string; clipId: string; start: number; duration: number; loop?: boolean;
  gapTransitions?: AssemblyGapTransition[];
  priorityOverrides?: AssemblyTrackPriority[];
  textureOverlaps?: AssemblyTextureOverlap[];
  /** Keyed tracks copied only when this placement is edited independently. */
  trackOverrides?: AssemblyClipTrack[];
}
export interface Asset { id: string; name: string; mime: string; kind: 'image' | 'video' | 'audio' | 'font'; dataUrl: string; duration?: number; licenseNotice?: string }
export interface Attachment { type: 'fixed' | 'hinge' | 'slider'; parentId: string; min?: number; max?: number }
export interface PathPoint { x: number; y: number; in?: {x: number; y: number}; out?: {x: number; y: number} }
/** Closed cubic contour in element-local, normalized coordinates. Missing
 * handles make a straight edge. */
export interface ShapeContour { points: PathPoint[] }
/** Each filled island can carry editable cutouts. All contours share one
 * element transform; older archives contain only `points` and optional holes. */
export interface ShapeIsland extends ShapeContour { holes?: ShapeContour[] }
export interface ShapePath extends ShapeIsland { islands?: ShapeIsland[] }
/** Procedural offsets run after keyed/assembly animation but before a part's
 * attachment constraint and parent transform. Times are element-local seconds. */
export interface MotionBase { id: string; enabled: boolean; start: number; duration: number }
export interface MotionPathPoint { x: number; y: number; in?: {x:number;y:number}; out?: {x:number;y:number} }
export interface FollowPathMotion extends MotionBase {
  type: 'followPath'; points: MotionPathPoint[]; loop: boolean; orient: boolean;
  easing: EasingFamily; direction: EasingDirection;
}
export interface OscillationMotion extends MotionBase {
  type: 'oscillation'; property: 'x'|'y'|'rotation'|'scaleX'|'scaleY'|'opacity';
  amplitude: number; frequency: number; phase: number; fadeIn: number; fadeOut: number;
}
export interface ShakeMotion extends MotionBase {
  type: 'shake'; seed: number; frequency: number; amplitudeX: number; amplitudeY: number;
  amplitudeRotation: number; smooth: boolean; fadeIn: number; fadeOut: number;
}
export type MotionBehavior = FollowPathMotion | OscillationMotion | ShakeMotion;
export interface TextAnimation {
  unit: 'word' | 'line';
  effect: 'reveal' | 'fade' | 'slide' | 'scale' | 'rotate' | 'wave' | 'scatter';
  /** In reveals or assembles the text; out removes or disperses it. */
  direction: 'in' | 'out';
  /** Seconds relative to the text element's start. Duration is per unit. */
  start: number; duration: number; stagger: number;
  easing: EasingFamily; easingDirection: EasingDirection;
  /** Distances and wave amplitude are local pixels; rotation uses degrees. */
  distance: number; seed: number; amplitude: number; frequency: number;
}
/** Move stable words between two live layouts sampled from the project clock. */
export interface TextReflow {
  preset: 'glide' | 'cascade';
  /** Seconds relative to the text element's start. */
  start: number; duration: number; stagger: number;
  easing: EasingFamily; easingDirection: EasingDirection;
}
export type AudioEffect =
  | { id: string; type: 'echo'; enabled: boolean; delay: number; feedback: number; mix: number }
  | { id: string; type: 'chorus'; enabled: boolean; rate: number; depth: number; delay: number; mix: number }
  | { id: string; type: 'compressor'; enabled: boolean; threshold: number; ratio: number; knee: number; attack: number; release: number }
  | { id: string; type: 'distortion'; enabled: boolean; drive: number; mix: number }
  | { id: string; type: 'equalizer'; enabled: boolean; low: number; mid: number; high: number }
  | { id: string; type: 'reverb'; enabled: boolean; seconds: number; decay: number; mix: number };
export type AudioEffectType = AudioEffect['type'];
/** A captured Pretext arrangement for shape-aware static text. Source text stays
 * editable; changing it explicitly replaces this snapshot. */
export interface StaticTextFlowSnapshot {
  mode: 'around' | 'inside';
  sourceText: string;
  fontFamily: string;
  fontSize: number;
  layoutWidth: number;
  capturedAt: number;
  lines: {text:string;width:number;x:number;y:number;start:{segmentIndex:number;graphemeIndex:number};end:{segmentIndex:number;graphemeIndex:number}}[];
  /** Interior flow also freezes its clipping contour in text-local pixels. */
  outline?: {x:number;y:number}[];
}
export interface StoryElement {
  id: string; name: string; kind: ElementKind; x: number; y: number; width: number; height: number;
  /** Source scene for editing/composition. Older projects omit this field. */
  sceneId?: string;
  rotation: number; scaleX: number; scaleY: number; pivotX: number; pivotY: number;
  fill: string; stroke: string; strokeWidth: number; opacity: number;
  shadow: { color: string; blur: number; x: number; y: number; size?: number; enabled: boolean };
  text?: string; fontFamily?: string; fontSize?: number; textLayout?: 'live' | 'static'; staticLayoutWidth?: number;
  /** Shape whose evaluated silhouette excludes text during layout. */
  flowAroundId?: string;
  /** How a referenced shape constrains the artistic text. Defaults to around. */
  textShapeMode?: 'around' | 'inside' | 'clip';
  staticTextFlow?: StaticTextFlowSnapshot;
  textAnimation?: TextAnimation;
  textReflow?: TextReflow;
  assetId?: string; mediaFit?: 'fill' | 'fit' | 'stretch'; mediaOpacity?: number;
  /** What to display after a non-looping video's source media is exhausted. */
  videoEndBehavior?: 'hold' | 'hide';
  /** Source image/video placement inside the element, independent of the shape. */
  mediaTransform?: MediaTransform;
  /** Image/video source warped into four element-local corners. */
  mediaPin?: PinCorners;
  start: number; duration: number; sourceOffset?: number; speed?: number; volume?: number;
  /** Captured microphone clips keep a reversible manual synchronization correction. */
  recorded?: boolean; recordingOffset?: number;
  /** Semitone adjustment in addition to any pitch change caused by linked speed. */
  pitchSemitones?: number;
  /** Defaults to true for older projects: audio pitch rises and falls with speed. */
  linkSpeedPitch?: boolean;
  /** Audio envelope length in project seconds, measured from each clip edge. */
  fadeIn?: number; fadeOut?: number;
  /** Ordered, clip-local audio processing. Omitted on older projects. */
  audioEffects?: AudioEffect[];
  muted?: boolean; loop?: boolean; locked?: boolean; hidden?: boolean;
  parentId?: string; attachment?: Attachment; tracks: Track[];
  /** Reusable internal animation, owned by an assembly root or single object. */
  assemblyClips?: AssemblyAnimationClip[]; clipInstances?: AssemblyClipInstance[];
  /** Ordered, additive, deterministic motion behaviors. */
  motionBehaviors?: MotionBehavior[];
  /** Legacy straight polygon vertices in local pixels. Editable paths supersede them. */
  points?: {x: number; y: number}[];
  shapePath?: ShapePath;
  /** Timeline-independent references to independently editable mask objects. */
  objectMask?: { mode: 'include' | 'exclude'; objectIds: string[] };
  section?: string; optimize?: 'auto' | 'motion' | 'static';
  /** Editor-only organization. This never changes stage transforms or drawing order. */
  folderId?: string;
}
export interface SceneFolder { id: string; name: string; parentId?: string }
export interface Caption { id: string; start: number; end: number; text: string; sceneId?: string }
export type CameraProperty = 'x' | 'y' | 'zoom' | 'rotation';
export interface CameraTrack { property: CameraProperty; keyframes: Keyframe[] }
export interface CameraState { x: number; y: number; zoom: number; rotation: number }
export interface SequenceCamera extends CameraState { tracks: CameraTrack[] }
export interface PlacementFrame {
  frame?: {x:number;y:number;width:number;height:number};
  frameFit?: 'fit'|'fill'|'stretch';
  /** Clockwise degrees around the placement frame center. */
  frameRotation?: number;
  opacity?: number;
}
export interface Sequence {
  id: string; name: string; start: number; duration: number; color: string; camera?: SequenceCamera;
  /** A placed instance of another source scene. Its source remains editable. */
  sourceSceneId?: string;
  /** Source interval, in seconds relative to the source scene's start. */
  sourceIn?: number; sourceOut?: number;
  /** Linked copies can be muted independently without muting their source. */
  muted?: boolean;
  /** Export-time audio overrides for particular source clips. */
  mutedSourceClipIds?: string[];
  /** Placement viewport in project coordinates; omitted means the whole stage. */
  frame?: {x:number;y:number;width:number;height:number};
  frameFit?: 'fit'|'fill'|'stretch';
  /** Clockwise degrees around the placement frame center. */
  frameRotation?: number;
  opacity?: number;
  /** Frozen nested viewports retained when a linked scene becomes independent. */
  frameStack?: PlacementFrame[];
}
export interface Project {
  format: 'hyde'; version: 1; id: string; name: string; width: number; height: number; fps: number;
  duration: number; background: string; elements: StoryElement[]; assets: Asset[];
  sequences: Sequence[]; captions: Caption[]; folders?: SceneFolder[]; updatedAt: string;
  /** Saved creator defaults for independently exported web players. */
  webPlayer?: WebPlayerSettings;
}
export interface WebPlayerSettings {
  posterTime: number;
  loop: boolean;
  controlsVisible: boolean;
  showSeek: boolean;
  showVolume: boolean;
  showFullscreen: boolean;
  showCaptions: boolean;
  showLoop: boolean;
}
export interface Assembly { format: 'hyde-assembly'; version: 1; name: string; elements: StoryElement[]; assets: Asset[] }
export const uid = () => crypto.randomUUID();
const PITCH_LINK_DEFAULT_KEY = 'hyde:link-speed-pitch-default';
/** A browser preference for newly imported audio, video, and voice recordings. */
export function getDefaultLinkSpeedPitch(): boolean {
  try { return globalThis.localStorage?.getItem(PITCH_LINK_DEFAULT_KEY) !== 'false'; }
  catch { return true; }
}
export function setDefaultLinkSpeedPitch(linked: boolean): void {
  try { globalThis.localStorage?.setItem(PITCH_LINK_DEFAULT_KEY, String(linked)); }
  catch { /* Private browsing or disabled storage leaves the session usable. */ }
}
export function createElement(kind: ElementKind, overrides: Partial<StoryElement> = {}): StoryElement {
  return { id: uid(), name: kind === 'text' ? 'Text' : kind[0].toUpperCase() + kind.slice(1), kind, x: 480, y: 270, width: 180, height: kind === 'text' ? 80 : 140, rotation: 0, scaleX: 1, scaleY: 1, pivotX: .5, pivotY: .5, fill: '#ffc857', stroke: '#1f2933', strokeWidth: 0, opacity: 1, shadow: {color:'#000000',blur:10,x:0,y:5,size:0,enabled:false}, start: 0, duration: 8, tracks: [], text: kind === 'text' ? 'Text' : undefined, fontFamily: 'JetBrains Mono', fontSize: 40, textLayout: 'live', mediaFit: 'fill', mediaOpacity: 1, speed: 1, volume: 1, pitchSemitones: kind === 'audio' || kind === 'video' ? 0 : undefined, linkSpeedPitch: kind === 'audio' || kind === 'video' ? getDefaultLinkSpeedPitch() : undefined, optimize: 'auto', ...overrides };
}
export function createProject(name = 'Untitled story'): Project {
  return {format:'hyde',version:1,id:uid(),name,width:1920,height:1080,fps:30,duration:8,background:'#d9dde3',elements:[],assets:[],sequences:[{id:uid(),name:'Scene 01',start:0,duration:8,color:'#ffc857'}],captions:[],folders:[],updatedAt:new Date().toISOString()};
}

/** Latest-start scene owns newly authored content at an overlapping time. */
export function sceneIdAt(project:Pick<Project,'sequences'>,time:number):string|undefined {
  return project.sequences.filter(scene=>time>=scene.start&&time<scene.start+scene.duration)
    .slice().sort((a,b)=>a.start-b.start).at(-1)?.id;
}

/** Scene boundaries hide authored content without removing or trimming it. */
export function elementWindow(project:Pick<Project,'sequences'>,element:Pick<StoryElement,'start'|'duration'|'sceneId'>):{start:number;end:number}|null {
  const scene=element.sceneId?project.sequences.find(item=>item.id===element.sceneId):undefined;
  if(element.sceneId&&!scene)return null;
  const start=Math.max(element.start,scene?.start??element.start);
  const end=Math.min(element.start+element.duration,scene?scene.start+scene.duration:element.start+element.duration);
  return end>start?{start,end}:null;
}

export function captionWindow(project:Pick<Project,'sequences'>,caption:Caption):{start:number;end:number}|null {
  const scene=caption.sceneId?project.sequences.find(item=>item.id===caption.sceneId):undefined;
  if(caption.sceneId&&!scene)return null;
  const start=Math.max(caption.start,scene?.start??caption.start);
  const end=Math.min(caption.end,scene?scene.start+scene.duration:caption.end);
  return end>start?{start,end}:null;
}

/** Legacy scene ownership follows the same latest-start overlap rule as the
 * scene camera. Items beginning in gaps remain globally timed. An assembly's
 * inferred ownership comes from its root, so migration cannot split its parts.
 * Explicit IDs always win; the input is never modified. */
export function assignSceneOwnership(project: Project): Project {
  const next = structuredClone(project);
  const scenes = next.sequences.slice().sort((a, b) => a.start - b.start);
  const at = (time: number) => sceneIdAt({sequences:scenes},time);
  const byId = new Map(next.elements.map(element => [element.id, element]));
  const resolved = new Set<string>(), visiting = new Set<string>();
  function resolve(element: StoryElement): string | undefined {
    if (resolved.has(element.id)) return element.sceneId;
    if (visiting.has(element.id)) throw new Error('Circular element attachments are not supported.');
    visiting.add(element.id);
    if (element.sceneId === undefined) {
      const parent = byId.get(element.parentId ?? element.attachment?.parentId ?? '');
      const inferred = parent ? resolve(parent) : at(element.start);
      if (inferred) element.sceneId = inferred;
    }
    visiting.delete(element.id); resolved.add(element.id);
    return element.sceneId;
  }
  next.elements.forEach(resolve);
  for (const caption of next.captions) if (caption.sceneId === undefined) caption.sceneId = at(caption.start);
  return next;
}
