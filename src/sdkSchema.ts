import { AUDIO_EFFECT_BOUNDS, MAX_AUDIO_EFFECTS } from './audioEffects';
import { HYDE_COMMAND_KEYS, HYDE_OPERATIONS } from './authoring';
import { MOTION_LIMITS } from './motion';

type Schema = Record<string, unknown>;
const text: Schema = { type: 'string' };
const ref: Schema = { type: 'string', minLength: 1 };
const alias: Schema = { type: 'string', pattern: '^\\$' };
const number: Schema = { type: 'number' };
const nonnegative: Schema = { type: 'number', minimum: 0 };
const positive: Schema = { type: 'number', exclusiveMinimum: 0 };
const boolean: Schema = { type: 'boolean' };
const fraction: Schema = { type: 'number', minimum: 0, maximum: 1 };
const enumeration = (...values: string[]): Schema => ({ enum: values });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const array = (items: Schema, minItems = 0, maxItems?: number): Schema =>
  ({ type: 'array', items, minItems, ...(maxItems === undefined ? {} : { maxItems }) });
const object = (properties: Record<string, Schema>, required: string[] = []): Schema =>
  ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });

const point = object({ x: number, y: number }, ['x', 'y']);
const pathPoint = object({ x: number, y: number, in: point, out: point }, ['x', 'y']);
const contour = object({ points: array(pathPoint, 3, 4096) }, ['points']);
const path = object({ points: array(pathPoint, 3, 4096), holes: array(contour, 0, 64) }, ['points']);
const fit = enumeration('fit', 'fill', 'stretch');
const easing = enumeration('linear', 'sine', 'quad', 'cubic', 'quart', 'quint', 'expo', 'circ', 'back', 'bounce', 'elastic');
const direction = enumeration('in', 'out', 'inOut');
const animProperty = enumeration('x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity', 'fill', 'volume', 'assetId');
const cameraProperty = enumeration('x', 'y', 'zoom', 'rotation');
const keyOptions = { easing, direction, mode: enumeration('smooth', 'hold', 'stepped'), steps: positive, switchPoint: fraction };
const keyframe = object({ id: ref, time: nonnegative, value: { anyOf: [number, text] }, ...keyOptions }, ['id', 'time', 'value', 'easing', 'direction', 'mode']);
const clipTrack = object({ elementId: ref, property: animProperty, keyframes: array(keyframe) }, ['elementId', 'property', 'keyframes']);
const webPlayer = object({
  posterTime: { type: 'number', minimum: 0, maximum: 3600 },
  loop: boolean, controlsVisible: boolean, showSeek: boolean, showVolume: boolean,
  showFullscreen: boolean, showCaptions: boolean, showLoop: boolean,
}, ['posterTime', 'loop', 'controlsVisible', 'showSeek', 'showVolume', 'showFullscreen', 'showCaptions', 'showLoop']);
const shadow = object({ color: text, blur: nonnegative, x: number, y: number, enabled: boolean },
  ['color', 'blur', 'x', 'y', 'enabled']);
