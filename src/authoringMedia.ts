import { duplicateMediaClip, setMediaFades, setMediaSourceWindow, setMediaSpeed, splitMediaClip } from './audioClipEditing';
import { AUDIO_EFFECT_BOUNDS, MAX_AUDIO_EFFECTS } from './audioEffects';
import type { AudioEffect, Project, StoryElement, TextAnimation, TextReflow } from './model';
import type { MediaTransform } from './mediaTransform';
import type { PinCorners } from './projectivePin';
import { validPinCorners } from './projectivePin';
import { captureStaticTextShapeLayout } from './textFlow';

type Ref = string;
type VisualKind = 'rectangle' | 'ellipse' | 'polygon' | 'image' | 'video';
type PrimitiveKind = 'rectangle' | 'ellipse' | 'polygon';
type TextMode = NonNullable<StoryElement['textShapeMode']>;

/** The surrounding transaction owns aliases, validation, rollback, and revision changes. */
export interface MediaAuthoringContext {
  resolveAlias(ref: Ref): string;
  bindAlias?(alias: string, id: string): void;
}

export type MediaAuthoringCommand = { clientCommandId?: string } & (
  | { op: 'shape.setPrimitive'; args: { id: Ref; kind: PrimitiveKind; points?: { x: number; y: number }[] } }
  | { op: 'media.setFill'; args: { id: Ref; assetId: Ref | null; fit?: 'fit' | 'fill' | 'stretch' } }
  | { op: 'media.setPlacement'; args: { id: Ref; fit?: 'fit' | 'fill' | 'stretch'; transform?: MediaTransform | null } }
  | { op: 'media.setPin'; args: { id: Ref; corners: PinCorners | null } }
  | { op: 'media.setEndBehavior'; args: { id: Ref; behavior: 'hold' | 'hide' } }
  | { op: 'media.setOpacity'; args: { id: Ref; opacity: number } }
  | { op: 'element.setTextMaskTarget'; args: { id: Ref; targetId: Ref | null; mode?: TextMode } }
  | { op: 'text.setContent'; args: { id: Ref; text: string } }
  | { op: 'text.setFont'; args: { id: Ref; fontFamily?: string; fontSize?: number } }
  | { op: 'text.setLayout'; args: { id: Ref; layout: 'live' | 'static'; width?: number } }
  | { op: 'text.setAnimation'; args: { id: Ref; animation: TextAnimation | null } }
  | { op: 'text.setReflow'; args: { id: Ref; reflow: TextReflow | null } }
  | { op: 'text.captureStaticLayout'; args: { id: Ref; timeSeconds: number } }
  | { op: 'audio.setRange'; args: { id: Ref; inTime: number; outTime: number } }
  | { op: 'audio.split'; args: { id: Ref; at: number; alias?: string } }
  | { op: 'audio.duplicate'; args: { id: Ref; start?: number; alias?: string } }
  | { op: 'audio.setMix'; args: { id: Ref; volume?: number; muted?: boolean; loop?: boolean; fadeIn?: number; fadeOut?: number } }
  | { op: 'audio.setSpeedPitch'; args: { id: Ref; speed?: number; pitchSemitones?: number; linkSpeedPitch?: boolean } }
  | { op: 'audio.setEffects'; args: { id: Ref; effects: AudioEffect[] } }
  | { op: 'audio.updateEffect'; args: { id: Ref; effectId: Ref; patch: Partial<AudioEffect> } }
  | { op: 'video.setSourceTiming'; args: { id: Ref; inTime?: number; outTime?: number; speed?: number; loop?: boolean; endBehavior?: 'hold' | 'hide' } }
  | { op: 'video.setAudioMix'; args: { id: Ref; volume?: number; muted?: boolean; fadeIn?: number; fadeOut?: number; pitchSemitones?: number; linkSpeedPitch?: boolean; effects?: AudioEffect[] } }
);