const transformFields = {
  x: number, y: number, width: nonnegative, height: nonnegative, rotation: number,
  scaleX: number, scaleY: number, pivotX: number, pivotY: number,
};
const elementProperties = object({
  name: text, ...transformFields, fill: text, stroke: text, strokeWidth: nonnegative,
  opacity: fraction, start: nonnegative, duration: positive, assetId: ref,
  text, fontFamily: text, fontSize: number, parentId: ref, hidden: boolean, locked: boolean,
});
const appearance = object({
  fill: text, stroke: text, strokeWidth: nonnegative, opacity: fraction,
  hidden: boolean, optimize: enumeration('auto', 'motion', 'static'), shadow,
});
const mediaTransform = object({
  x: { type: 'number', minimum: -100000, maximum: 100000 },
  y: { type: 'number', minimum: -100000, maximum: 100000 },
  scaleX: { type: 'number', minimum: 0.001, maximum: 100 },
  scaleY: { type: 'number', minimum: 0.001, maximum: 100 },
  rotation: { type: 'number', minimum: -36000, maximum: 36000 },
}, ['x', 'y', 'scaleX', 'scaleY', 'rotation']);
const sourceFrame = object({ x: number, y: number, width: positive, height: positive }, ['x', 'y', 'width', 'height']);
const placement = object({
  start: nonnegative, duration: positive, speed: { type: 'number', minimum: 0.01, maximum: 100 }, sourceIn: nonnegative, sourceOut: nonnegative,
  muted: boolean, mutedSourceClipIds: array(ref), frame: sourceFrame,
  frameFit: fit, frameRotation: number, opacity: fraction,
});
const textAnimation = object({
  unit: enumeration('word', 'line'),
  effect: enumeration('reveal', 'fade', 'slide', 'scale', 'rotate', 'wave', 'scatter'),
  direction: enumeration('in', 'out'), start: nonnegative, duration: positive,
  stagger: nonnegative, easing, easingDirection: direction,
  distance: { type: 'number', minimum: 0, maximum: 10000 },
  seed: { type: 'integer', minimum: 0, maximum: 0xffffffff },
  amplitude: { type: 'number', minimum: 0, maximum: 10000 },
  frequency: { type: 'number', minimum: 0, maximum: 100 },
}, ['unit', 'effect', 'direction', 'start', 'duration', 'stagger', 'easing', 'easingDirection', 'distance', 'seed', 'amplitude', 'frequency']);
const textReflow = object({
  preset: enumeration('glide', 'cascade'), start: nonnegative,
  duration: { type: 'number', exclusiveMinimum: 0, maximum: 3600 },
  stagger: { type: 'number', minimum: 0, maximum: 60 },
  easing, easingDirection: direction,
}, ['preset', 'start', 'duration', 'stagger', 'easing', 'easingDirection']);
const effectFields = Object.fromEntries(
  Object.entries(AUDIO_EFFECT_BOUNDS).flatMap(([, bounds]) =>
    Object.entries(bounds).map(([field]) => [field, number])),
) as Record<string, Schema>;
const audioEffect = {
  oneOf: Object.entries(AUDIO_EFFECT_BOUNDS).map(([type, bounds]) =>
    object({
      id: ref, type: { const: type }, enabled: boolean,
      ...Object.fromEntries(Object.entries(bounds).map(([field, [minimum, maximum]]) =>
        [field, { type: 'number', minimum, maximum }])),
    }, ['id', 'type', 'enabled', ...Object.keys(bounds)])),
};
const audioEffects = array(audioEffect, 0, MAX_AUDIO_EFFECTS);
const motionPoint = object({
  x: { type: 'number', minimum: -MOTION_LIMITS.pathCoordinate, maximum: MOTION_LIMITS.pathCoordinate },
  y: { type: 'number', minimum: -MOTION_LIMITS.pathCoordinate, maximum: MOTION_LIMITS.pathCoordinate },
  in: point, out: point,
}, ['x', 'y']);
const motionFields: Record<string, Schema> = {
  enabled: boolean, start: nonnegative, duration: { type: 'number', exclusiveMinimum: 0, maximum: MOTION_LIMITS.duration },
  points: array(motionPoint, 2, MOTION_LIMITS.pathPoints), loop: boolean, orient: boolean,
  easing, direction,
  property: enumeration('x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity'),
  amplitude: nonnegative, frequency: { type: 'number', exclusiveMinimum: 0, maximum: MOTION_LIMITS.frequency },
  phase: { type: 'number', minimum: -360, maximum: 360 }, fadeIn: nonnegative, fadeOut: nonnegative,
  seed: { type: 'integer', minimum: 0, maximum: 0xffffffff },
  amplitudeX: { type: 'number', minimum: 0, maximum: MOTION_LIMITS.shakePosition },
  amplitudeY: { type: 'number', minimum: 0, maximum: MOTION_LIMITS.shakePosition },
  amplitudeRotation: { type: 'number', minimum: 0, maximum: MOTION_LIMITS.shakeRotation },
  smooth: boolean,
};
const motionBehavior = {
  oneOf: [
    object({ type: { const: 'followPath' }, settings: object(Object.fromEntries(
      ['enabled', 'start', 'duration', 'points', 'loop', 'orient', 'easing', 'direction'].map(key => [key, motionFields[key]]))) }, ['type']),
    object({ type: { const: 'oscillation' }, settings: object(Object.fromEntries(
      ['enabled', 'start', 'duration', 'property', 'amplitude', 'frequency', 'phase', 'fadeIn', 'fadeOut'].map(key => [key, motionFields[key]]))) }, ['type']),
    object({ type: { const: 'shake' }, settings: object(Object.fromEntries(
      ['enabled', 'start', 'duration', 'seed', 'frequency', 'amplitudeX', 'amplitudeY', 'amplitudeRotation', 'smooth', 'fadeIn', 'fadeOut'].map(key => [key, motionFields[key]]))) }, ['type']),
  ],
};
const gapTransition = nullable(object({
  mode: enumeration('tween', 'hold'), easing, direction, switchPoint: fraction,
}));
const textureOverlap = nullable(object({
  mode: enumeration('alternate', 'single', 'holdOutgoing', 'useIncoming'),
  switchesPerSecond: { type: 'number', exclusiveMinimum: 0, maximum: 60 }, switchPoint: fraction,
}));

/** Required keys mirror the discriminated command union, including commands
 * whose only required argument is an ID. Cross-object rules remain in Hyde's
 * transaction validator. */
const requiredArgs: Record<string, string[]> = {
  'project.create': ['name'], 'project.updateMetadata': [],
  'scene.create': ['name', 'start', 'duration'], 'scene.rename': ['id', 'name'],
  'scene.duplicate': ['id'], 'scene.delete': ['id'], 'scene.retime': ['id', 'duration'],
  'scene.move': ['id'], 'scene.link': ['sourceId'], 'scene.unlink': ['id'],
  'element.create': ['kind'], 'element.remove': ['id'], 'element.setTransform': ['id', 'transform'],
  'element.updateAppearance': ['id', 'appearance'],
  'shape.setPath': ['id', 'path'], 'shape.convertToPath': ['id'], 'shape.insertPoint': ['id', 'index'],
  'shape.movePoint': ['id', 'index', 'x', 'y'], 'shape.setHandle': ['id', 'index', 'side'],
  'shape.removePoint': ['id', 'index'], 'assembly.attach': ['id', 'parentId', 'type'],
  'assembly.detach': ['id'], 'track.ensure': ['elementId', 'property'],
  'keyframe.upsert': ['elementId', 'property', 'timeSeconds', 'value'],
  'caption.create': ['text', 'start', 'end'], 'asset.add': ['handle', 'name'],
  'track.remove': ['elementId', 'property'],
  'keyframe.move': ['elementId', 'property', 'id', 'timeSeconds'],
  'keyframe.remove': ['elementId', 'property', 'id'],
  'scene.setCamera': ['sceneId', 'camera'],
  'camera.upsertKeyframe': ['sceneId', 'property', 'timeSeconds', 'value'],
  'camera.deleteKeyframe': ['sceneId', 'property', 'id'],
  'motion.add': ['elementId', 'behavior'], 'motion.update': ['elementId', 'id', 'settings'],
  'motion.remove': ['elementId', 'id'],
  'clip.capture': ['rootId', 'sourceStart', 'duration'], 'clip.rename': ['rootId', 'clipId', 'name'],
  'clip.updateDefinition': ['rootId', 'clipId', 'definition'], 'clip.remove': ['rootId', 'clipId'],
  'clip.place': ['rootId', 'clipId', 'at'], 'clip.move': ['rootId', 'instanceId', 'at'],
  'clip.retime': ['rootId', 'instanceId'], 'clip.removeInstance': ['rootId', 'instanceId'],
  'clip.setGapTransition': ['rootId', 'instanceId', 'elementId', 'property', 'transition'],
  'clip.setPriority': ['rootId', 'instanceId', 'elementId', 'property', 'priority'],
  'clip.setTextureOverlap': ['rootId', 'instanceId', 'elementId', 'overlap'],
  'clip.editPlacedKey': ['rootId', 'clipId', 'instanceId', 'elementId', 'property', 'action'],
  'shape.setPrimitive': ['id', 'kind'], 'media.setFill': ['id', 'assetId'],
  'media.setPlacement': ['id'], 'media.setPin': ['id', 'corners'],
  'media.setEndBehavior': ['id', 'behavior'], 'media.setOpacity': ['id', 'opacity'],
  'element.setTextMaskTarget': ['id', 'targetId'], 'text.setContent': ['id', 'text'],
  'text.setFont': ['id'], 'text.setLayout': ['id', 'layout'],
  'text.setAnimation': ['id', 'animation'], 'text.setReflow': ['id', 'reflow'],
  'text.captureStaticLayout': ['id', 'timeSeconds'],
  'audio.setRange': ['id', 'inTime', 'outTime'], 'audio.split': ['id', 'at'],
  'audio.duplicate': ['id'], 'audio.setMix': ['id'], 'audio.setSpeedPitch': ['id'],
  'audio.setEffects': ['id', 'effects'], 'audio.updateEffect': ['id', 'effectId', 'patch'],
  'video.setSourceTiming': ['id'], 'video.setAudioMix': ['id'],
  'scene.ripple': ['id', 'deltaSeconds'], 'scene.trimBoundary': ['id', 'edge', 'timeSeconds'],
  'scene.setPlacement': ['id', 'placement'], 'element.clone': ['id'],
  'element.reorder': ['id'], 'element.setPivot': ['id', 'pivotX', 'pivotY'],
  'element.setVisibility': ['id', 'hidden'], 'element.setLock': ['id', 'locked'],
  'element.align': ['ids', 'mode', 'timeSeconds'], 'element.distribute': ['ids', 'mode', 'timeSeconds'],
  'folder.create': ['name'], 'folder.rename': ['id', 'name'], 'folder.move': ['id'],
  'folder.remove': ['id'], 'folder.assign': ['folderId', 'elementIds'],
  'assembly.create': ['ids'], 'assembly.import': ['handle', 'timeSeconds'],
  'assembly.setLimits': ['id'], 'assembly.reparent': ['id', 'parentId', 'timeSeconds'],
  'caption.update': ['id', 'patch'], 'caption.delete': ['id'],
  'asset.rename': ['id', 'name'], 'asset.replace': ['id', 'handle'], 'asset.removeUnused': [],
};