export const MEDIA_AUTHORING_COMMAND_KEYS = {
  'shape.setPrimitive': ['id', 'kind', 'points'],
  'media.setFill': ['id', 'assetId', 'fit'],
  'media.setPlacement': ['id', 'fit', 'transform'],
  'media.setPin': ['id', 'corners'],
  'media.setEndBehavior': ['id', 'behavior'],
  'media.setOpacity': ['id', 'opacity'],
  'element.setTextMaskTarget': ['id', 'targetId', 'mode'],
  'text.setContent': ['id', 'text'],
  'text.setFont': ['id', 'fontFamily', 'fontSize'],
  'text.setLayout': ['id', 'layout', 'width'],
  'text.setAnimation': ['id', 'animation'],
  'text.setReflow': ['id', 'reflow'],
  'text.captureStaticLayout': ['id', 'timeSeconds'],
  'audio.setRange': ['id', 'inTime', 'outTime'],
  'audio.split': ['id', 'at', 'alias'],
  'audio.duplicate': ['id', 'start', 'alias'],
  'audio.setMix': ['id', 'volume', 'muted', 'loop', 'fadeIn', 'fadeOut'],
  'audio.setSpeedPitch': ['id', 'speed', 'pitchSemitones', 'linkSpeedPitch'],
  'audio.setEffects': ['id', 'effects'],
  'audio.updateEffect': ['id', 'effectId', 'patch'],
  'video.setSourceTiming': ['id', 'inTime', 'outTime', 'speed', 'loop', 'endBehavior'],
  'video.setAudioMix': ['id', 'volume', 'muted', 'fadeIn', 'fadeOut', 'pitchSemitones', 'linkSpeedPitch', 'effects'],
} as const;

export const MEDIA_AUTHORING_OPERATIONS = Object.keys(MEDIA_AUTHORING_COMMAND_KEYS) as Array<keyof typeof MEDIA_AUTHORING_COMMAND_KEYS>;

export class MediaAuthoringError extends Error {
  constructor(public readonly code: 'INVALID_ARGUMENT' | 'TARGET_NOT_FOUND' | 'INVALID_ASSET' | 'CAPABILITY_UNAVAILABLE', message: string, public readonly field?: string) {
    super(message);
    this.name = 'MediaAuthoringError';
  }
}

function fail(message: string, code: MediaAuthoringError['code'] = 'INVALID_ARGUMENT', field?: string): never {
  throw new MediaAuthoringError(code, message, field);
}
function record(value: unknown, label: string, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!keys.includes(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${label} does not support ${key}.`);
}
function finite(value: unknown, label: string, min = -Infinity, max = Infinity): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be a finite number between ${min} and ${max}.`);
}
function oneOf<T extends string>(value: unknown, choices: readonly T[], label: string): asserts value is T {
  if (!choices.includes(value as T)) fail(`${label} must be ${choices.join(', ')}.`);
}
function bool(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean.`);
}
function element(project: Project, ref: Ref, context: MediaAuthoringContext): StoryElement {
  if (typeof ref !== 'string' || !ref) fail('Element ID must be a nonempty string.');
  const id = context.resolveAlias(ref);
  const found = project.elements.find(item => item.id === id);
  if (!found) fail(`Element ${id} does not exist.`, 'TARGET_NOT_FOUND');
  return found;
}
function visual(item: StoryElement): asserts item is StoryElement & { kind: VisualKind } {
  if (!['rectangle', 'ellipse', 'polygon', 'image', 'video'].includes(item.kind)) fail('A visual shape or media element is required.');
}
function text(item: StoryElement): void { if (item.kind !== 'text') fail('A text element is required.'); }
function sound(project: Project, item: StoryElement, expected: 'audio' | 'video'): void {
  const asset = project.assets.find(candidate => candidate.id === item.assetId);
  if (item.kind !== expected || asset?.kind !== expected) fail(`A ${expected} element with a native ${expected} source is required.`, 'INVALID_ASSET');
}
function sourceDurationAvailable(project: Project, item: StoryElement): void {
  const duration = project.assets.find(asset => asset.id === item.assetId)?.duration;
  if (!Number.isFinite(duration) || !duration || duration <= 0)
    fail('Media source duration is unavailable; declare duration on asset.add or asset.replace before editing source timing.', 'INVALID_ASSET', 'assetId');
}
function visualAsset(project: Project, item: StoryElement): void {
  const asset = project.assets.find(candidate => candidate.id === item.assetId);
  if (!asset || !['image', 'video'].includes(asset.kind)) fail('The element needs an image or video asset.', 'INVALID_ASSET');
}
function fit(value: unknown): asserts value is NonNullable<StoryElement['mediaFit']> { oneOf(value, ['fit', 'fill', 'stretch'], 'Media fit'); }
function volume(value: unknown): asserts value is number { finite(value, 'Volume', 0, 2); }
function pitch(value: unknown): asserts value is number { finite(value, 'Pitch semitones', -24, 24); }
function bind(alias: string | undefined, id: string, context: MediaAuthoringContext): void {
  if (alias === undefined) return;
  if (typeof alias !== 'string' || !alias.startsWith('$') || !context.bindAlias) fail('A unique batch alias beginning with $ is required.');
  context.bindAlias(alias, id);
}
function setEffects(item: StoryElement, effects: AudioEffect[]): void {
  if (!Array.isArray(effects) || effects.length > MAX_AUDIO_EFFECTS) fail(`Audio effect chain cannot exceed ${MAX_AUDIO_EFFECTS} effects.`);
  const ids = new Set<string>();
  for (const effect of effects) {
    record(effect, 'Audio effect', ['id', 'type', 'enabled', 'delay', 'feedback', 'mix', 'rate', 'depth', 'threshold', 'ratio', 'knee', 'attack', 'release', 'drive', 'low', 'mid', 'high', 'seconds', 'decay']);
    if (typeof effect.id !== 'string' || !effect.id || ids.has(effect.id)) fail('Audio effects need unique nonempty IDs.');
    ids.add(effect.id);
    bool(effect.enabled, 'Audio effect enabled');
    if (!Object.hasOwn(AUDIO_EFFECT_BOUNDS, effect.type)) fail('Unknown audio effect type.');
    const bounds = AUDIO_EFFECT_BOUNDS[effect.type] as Record<string, readonly [number, number]>;
    record(effect, 'Audio effect', ['id', 'type', 'enabled', ...Object.keys(bounds)]);
    for (const [field, [min, max]] of Object.entries(bounds)) finite((effect as unknown as Record<string, unknown>)[field], `Audio effect ${field}`, min, max);
  }
  item.audioEffects = structuredClone(effects);
}
function setMix(project: Project, item: StoryElement, args: { volume?: number; muted?: boolean; loop?: boolean; fadeIn?: number; fadeOut?: number }): Project {
  if (args.volume !== undefined) { volume(args.volume); item.volume = args.volume; }
  if (args.muted !== undefined) { bool(args.muted, 'Muted'); item.muted = args.muted; }
  if (args.loop !== undefined) { bool(args.loop, 'Loop'); item.loop = args.loop; }
  if (args.fadeIn !== undefined || args.fadeOut !== undefined) {
    return setMediaFades(project, item.id, args.fadeIn ?? item.fadeIn ?? 0, args.fadeOut ?? item.fadeOut ?? 0);
  }
  return project;
}

/** Pure adapter: never mutates the input Project. Full graph validation belongs to the batch commit. */
export function applyMediaAuthoringCommand(project: Project, command: MediaAuthoringCommand, context: MediaAuthoringContext): Project {
  if (!Object.hasOwn(MEDIA_AUTHORING_COMMAND_KEYS, command.op)) fail(`Unsupported media command ${command.op}.`);
  record(command.args, `${command.op} arguments`, MEDIA_AUTHORING_COMMAND_KEYS[command.op]);
  // A separate runtime whitelist is required for bridge/CLI JSON. The public
  // discriminated union still gives TypeScript callers operation-specific args.
  const args = command.args as any;
  const next = structuredClone(project);
  const item = element(next, args.id, context);
  switch (command.op) {
    case 'shape.setPrimitive': {
      visual(item);
      if (!['rectangle', 'ellipse', 'polygon'].includes(item.kind)) fail('Only native shape elements can change primitive kind.');
      oneOf(args.kind, ['rectangle', 'ellipse', 'polygon'], 'Primitive kind');
      if (args.kind === 'polygon') {
        const points = args.points ?? [{ x: item.width / 2, y: 0 }, { x: item.width, y: item.height }, { x: 0, y: item.height }];
        if (!Array.isArray(points) || points.length < 3 || points.length > 4096) fail('A polygon needs 3 to 4096 points.');
        for (const point of points) { record(point, 'Polygon point', ['x', 'y']); finite(point.x, 'Polygon X'); finite(point.y, 'Polygon Y'); }
        item.points = structuredClone(points);
      } else {
        if (args.points !== undefined) fail('Only polygons accept primitive points.');
        delete item.points;
      }
      item.kind = args.kind;
      delete item.shapePath;
      return next;
    }
    case 'media.setFill': {
      visual(item);
      if (args.assetId === null) item.assetId = undefined;
      else {
        if (typeof args.assetId !== 'string' || !args.assetId) fail('Asset ID must be a nonempty string.');
        const assetId = context.resolveAlias(args.assetId);
        const asset = next.assets.find(candidate => candidate.id === assetId);
        if (!asset || !['image', 'video'].includes(asset.kind)) fail('Media fill requires an existing image or video asset.', 'INVALID_ASSET');
        item.assetId = assetId;
      }
      if (args.fit !== undefined) { fit(args.fit); item.mediaFit = args.fit; }
      return next;
    }
    case 'media.setPlacement': {
      visual(item); visualAsset(next, item);
      if (args.fit !== undefined) { fit(args.fit); item.mediaFit = args.fit; }
      if (args.transform !== undefined) {
        if (args.transform === null) delete item.mediaTransform;
        else {
          record(args.transform, 'Media transform', ['x', 'y', 'scaleX', 'scaleY', 'rotation']);
          finite(args.transform.x, 'Media X', -100000, 100000);
          finite(args.transform.y, 'Media Y', -100000, 100000);
          finite(args.transform.scaleX, 'Media scale X', .001, 100);
          finite(args.transform.scaleY, 'Media scale Y', .001, 100);
          finite(args.transform.rotation, 'Media rotation', -36000, 36000);
          item.mediaTransform = { ...args.transform };
        }
      }
      return next;
    }
    case 'media.setPin': {
      visual(item); visualAsset(next, item);
      if (args.corners === null) delete item.mediaPin;
      else {
        if (!Array.isArray(args.corners) || !validPinCorners(args.corners)) fail('Media pin must be a strictly convex four-corner quadrilateral.', 'INVALID_ARGUMENT', 'corners');
        item.mediaPin = structuredClone(args.corners);
      }
      return next;
    }
    case 'media.setEndBehavior': {
      visual(item);
      const source = next.assets.find(asset => asset.id === item.assetId);
      if (source?.kind !== 'video') fail('Video end behavior requires a video asset.', 'INVALID_ASSET');
      oneOf(args.behavior, ['hold', 'hide'], 'Video end behavior');
      item.videoEndBehavior = args.behavior;
      return next;
    }
    case 'media.setOpacity': visual(item); visualAsset(next, item); finite(args.opacity, 'Media opacity', 0, 1); item.mediaOpacity = args.opacity; return next;
    case 'element.setTextMaskTarget': {
      text(item);
      if (args.targetId === null) { delete item.flowAroundId; delete item.staticTextFlow; return next; }
      const target = element(next, args.targetId, context); visual(target);
      if (target.sceneId !== item.sceneId) fail('Text and its shape target must belong to the same scene.');
      if (args.mode !== undefined) oneOf(args.mode, ['around', 'inside', 'clip'], 'Text shape mode');
      item.flowAroundId = target.id;
      item.textShapeMode = args.mode ?? item.textShapeMode ?? 'around';
      delete item.staticTextFlow;
      return next;
    }
    case 'text.setContent': text(item); if (typeof args.text !== 'string') fail('Text content must be a string.'); item.text = args.text; delete item.staticTextFlow; return next;
    case 'text.setFont': {
      text(item);
      if (args.fontFamily === undefined && args.fontSize === undefined) fail('Specify a font family or font size.');
      if (args.fontFamily !== undefined) { if (typeof args.fontFamily !== 'string' || !args.fontFamily.trim()) fail('Font family must be nonempty.'); item.fontFamily = args.fontFamily; }
      if (args.fontSize !== undefined) { finite(args.fontSize, 'Font size', 1, 300); item.fontSize = args.fontSize; }
      delete item.staticTextFlow;
      return next;
    }
    case 'text.setLayout': {
      text(item); oneOf(args.layout, ['live', 'static'], 'Text layout');
      if (args.width !== undefined) { finite(args.width, 'Static layout width', 1); item.staticLayoutWidth = args.width; }
      if (args.layout === 'static' && item.staticLayoutWidth === undefined) item.staticLayoutWidth = item.width;
      item.textLayout = args.layout;
      delete item.staticTextFlow;
      if (args.layout === 'static') delete item.textReflow;
      return next;
    }
    case 'text.setAnimation': text(item); if (args.animation === null) delete item.textAnimation; else { record(args.animation, 'Text animation', ['unit', 'effect', 'direction', 'start', 'duration', 'stagger', 'easing', 'easingDirection', 'distance', 'seed', 'amplitude', 'frequency']); item.textAnimation = structuredClone(args.animation); } return next;
    case 'text.setReflow': text(item); if (item.textLayout === 'static' && args.reflow !== null) fail('Animated reflow requires live text layout.'); if (args.reflow === null) delete item.textReflow; else { record(args.reflow, 'Text reflow', ['preset', 'start', 'duration', 'stagger', 'easing', 'easingDirection']); item.textReflow = structuredClone(args.reflow); } return next;
    case 'text.captureStaticLayout': {
      text(item);
      finite(args.timeSeconds, 'Capture time', 0, next.duration);
      if (item.textLayout !== 'static' || !item.flowAroundId || item.textShapeMode === 'clip')
        fail('Static shape-aware text capture needs a static text element and an around/inside shape target.');
      if (typeof document === 'undefined' || !document.fonts || document.fonts.status !== 'loaded')
        fail('Static text capture requires a browser with loaded fonts; retry after document.fonts.ready.', 'CAPABILITY_UNAVAILABLE');
      const font = `${Math.max(1, item.fontSize ?? 40)}px ${item.fontFamily || 'Georgia'}`;
      if (!document.fonts.check(font, item.text || ' '))
        fail(`Font ${item.fontFamily || 'Georgia'} is not ready for static text capture.`, 'CAPABILITY_UNAVAILABLE');
      const snapshot = captureStaticTextShapeLayout(next, item.id, args.timeSeconds);
      if (!snapshot) fail('Text and shape must be active in the same scene with representable geometry.');
      item.staticTextFlow = snapshot;
      return next;
    }
    case 'audio.setRange': sound(next, item, 'audio'); sourceDurationAvailable(next, item); return setMediaSourceWindow(next, item.id, args.inTime, args.outTime);
    case 'audio.split': {
      sound(next, item, 'audio');
      const result = splitMediaClip(next, item.id, args.at);
      bind(args.alias, result.rightId, context);
      return result.project;
    }
    case 'audio.duplicate': {
      sound(next, item, 'audio');
      const result = duplicateMediaClip(next, item.id, args.start);
      bind(args.alias, result.clipId, context);
      return result.project;
    }
    case 'audio.setMix': sound(next, item, 'audio'); return setMix(next, item, args);
    case 'audio.setSpeedPitch': {
      sound(next, item, 'audio');
      if (args.pitchSemitones !== undefined) { pitch(args.pitchSemitones); item.pitchSemitones = args.pitchSemitones; }
      if (args.linkSpeedPitch !== undefined) { bool(args.linkSpeedPitch, 'Pitch/speed link'); item.linkSpeedPitch = args.linkSpeedPitch; }
      if (args.speed !== undefined && !item.loop) sourceDurationAvailable(next, item);
      return args.speed === undefined ? next : setMediaSpeed(next, item.id, args.speed);
    }
    case 'audio.setEffects': sound(next, item, 'audio'); setEffects(item, args.effects); return next;
    case 'audio.updateEffect': {
      sound(next, item, 'audio');
      const effect = item.audioEffects?.find(candidate => candidate.id === context.resolveAlias(args.effectId));
      if (!effect) fail('Audio effect does not exist.', 'TARGET_NOT_FOUND');
      const bounds = AUDIO_EFFECT_BOUNDS[effect.type] as Record<string, readonly [number, number]>;
      record(args.patch, 'Audio effect patch', ['enabled', ...Object.keys(bounds)]);
      setEffects(item, item.audioEffects!.map(candidate => candidate.id === effect.id ? { ...candidate, ...args.patch } as AudioEffect : candidate));
      return next;
    }
    case 'video.setSourceTiming': {
      sound(next, item, 'video');
      if (args.loop !== undefined) { bool(args.loop, 'Loop'); item.loop = args.loop; }
      if (args.endBehavior !== undefined) { oneOf(args.endBehavior, ['hold', 'hide'], 'Video end behavior'); item.videoEndBehavior = args.endBehavior; }
      if (args.inTime !== undefined || args.outTime !== undefined || args.speed !== undefined && !item.loop) sourceDurationAvailable(next, item);
      let result = args.speed === undefined ? next : setMediaSpeed(next, item.id, args.speed);
      if (args.inTime !== undefined || args.outTime !== undefined) {
        if (args.inTime === undefined || args.outTime === undefined) fail('Video source timing requires both inTime and outTime.');
        result = setMediaSourceWindow(result, item.id, args.inTime, args.outTime);
      }
      return result;
    }
    case 'video.setAudioMix': {
      sound(next, item, 'video');
      if (args.pitchSemitones !== undefined) { pitch(args.pitchSemitones); item.pitchSemitones = args.pitchSemitones; }
      if (args.linkSpeedPitch !== undefined) { bool(args.linkSpeedPitch, 'Pitch/speed link'); item.linkSpeedPitch = args.linkSpeedPitch; }
      if (args.effects !== undefined) setEffects(item, args.effects);
      return setMix(next, item, args);
    }
  }
}