const sharedFields: Record<string, Schema> = {
  id: ref, alias, name: text, handle: ref, sourceId: ref, beforeId: ref,
  sceneId: ref, elementId: ref, rootId: ref, clipId: ref, instanceId: ref,
  effectId: ref, parentId: ref, folderId: ref, targetId: ref, assetId: ref, keyId: ref,
  kind: enumeration('rectangle', 'ellipse', 'polygon', 'text', 'image', 'video', 'audio', 'group'),
  property: animProperty, type: enumeration('fixed', 'hinge', 'slider'),
  start: nonnegative, end: nonnegative, duration: positive, timeSeconds: nonnegative,
  sourceStart: nonnegative, at: nonnegative, inTime: nonnegative, outTime: nonnegative,
  deltaSeconds: number, x: number, y: number, width: positive, height: positive,
  pivotX: fraction, pivotY: fraction, opacity: fraction, volume: { type: 'number', minimum: 0, maximum: 2 },
  speed: positive, pitchSemitones: { type: 'number', minimum: -24, maximum: 24 },
  min: number, max: number, priority: { type: 'integer', minimum: 1, maximum: 10 },
  index: { type: 'integer', minimum: 0 }, contourIndex: { type: 'integer', minimum: 0, maximum: 64 }, fraction, steps: positive, switchPoint: fraction,
  value: { anyOf: [number, text] }, text, background: text, fill: text, stroke: text,
  color: text, fontFamily: text, fontSize: { type: 'number', minimum: 1, maximum: 300 },
  fps: positive, posterTime: nonnegative, rotation: number,
  fit, behavior: enumeration('hold', 'hide'), endBehavior: enumeration('hold', 'hide'),
  easing, direction, mode: enumeration('smooth', 'hold', 'stepped'), side: enumeration('in', 'out'),
  hidden: boolean, locked: boolean, descendants: boolean, preserveWorldPose: boolean,
  preserveArtwork: boolean, ripple: boolean, muted: boolean, loop: boolean,
  alignToFrame: boolean, removeInstances: boolean, linkSpeedPitch: boolean,
  fadeIn: nonnegative, fadeOut: nonnegative,
  ids: { ...array(ref, 1, 1000), uniqueItems: true },
  elementIds: { ...array(ref, 1, 1000), uniqueItems: true },
  points: array(point, 3, 4096), position: point,
  webPlayer, properties: elementProperties, transform: object(transformFields),
  appearance, path, camera: object({ x: number, y: number, zoom: positive, rotation: number }),
  placement, corners: nullable(array(point, 4, 4)), animation: nullable(textAnimation),
  reflow: nullable(textReflow), effects: audioEffects,
};

/** Some names mean different things in different operations. These overrides
 * prevent a broad shared field from documenting the wrong payload. */
const operationFields: Record<string, Record<string, Schema>> = {
  'scene.trimBoundary': { edge: enumeration('start', 'end') },
  'scene.setPlacement': { placement },
  'element.setTransform': { space: enumeration('local', 'world') },
  'element.create': { kind: sharedFields.kind, properties: elementProperties },
  'element.align': { mode: enumeration('left', 'centerX', 'right', 'top', 'centerY', 'bottom') },
  'element.distribute': { mode: enumeration('distributeX', 'distributeY') },
  'folder.assign': { folderId: nullable(ref) },
  'assembly.attach': { type: sharedFields.type },
  'assembly.setLimits': { min: nullable(number), max: nullable(number) },
  'assembly.reparent': { parentId: nullable(ref) },
  'caption.update': { patch: object({ text, start: nonnegative, end: nonnegative, sceneId: ref }) },
  'asset.removeUnused': { ids: { ...array(ref, 1, 1000), uniqueItems: true } },
  'shape.setPrimitive': { kind: enumeration('rectangle', 'ellipse', 'polygon'), points: array(point, 3, 4096) },
  'media.setFill': { assetId: nullable(ref) },
  'media.setPlacement': { transform: nullable(mediaTransform) },
  'media.setPin': { corners: nullable(array(point, 4, 4)) },
  'element.setTextMaskTarget': { targetId: nullable(ref), mode: enumeration('around', 'inside', 'clip') },
  'text.setLayout': { layout: enumeration('live', 'static'), width: { type: 'number', minimum: 1 } },
  'audio.updateEffect': { patch: object({ enabled: boolean, ...effectFields }) },
  'video.setSourceTiming': { inTime: nonnegative, outTime: nonnegative },
  'scene.setCamera': { camera: sharedFields.camera },
  'camera.upsertKeyframe': { property: cameraProperty, value: number },
  'camera.deleteKeyframe': { property: cameraProperty },
  'motion.add': { behavior: motionBehavior },
  'motion.update': { settings: object(motionFields) },
  'clip.updateDefinition': { definition: object({ name: text, duration: positive, tracks: array(clipTrack) }) },
  'clip.setGapTransition': { transition: gapTransition },
  'clip.setTextureOverlap': { overlap: textureOverlap },
  'clip.editPlacedKey': {
    action: enumeration('add', 'edit', 'remove', 'resetOverride'),
    patch: object({ time: nonnegative, value: sharedFields.value, ...keyOptions }),
  },
};

const conditionalArgs: Record<string, Schema> = {
  'element.setTransform': {
    if: { properties: { space: { const: 'world' } }, required: ['space'] },
    then: { properties: { transform: object({ x: number, y: number, rotation: number, scaleX: number, scaleY: number }) } },
    else: { not: { required: ['timeSeconds'] } },
  },
  'text.setFont': { anyOf: [{ required: ['fontFamily'] }, { required: ['fontSize'] }] },
  'video.setSourceTiming': { dependentRequired: { inTime: ['outTime'], outTime: ['inTime'] } },
  'clip.editPlacedKey': {
    allOf: [
      { if: { properties: { action: { const: 'add' } } }, then: { required: ['timeSeconds'] } },
      { if: { properties: { action: { const: 'edit' } } }, then: { required: ['keyId', 'patch'] } },
      { if: { properties: { action: { const: 'remove' } } }, then: { required: ['keyId'] } },
    ],
  },
};

/** Machine-readable command catalog. Empty property schemas are intentional
 * where Hyde's runtime carries semantics that JSON Schema cannot express. */
export const HYDE_COMMAND_ARG_SCHEMAS_V1: Record<string, Schema> = Object.fromEntries(
  HYDE_OPERATIONS.map(op => {
    const properties = Object.fromEntries(HYDE_COMMAND_KEYS[op].map(key =>
      [key, operationFields[op]?.[key] ?? sharedFields[key] ?? {}]));
    return [op, {
      ...object(properties, requiredArgs[op] ?? []),
      ...(conditionalArgs[op] ?? {}),
    }];
  }),
);

export const HYDE_EXECUTE_SCHEMA_V1 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://hyde.local/schema/execute-v1',
  title: 'Hyde authoring transaction v1',
  type: 'object',
  additionalProperties: false,
  required: ['protocolVersion', 'expectedRevision', 'commands'],
  properties: {
    protocolVersion: { const: 1 },
    expectedRevision: { type: 'integer', minimum: 0 },
    correlationId: { type: 'string', minLength: 1, maxLength: 128 },
    dryRun: { type: 'boolean' },
    commands: {
      type: 'array', minItems: 1, maxItems: 1000,
      items: {
        oneOf: HYDE_OPERATIONS.map(op => ({
          type: 'object', additionalProperties: false, required: ['op', 'args'],
          properties: {
            op: { const: op },
            clientCommandId: { type: 'string', minLength: 1, maxLength: 128 },
            args: HYDE_COMMAND_ARG_SCHEMAS_V1[op],
          },
        })),
      },
    },
  },
} as const;

export const HYDE_INSPECT_SCHEMA_V1 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://hyde.local/schema/inspect-v1',
  title: 'Hyde bounded inspection v1',
  type: 'object', additionalProperties: false, required: ['target'],
  properties: {
    target: { enum: ['project', 'scenes', 'scene', 'elements', 'element', 'assets', 'asset', 'changes', 'tree', 'timeline', 'assembly'] },
    id: { type: 'string' }, sceneId: { type: 'string' }, fields: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 40 }] },
    limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'integer', minimum: 0 }, depth: { type: 'integer', minimum: 0, maximum: 8 },
    sinceRevision: { type: 'integer', minimum: 0 }, timeStart: { type: 'number', minimum: 0 }, timeEnd: { type: 'number', minimum: 0 },
  },
} as const;
