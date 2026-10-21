import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import { uid } from './model';
import type { Assembly, Asset, Project, StoryElement } from './model';
import { AUDIO_EFFECT_BOUNDS, MAX_AUDIO_EFFECTS } from './audioEffects';
import { remapAnimationAssetIds, remapAssemblyClipReferences } from './assemblyClips';
import { validPinCorners } from './projectivePin';
import { MOTION_LIMITS, rekeyMotionBehaviors } from './motion';
import { browserAssetDigest, pruneBrowserAssets, readBrowserAsset, removeBrowserAsset, validBrowserAssetRef, writeBrowserAsset } from './browserRecoveryAssets';
import type { BrowserAssetRef } from './browserRecoveryAssets';

/** V1 is an in-memory ZIP archive, not a streaming container. These limits bound
 * input allocation; practical browser memory limits can be lower. */
const MAX_ARCHIVE = 512 * 1024 * 1024;
const MAX_EXPANDED = 768 * 1024 * 1024;
const MAX_MANIFEST = 16 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const MANIFEST = 'manifest.xml';
type DocumentModel = Project | Assembly;
type RecordValue = Record<string, unknown>;

function fail(message: string): never { throw new Error(`Hyde: ${message}`); }
function record(value: unknown): value is RecordValue { return !!value && typeof value === 'object' && !Array.isArray(value); }
function check(condition: unknown, message: string): asserts condition { if (!condition) fail(message); }
function string(value: unknown, label: string): asserts value is string { check(typeof value === 'string', `${label} must be text.`); }
function number(value: unknown, label: string, min = -Infinity): asserts value is number {
  check(typeof value === 'number' && Number.isFinite(value) && value >= min, `${label} must be a finite number${min !== -Infinity ? ` >= ${min}` : ''}.`);
}
function positive(value: unknown, label: string): asserts value is number { number(value, label); check(value > 0, `${label} must be greater than zero.`); }
function uniqueId(value: unknown, used: Set<string>, label: string): asserts value is string {
  string(value, label); check(value.length > 0 && !used.has(value), `${label} is empty or duplicated.`); used.add(value);
}

/** Keep optional/forward-compatible data intact, but reject malformed required
 * fields before data can reach the renderer or timeline. */
function validate(model: unknown, assembly: boolean): asserts model is DocumentModel {
  check(record(model), 'The manifest is not an object.');
  check(model.format === (assembly ? 'hyde-assembly' : 'hyde'), 'Wrong document type.');
  check(model.version === 1, 'Unsupported document version.');
  string(model.name, 'Name');
  check(Array.isArray(model.elements) && Array.isArray(model.assets), 'Elements and assets must be arrays.');
  const assetIds = new Set<string>(), visualAssetIds = new Set<string>();
  for (const asset of model.assets) {
    check(record(asset), 'Invalid asset.'); uniqueId(asset.id, assetIds, 'Asset ID');
    string(asset.name, 'Asset name'); string(asset.mime, 'Asset MIME type');
    check(['image', 'video', 'audio', 'font'].includes(String(asset.kind)), 'Unknown asset kind.');
    if(asset.kind==='image'||asset.kind==='video')visualAssetIds.add(asset.id);
    string(asset.dataUrl, 'Asset data');
    check(asset.dataUrl.startsWith('data:'), 'Assets must contain embedded data.');
    if (asset.duration !== undefined) number(asset.duration, 'Asset duration', 0);
    if (asset.licenseNotice !== undefined) {
      check(asset.kind === 'font', 'Only font assets can carry a license notice.');
      string(asset.licenseNotice, 'Font license notice');
      check(asset.licenseNotice.length <= 100000, 'Font license notice is too long.');
    }
  }
  const animationProperties=['x','y','rotation','scaleX','scaleY','opacity','fill','volume','assetId'];
  const visualKinds=['rectangle','ellipse','polygon','text','image','video'];
  const textureKey=(value:unknown,label:string)=>{
    string(value,label);
    check(value===''||visualAssetIds.has(value),`${label} must refer to an image or video asset in this document.`);
  };
  const discreteSwitch=(key:RecordValue,property:unknown)=>{
    if(key.switchPoint===undefined)return;
    check(property==='assetId','Only texture keys can set a discrete switch point.');
    number(key.switchPoint,'Texture key switch point',0);
    check(key.switchPoint<=1,'Texture key switch point must be between zero and one.');
  };
  const elementIds = new Set<string>();
  const keyIds = new Set<string>();
  const assemblyClipIds = new Set<string>(), assemblyInstanceIds = new Set<string>();
  const motionIds = new Set<string>();
  for (const element of model.elements) {
    check(record(element), 'Invalid element.'); uniqueId(element.id, elementIds, 'Element ID');
    string(element.name, 'Element name');
    if (element.sceneId !== undefined) {
      string(element.sceneId, 'Element scene ID'); check(element.sceneId.length > 0, 'Element scene ID cannot be empty.');
    }
    check(['rectangle', 'ellipse', 'polygon', 'text', 'image', 'video', 'audio', 'group'].includes(String(element.kind)), 'Unknown element kind.');
    if (element.textAnimation !== undefined) {
      check(element.kind === 'text' && record(element.textAnimation), 'Only text can have a text animation.');
      const motion = element.textAnimation;
      check(['word', 'line'].includes(String(motion.unit)), 'Unknown text animation unit.');
      check(['reveal', 'fade', 'slide', 'scale', 'rotate', 'wave', 'scatter'].includes(String(motion.effect)), 'Unknown text animation effect.');
      check(['in', 'out'].includes(String(motion.direction)), 'Unknown text animation direction.');
      check(['linear', 'sine', 'quad', 'cubic', 'quart', 'quint', 'expo', 'circ', 'back', 'bounce', 'elastic'].includes(String(motion.easing)), 'Unknown text easing family.');
      check(['in', 'out', 'inOut'].includes(String(motion.easingDirection)), 'Unknown text easing direction.');
      number(motion.start, 'Text animation start', 0); positive(motion.duration, 'Text animation duration');
      number(motion.stagger, 'Text animation stagger', 0);
      number(motion.distance, 'Text animation distance', 0); number(motion.amplitude, 'Text animation amplitude', 0);
      number(motion.frequency, 'Text animation frequency', 0); number(motion.seed, 'Text animation seed', 0);
      check(motion.distance <= 10000 && motion.amplitude <= 10000 && motion.frequency <= 100 && Number.isInteger(motion.seed) && motion.seed <= 0xffffffff, 'Text animation settings are outside their supported range.');
    }
    if (element.textReflow !== undefined) {
      check(element.kind === 'text' && record(element.textReflow), 'Only text can have animated reflow.');
      const reflow = element.textReflow;
      check(['glide', 'cascade'].includes(String(reflow.preset)), 'Unknown text reflow preset.');
      check(['linear', 'sine', 'quad', 'cubic', 'quart', 'quint', 'expo', 'circ', 'back', 'bounce', 'elastic'].includes(String(reflow.easing)), 'Unknown text reflow easing.');
      check(['in', 'out', 'inOut'].includes(String(reflow.easingDirection)), 'Unknown text reflow direction.');
      number(reflow.start, 'Text reflow start', 0);
      positive(reflow.duration, 'Text reflow duration');
      number(reflow.stagger, 'Text reflow stagger', 0);
      check(reflow.duration <= 3600 && reflow.stagger <= 60, 'Text reflow timing is outside its supported range.');
    }
    if (element.shapePath !== undefined) {
      check(['rectangle', 'ellipse', 'polygon', 'image', 'video'].includes(String(element.kind)), 'Only visual shapes and media can have an editable path.');
      check(record(element.shapePath) && Array.isArray(element.shapePath.points), 'Invalid editable path.');
      check(element.shapePath.points.length >= 3 && element.shapePath.points.length <= 4096, 'An editable path needs 3 to 4096 points.');
      for (const point of element.shapePath.points) {
        check(record(point), 'Invalid editable path point.');
        number(point.x, 'Path point X'); number(point.y, 'Path point Y');
        for (const handle of ['in', 'out'] as const) if (point[handle] !== undefined) {
          check(record(point[handle]), `Invalid path ${handle} handle.`);
          number(point[handle].x, `Path ${handle} X`); number(point[handle].y, `Path ${handle} Y`);
        }
      }
    }
    if(element.motionBehaviors!==undefined){
      check(Array.isArray(element.motionBehaviors)&&element.motionBehaviors.length<=MOTION_LIMITS.count,'Motion behavior list is too long or invalid.');
      for(const motion of element.motionBehaviors){
        check(record(motion),'Invalid motion behavior.');uniqueId(motion.id,motionIds,'Motion behavior ID');
        check(typeof motion.enabled==='boolean','Motion behavior state must be on or off.');
        number(motion.start,'Motion start',0);positive(motion.duration,'Motion duration');
        check(motion.start<=MOTION_LIMITS.duration&&motion.duration<=MOTION_LIMITS.duration,'Motion timing is outside its supported range.');
        if(motion.type==='followPath'){
          check(Array.isArray(motion.points)&&motion.points.length>=2&&motion.points.length<=MOTION_LIMITS.pathPoints,'Follow path needs 2 to 64 points.');
          check(typeof motion.loop==='boolean'&&typeof motion.orient==='boolean','Invalid follow-path options.');
          check(['linear','sine','quad','cubic','quart','quint','expo','circ','back','bounce','elastic'].includes(String(motion.easing)),'Unknown follow-path easing.');
          check(['in','out','inOut'].includes(String(motion.direction)),'Unknown follow-path direction.');
          for(const point of motion.points){
            check(record(point),'Invalid follow-path point.');
            for(const value of [point,point.in,point.out])if(value!==undefined){
              check(record(value),'Invalid follow-path handle.');
              number(value.x,'Follow-path X',-MOTION_LIMITS.pathCoordinate);number(value.y,'Follow-path Y',-MOTION_LIMITS.pathCoordinate);
              check(value.x<=MOTION_LIMITS.pathCoordinate&&value.y<=MOTION_LIMITS.pathCoordinate,'Follow-path point is outside its supported range.');
            }
          }
        }else if(motion.type==='oscillation'){
          check(['x','y','rotation','scaleX','scaleY','opacity'].includes(String(motion.property)),'Unknown oscillation property.');
          positive(motion.frequency,'Oscillation frequency');
          check(motion.frequency<=MOTION_LIMITS.frequency,'Oscillation frequency is too high.');
          number(motion.amplitude,'Oscillation amplitude',0);
          const bound=['x','y'].includes(String(motion.property))?MOTION_LIMITS.positionAmplitude:motion.property==='rotation'?MOTION_LIMITS.rotationAmplitude:motion.property==='opacity'?MOTION_LIMITS.opacityAmplitude:MOTION_LIMITS.scaleAmplitude;
          check(motion.amplitude<=bound,'Oscillation amplitude is outside its supported range.');
          number(motion.phase,'Oscillation phase',-360);check(motion.phase<=360,'Oscillation phase is outside its supported range.');
          for(const field of ['fadeIn','fadeOut'] as const){number(motion[field],`Oscillation ${field}`,0);check(motion[field]<=motion.duration,'Oscillation fade exceeds its duration.');}
        }else if(motion.type==='shake'){
          number(motion.seed,'Shake seed',0);check(Number.isInteger(motion.seed)&&motion.seed<=0xffffffff,'Shake seed must be an unsigned integer.');
          positive(motion.frequency,'Shake frequency');check(motion.frequency<=MOTION_LIMITS.frequency,'Shake frequency is too high.');
          check(typeof motion.smooth==='boolean','Shake interpolation must be on or off.');
          for(const field of ['amplitudeX','amplitudeY'] as const){number(motion[field],`Shake ${field}`,0);check(motion[field]<=MOTION_LIMITS.shakePosition,'Shake movement is outside its supported range.');}
          number(motion.amplitudeRotation,'Shake rotation',0);check(motion.amplitudeRotation<=MOTION_LIMITS.shakeRotation,'Shake rotation is outside its supported range.');
          for(const field of ['fadeIn','fadeOut'] as const){number(motion[field],`Shake ${field}`,0);check(motion[field]<=motion.duration,'Shake fade exceeds its duration.');}
        }else fail('Unknown motion behavior.');
      }
    }
    if (element.mediaPin !== undefined) {
      check(['rectangle','ellipse','polygon','image','video'].includes(String(element.kind)) &&
        (element.assetId===undefined||visualAssetIds.has(String(element.assetId))),
      'Only image and video fills can use corner pins.');
      check(Array.isArray(element.mediaPin) && validPinCorners(element.mediaPin), 'Media corner pins must form a valid four-corner shape.');
    }
    if (element.mediaTransform !== undefined) {
      check(['rectangle','ellipse','polygon','text','image','video'].includes(String(element.kind)) &&
        (element.assetId===undefined||visualAssetIds.has(String(element.assetId))),
      'Only image and video fills can use media transforms.');
      check(record(element.mediaTransform), 'Invalid media transform.');
      for (const field of ['x','y'] as const) {
        number(element.mediaTransform[field], `Media ${field}`, -100000);
        check(element.mediaTransform[field] <= 100000, `Media ${field} is outside its supported range.`);
      }
      for (const field of ['scaleX','scaleY'] as const) {
        number(element.mediaTransform[field], `Media ${field}`, .001);
        check(element.mediaTransform[field] <= 100, `Media ${field} is outside its supported range.`);
      }
      number(element.mediaTransform.rotation, 'Media rotation', -36000);
      check(element.mediaTransform.rotation <= 36000, 'Media rotation is outside its supported range.');
    }
    for (const prop of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'pivotX', 'pivotY']) number(element[prop], prop);
    positive(element.duration, 'duration');
    for (const prop of ['width', 'height']) {
      if (element.kind === 'group' || element.kind === 'audio') number(element[prop], prop, 0);
      else positive(element[prop], prop);
    }
    for (const prop of ['start', 'strokeWidth', 'opacity']) number(element[prop], prop, 0);
    check((element.opacity as number) <= 1, 'Opacity must be between zero and one.');
    string(element.fill, 'Fill'); string(element.stroke, 'Stroke');
    check(record(element.shadow), 'Invalid shadow.');
    string(element.shadow.color, 'Shadow color');
    number(element.shadow.blur, 'Shadow blur', 0); number(element.shadow.x, 'Shadow X'); number(element.shadow.y, 'Shadow Y');
    check(typeof element.shadow.enabled === 'boolean', 'Invalid shadow state.');
    if (element.assetId !== undefined) {
      string(element.assetId, 'Element asset ID');
      check(assetIds.has(element.assetId), 'An element refers to a missing asset.');
    }
    if (element.speed !== undefined) positive(element.speed, 'Playback speed');
    if (element.pitchSemitones !== undefined) {
      number(element.pitchSemitones, 'Pitch semitones', -24);
      check(element.pitchSemitones <= 24, 'Pitch semitones must be <= 24.');
    }
    if (element.linkSpeedPitch !== undefined) check(typeof element.linkSpeedPitch === 'boolean', 'Pitch/speed link must be on or off.');
    for (const prop of ['sourceOffset', 'volume', 'mediaOpacity']) if (element[prop] !== undefined) number(element[prop], prop, 0);
    if (element.recorded !== undefined) check(element.kind === 'audio' && typeof element.recorded === 'boolean', 'Invalid recording marker.');
    if (element.recordingOffset !== undefined) {
      check(element.kind === 'audio' && element.recorded === true, 'Only microphone clips can have a recording offset.');
      number(element.recordingOffset, 'Recording offset', -5);
      check(element.recordingOffset <= 5, 'Recording offset must be at most five seconds.');
    }
    if (element.videoEndBehavior !== undefined) check(element.videoEndBehavior === 'hold' || element.videoEndBehavior === 'hide', 'Invalid video end behavior.');
    for (const prop of ['fadeIn', 'fadeOut']) if (element[prop] !== undefined) {
      number(element[prop], prop, 0);
      check((element[prop] as number) <= (element.duration as number), `${prop} cannot exceed clip duration.`);
    }
    if (element.audioEffects !== undefined) {
      check(Array.isArray(element.audioEffects) && element.audioEffects.length <= MAX_AUDIO_EFFECTS, 'Audio effect chain is too long or invalid.');
      const effectIds = new Set<string>();
      for (const effect of element.audioEffects) {
        check(record(effect), 'Invalid audio effect.');
        uniqueId(effect.id, effectIds, 'Audio effect ID');
        check(typeof effect.enabled === 'boolean', 'Invalid audio effect bypass state.');
        string(effect.type, 'Audio effect type');
        const fields = (AUDIO_EFFECT_BOUNDS as Record<string, Record<string, readonly [number, number]>>)[effect.type];
        check(!!fields, 'Unknown audio effect type.');
        for (const [field, [min, max]] of Object.entries(fields)) {
          number(effect[field], `Audio effect ${field}`, min);
          check((effect[field] as number) <= max, `Audio effect ${field} must be <= ${max}.`);
        }
      }
    }
    check(Array.isArray(element.tracks), 'Animation tracks must be an array.');
    const properties = new Set<string>();
    for (const track of element.tracks) {
      check(record(track) && Array.isArray(track.keyframes), 'Invalid animation track.');
      check(animationProperties.includes(String(track.property)), 'Unknown animation property.');
      if(track.property==='assetId')check(visualKinds.includes(String(element.kind)),'Only visual objects can animate a texture.');
      check(!properties.has(String(track.property)), 'Duplicate animation property.'); properties.add(String(track.property));
      for (const key of track.keyframes) {
        check(record(key), 'Invalid keyframe.'); uniqueId(key.id, keyIds, 'Keyframe ID'); number(key.time, 'Keyframe time', 0);
        if (track.property === 'fill') string(key.value, 'Fill keyframe value');
        else if(track.property==='assetId')textureKey(key.value,'Texture keyframe value');
        else number(key.value, 'Keyframe value');
        discreteSwitch(key,track.property);
        check(['linear', 'sine', 'quad', 'cubic', 'quart', 'quint', 'expo', 'circ', 'back', 'bounce', 'elastic'].includes(String(key.easing)), 'Unknown easing family.');
        check(['in', 'out', 'inOut'].includes(String(key.direction)), 'Unknown easing direction.');
        check(['smooth', 'hold', 'stepped'].includes(String(key.mode)), 'Unknown animation mode.');
        if (key.steps !== undefined) positive(key.steps, 'Stepped cadence');
      }
    }
    if (element.assemblyClips !== undefined) {
      check(Array.isArray(element.assemblyClips), 'Assembly clips must be an array.');
      for (const clip of element.assemblyClips) {
        check(record(clip), 'Invalid assembly clip.'); uniqueId(clip.id, assemblyClipIds, 'Assembly clip ID');
        string(clip.name, 'Assembly clip name'); positive(clip.duration, 'Assembly clip duration');
        check(Array.isArray(clip.tracks) && clip.tracks.length > 0, 'An assembly clip needs at least one keyed track.');
        const properties = new Set<string>();
        for (const track of clip.tracks) {
          check(record(track) && Array.isArray(track.keyframes), 'Invalid assembly clip track.');
          string(track.elementId, 'Assembly clip target');
          check(animationProperties.includes(String(track.property)), 'Unknown assembly clip property.');
          const targetProperty = `${track.elementId}\u0000${track.property}`;
          check(!properties.has(targetProperty), 'Duplicate assembly clip property.'); properties.add(targetProperty);
          check(track.keyframes.length > 0, 'An assembly clip track needs at least one keyframe.');
          for (const key of track.keyframes) {
            check(record(key), 'Invalid assembly clip keyframe.'); uniqueId(key.id, keyIds, 'Keyframe ID');
            number(key.time, 'Assembly clip keyframe time', 0);
            check(key.time <= (clip.duration as number), 'An assembly clip keyframe lies beyond its duration.');
            if (track.property === 'fill') string(key.value, 'Fill keyframe value');
            else if(track.property==='assetId')textureKey(key.value,'Assembly clip texture key');
            else number(key.value, 'Assembly clip keyframe value');
            discreteSwitch(key,track.property);
            check(['linear', 'sine', 'quad', 'cubic', 'quart', 'quint', 'expo', 'circ', 'back', 'bounce', 'elastic'].includes(String(key.easing)), 'Unknown assembly clip easing family.');
            check(['in', 'out', 'inOut'].includes(String(key.direction)), 'Unknown assembly clip easing direction.');
            check(['smooth', 'hold', 'stepped'].includes(String(key.mode)), 'Unknown assembly clip animation mode.');
            if (key.steps !== undefined) positive(key.steps, 'Assembly clip stepped cadence');
          }
        }
      }
    }
    if (element.clipInstances !== undefined) {
      check(Array.isArray(element.clipInstances), 'Placed assembly clips must be an array.');
      const owned = new Set((element.assemblyClips ?? []).map(clip => clip.id));
      for (const instance of element.clipInstances) {
        check(record(instance), 'Invalid placed assembly clip.'); uniqueId(instance.id, assemblyInstanceIds, 'Placed assembly clip ID');
        string(instance.clipId, 'Placed assembly clip source');
        check(owned.has(instance.clipId), 'A placed assembly clip refers to a missing definition.');
        number(instance.start, 'Placed assembly clip start', 0); positive(instance.duration, 'Placed assembly clip duration');
        if (instance.loop !== undefined) check(typeof instance.loop === 'boolean', 'Assembly clip looping must be on or off.');
        if (instance.gapTransitions !== undefined) {
          check(Array.isArray(instance.gapTransitions), 'Assembly gap transitions must be an array.');
          const incoming = (element.assemblyClips ?? []).find(clip => clip.id === instance.clipId);
          const seen = new Set<string>();
          for (const transition of instance.gapTransitions) {
            check(record(transition), 'Invalid assembly gap transition.');
            string(transition.elementId, 'Assembly gap target');
            check(animationProperties.includes(String(transition.property)), 'Unknown assembly gap property.');
            check(incoming?.tracks.some((track: { elementId: string; property: string }) => track.elementId === transition.elementId && track.property === transition.property), 'An assembly gap transition must target an incoming clip property.');
            const target = `${transition.elementId}\u0000${transition.property}`;
            check(!seen.has(target), 'Duplicate assembly gap transition.'); seen.add(target);
            check(['tween', 'hold'].includes(String(transition.mode)), 'Unknown assembly gap mode.');
            check(['linear', 'sine', 'quad', 'cubic', 'quart', 'quint', 'expo', 'circ', 'back', 'bounce', 'elastic'].includes(String(transition.easing)), 'Unknown assembly gap easing family.');
            check(['in', 'out', 'inOut'].includes(String(transition.direction)), 'Unknown assembly gap easing direction.');
            if(transition.switchPoint!==undefined){
              check(transition.property==='assetId','Only texture gaps can have a discrete switch point.');
              number(transition.switchPoint,'Texture gap switch point',0);
              check(transition.switchPoint<=1,'Texture gap switch point must be between zero and one.');
            }
          }
        }
        if (instance.priorityOverrides !== undefined) {
          check(Array.isArray(instance.priorityOverrides), 'Assembly priorities must be an array.');
          const incoming = (element.assemblyClips ?? []).find(clip => clip.id === instance.clipId);
          const seen = new Set<string>();
          for (const override of instance.priorityOverrides) {
            check(record(override), 'Invalid assembly priority.');
            string(override.elementId, 'Assembly priority target');
            check(animationProperties.includes(String(override.property)), 'Unknown assembly priority property.');
            check(incoming?.tracks.some((track: {elementId: string; property: string}) => track.elementId === override.elementId && track.property === override.property), 'An assembly priority must target a placed clip property.');
            const target = `${override.elementId}\u0000${override.property}`;
            check(!seen.has(target), 'Duplicate assembly priority.'); seen.add(target);
            number(override.priority, 'Assembly priority', 1);
            check(Number.isInteger(override.priority) && override.priority <= 10, 'Assembly priority must be a whole number from 1 to 10.');
          }
        }
        if (instance.textureOverlaps !== undefined) {
          check(Array.isArray(instance.textureOverlaps), 'Assembly texture overlaps must be an array.');
          const incoming=(element.assemblyClips??[]).find(clip=>clip.id===instance.clipId);
          const seen=new Set<string>();
          for(const overlap of instance.textureOverlaps){
            check(record(overlap),'Invalid assembly texture overlap.');
            string(overlap.elementId,'Assembly texture overlap target');
            check(!seen.has(overlap.elementId),'Duplicate assembly texture overlap.');seen.add(overlap.elementId);
            check(incoming?.tracks.some((track:{elementId:string;property:string})=>track.elementId===overlap.elementId&&track.property==='assetId'),
              'An assembly texture setting must target an incoming texture track.');
            check(['alternate','single','holdOutgoing','useIncoming'].includes(String(overlap.mode)),'Unknown texture overlap mode.');
            positive(overlap.switchesPerSecond,'Texture switches per second');
            check(overlap.switchesPerSecond<=60,'Texture switch cadence is too high.');
            number(overlap.switchPoint,'Texture switch point',0);
            check(overlap.switchPoint<=1,'Texture switch point must be between zero and one.');
          }
        }
        if (instance.trackOverrides !== undefined) {
          check(Array.isArray(instance.trackOverrides), 'Placed clip track overrides must be an array.');
          const source = (element.assemblyClips ?? []).find(clip => clip.id === instance.clipId);
          const seen = new Set<string>();
          for (const track of instance.trackOverrides) {
            check(record(track) && Array.isArray(track.keyframes), 'Invalid placed clip track override.');
            string(track.elementId, 'Placed clip track target');
            check(animationProperties.includes(String(track.property)), 'Unknown placed clip track property.');
            check(source?.tracks.some((item: {elementId:string;property:string}) => item.elementId===track.elementId&&item.property===track.property), 'A placed clip override must target a source track.');
            const target=`${track.elementId}\u0000${track.property}`;
            check(!seen.has(target), 'Duplicate placed clip track override.'); seen.add(target);
            check(track.keyframes.length>0, 'A placed clip track needs at least one keyframe.');
            for(const key of track.keyframes){
              check(record(key), 'Invalid placed clip keyframe.');uniqueId(key.id,keyIds,'Placed clip keyframe ID');
              number(key.time,'Placed clip keyframe time',0);
              check(key.time <= (source?.duration as number), 'A placed clip keyframe lies beyond its source duration.');
              if(track.property==='fill')string(key.value,'Placed clip fill value');
              else if(track.property==='assetId')textureKey(key.value,'Placed clip texture key');
              else number(key.value,'Placed clip keyframe value');
              discreteSwitch(key,track.property);
              check(['linear','sine','quad','cubic','quart','quint','expo','circ','back','bounce','elastic'].includes(String(key.easing)), 'Unknown placed clip easing family.');
              check(['in','out','inOut'].includes(String(key.direction)), 'Unknown placed clip easing direction.');
              check(['smooth','hold','stepped'].includes(String(key.mode)), 'Unknown placed clip animation mode.');
              if(key.steps!==undefined)positive(key.steps,'Placed clip stepped cadence');
            }
          }
        }
      }
    }
  }
  const elements = model.elements as unknown as StoryElement[];
  const byId = new Map(elements.map(element => [element.id, element]));
  for (const element of elements) {
    if (element.optimize !== undefined)
      check(['auto','motion','static'].includes(String(element.optimize)), 'Invalid rendering optimization hint.');
    if (element.flowAroundId !== undefined) {
      check(element.kind === 'text', 'Only text can flow around a shape.');
      string(element.flowAroundId, 'Text flow shape ID');
      const target = byId.get(element.flowAroundId);
      check(!!target && ['rectangle', 'ellipse', 'polygon', 'image', 'video'].includes(target.kind), 'Text flow refers to a missing shape.');
      check(element.sceneId === target.sceneId, 'Text and its flow shape must belong to the same scene.');
    }
    if (element.textShapeMode !== undefined) {
      check(element.kind === 'text' && ['around','inside','clip'].includes(String(element.textShapeMode)), 'Invalid text and shape mode.');
    }
    if (element.staticTextFlow !== undefined) {
      const snapshot = element.staticTextFlow;
      check(element.kind === 'text' && element.textLayout === 'static' && record(snapshot), 'Only static text can store an arranged shape layout.');
      check(snapshot.mode === 'around' || snapshot.mode === 'inside', 'Invalid static text flow mode.');
      string(snapshot.sourceText, 'Static text source'); string(snapshot.fontFamily, 'Static text font');
      positive(snapshot.fontSize, 'Static text font size'); positive(snapshot.layoutWidth, 'Static text layout width');
      number(snapshot.capturedAt, 'Static text capture time', 0);
      check(Array.isArray(snapshot.lines) && snapshot.lines.length <= 10000, 'Static text layout has too many lines.');
      for (const line of snapshot.lines) {
        check(record(line), 'Invalid static text line.'); string(line.text, 'Static text line');
        number(line.width, 'Static text line width', 0); number(line.x, 'Static text line X'); number(line.y, 'Static text line Y');
        for (const edge of ['start', 'end'] as const) {
          const cursor = line[edge]; check(record(cursor), 'Invalid static text cursor.');
          number(cursor.segmentIndex, 'Static text segment index', 0);
          number(cursor.graphemeIndex, 'Static text grapheme index', 0);
          check(Number.isInteger(cursor.segmentIndex) && Number.isInteger(cursor.graphemeIndex), 'Static text cursor indices must be whole numbers.');
        }
      }
      if (snapshot.outline !== undefined) {
        check(snapshot.mode === 'inside' && Array.isArray(snapshot.outline) && snapshot.outline.length >= 3 && snapshot.outline.length <= 70000, 'Invalid static text contour.');
        for (const point of snapshot.outline) {
          check(record(point), 'Invalid static text contour point.');
          number(point.x, 'Static text contour X'); number(point.y, 'Static text contour Y');
        }
      } else check(snapshot.mode === 'around', 'Inside-shape static text needs a captured contour.');
    }
    if (element.parentId !== undefined) check(elementIds.has(element.parentId), 'An element refers to a missing parent.');
    if (element.attachment !== undefined) {
      check(record(element.attachment), 'Invalid attachment.');
      check(['fixed', 'hinge', 'slider'].includes(element.attachment.type), 'Unknown attachment type.');
      check(elementIds.has(element.attachment.parentId), 'An attachment refers to a missing parent.');
      check(!element.parentId || element.parentId === element.attachment.parentId, 'An element cannot have conflicting parents.');
      for (const key of ['min', 'max'] as const) if (element.attachment[key] !== undefined) number(element.attachment[key], `Attachment ${key}`);
    }
    for (const clip of element.assemblyClips ?? []) for (const track of clip.tracks) {
      let current = byId.get(track.elementId);
      check(!!current, 'An assembly clip refers to a missing part.');
      if(track.property==='assetId')check(visualKinds.includes(current.kind),'Only visual assembly parts can animate a texture.');
      const seen = new Set<string>();
      while (current && current.id !== element.id) {
        check(!seen.has(current.id), 'Circular element attachments are not supported.');
        seen.add(current.id);
        current = byId.get(current.attachment?.parentId ?? current.parentId ?? '');
      }
      check(current?.id === element.id, 'An assembly clip target must belong to its assembly.');
    }
  }
  // Traverse both reference kinds: cycles through mixed attachment/group edges
  // are as invalid as direct parent loops.
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string, depth: number) {
    check(depth < 256, 'Assembly nesting is too deep.');
    check(!visiting.has(id), 'Circular element attachments are not supported.');
    if (visited.has(id)) return;
    visiting.add(id);
    const element = byId.get(id)!;
    for (const parent of new Set([element.parentId, element.attachment?.parentId])) if (parent) visit(parent, depth + 1);
    visiting.delete(id); visited.add(id);
  }
  for (const id of elementIds) visit(id, 0);
  if (!assembly) {
    string(model.id, 'Project ID'); string(model.background, 'Background'); string(model.updatedAt, 'Update time');
    for (const prop of ['width', 'height', 'fps', 'duration']) positive(model[prop], prop);
    check(Array.isArray(model.sequences) && Array.isArray(model.captions), 'Invalid sequences or captions.');
    // Folders only organize the editor list. Older V1 projects may omit them.
    if (model.folders !== undefined) {
      check(Array.isArray(model.folders), 'Scene folders must be an array.');
      const folderIds = new Set<string>();
      for (const folder of model.folders) {
        check(record(folder), 'Invalid scene folder.'); uniqueId(folder.id, folderIds, 'Scene folder ID');
        string(folder.name, 'Scene folder name');
        check(!elementIds.has(folder.id), 'A scene folder and element cannot share an ID.');
      }
      const folders = new Map(model.folders.map(folder => [folder.id as string, folder]));
      for (const folder of model.folders) if (folder.parentId !== undefined) {
        string(folder.parentId, 'Parent scene folder ID');
        check(folderIds.has(folder.parentId), 'A scene folder refers to a missing parent.');
      }
      for (const element of elements) if (element.folderId !== undefined) {
        string(element.folderId, 'Element scene folder ID');
        check(folderIds.has(element.folderId), 'An element refers to a missing scene folder.');
      }
      const seen = new Set<string>();
      function checkFolder(id: string, chain = new Set<string>()) {
        check(chain.size < 256, 'Scene folder nesting is too deep.');
        check(!chain.has(id), 'Circular scene folders are not supported.');
        if (seen.has(id)) return;
        const parent = folders.get(id)?.parentId as string | undefined;
        if (parent) checkFolder(parent, new Set([...chain, id]));
        seen.add(id);
      }
      for (const id of folderIds) checkFolder(id);
    } else {
      check(elements.every(element => element.folderId === undefined), 'An element refers to a missing scene folder.');
    }
    const sequenceIds = new Set<string>(), captionIds = new Set<string>();
    for (const sequence of model.sequences) {
      check(record(sequence), 'Invalid sequence.'); uniqueId(sequence.id, sequenceIds, 'Sequence ID');
      string(sequence.name, 'Sequence name'); string(sequence.color, 'Sequence color'); number(sequence.start, 'Sequence start', 0); positive(sequence.duration, 'Sequence duration');
      if(sequence.sourceSceneId!==undefined)string(sequence.sourceSceneId,'Source scene ID');
      if(sequence.sourceIn!==undefined)number(sequence.sourceIn,'Source in',0);
      if(sequence.sourceOut!==undefined)number(sequence.sourceOut,'Source out',0);
      if(sequence.muted!==undefined)check(typeof sequence.muted==='boolean','Scene mute must be a boolean.');
      if(sequence.mutedSourceClipIds!==undefined){check(Array.isArray(sequence.mutedSourceClipIds),'Muted source clips must be an array.');for(const id of sequence.mutedSourceClipIds)string(id,'Muted source clip ID');}
      if(sequence.frame!==undefined){
        check(record(sequence.frame),'Invalid scene frame.');
        number(sequence.frame.x,'Scene frame X');number(sequence.frame.y,'Scene frame Y');
        positive(sequence.frame.width,'Scene frame width');positive(sequence.frame.height,'Scene frame height');
      }
      if(sequence.frameFit!==undefined)check(typeof sequence.frameFit==='string'&&['fit','fill','stretch'].includes(sequence.frameFit),'Unknown scene frame fitting mode.');
      if(sequence.frameRotation!==undefined)number(sequence.frameRotation,'Scene frame rotation');
      if(sequence.opacity!==undefined){number(sequence.opacity,'Scene opacity',0);check(sequence.opacity<=1,'Scene opacity must be at most 1.');}
      if(sequence.frameStack!==undefined){
        check(Array.isArray(sequence.frameStack)&&sequence.frameStack.length<=256,'Invalid nested scene frames.');
        for(const viewport of sequence.frameStack){
          check(record(viewport),'Invalid nested scene frame.');
          if(viewport.frame!==undefined){
            check(record(viewport.frame),'Invalid nested scene viewport.');
            number(viewport.frame.x,'Nested frame X');number(viewport.frame.y,'Nested frame Y');
            positive(viewport.frame.width,'Nested frame width');positive(viewport.frame.height,'Nested frame height');
          }
          if(viewport.frameFit!==undefined)check(['fit','fill','stretch'].includes(String(viewport.frameFit)),'Unknown nested frame fitting mode.');
          if(viewport.frameRotation!==undefined)number(viewport.frameRotation,'Nested frame rotation');
          if(viewport.opacity!==undefined){number(viewport.opacity,'Nested frame opacity',0);check(viewport.opacity<=1,'Nested frame opacity must be at most 1.');}
        }
      }
      if (sequence.camera !== undefined) {
        check(record(sequence.camera), 'Invalid sequence camera.');
        number(sequence.camera.x, 'Camera X'); number(sequence.camera.y, 'Camera Y');
        number(sequence.camera.rotation, 'Camera rotation'); positive(sequence.camera.zoom, 'Camera zoom');
        check(Array.isArray(sequence.camera.tracks), 'Camera tracks must be an array.');
        const cameraProperties = new Set<string>();
        for (const track of sequence.camera.tracks) {
          check(record(track) && Array.isArray(track.keyframes), 'Invalid camera track.');
          check(['x','y','zoom','rotation'].includes(String(track.property)), 'Unknown camera property.');
          check(!cameraProperties.has(String(track.property)), 'Duplicate camera property.'); cameraProperties.add(String(track.property));
          for (const key of track.keyframes) {
            check(record(key), 'Invalid camera keyframe.'); uniqueId(key.id, keyIds, 'Camera keyframe ID');
            number(key.time, 'Camera keyframe time', 0); check((key.time as number) <= (sequence.duration as number), 'Camera keyframe lies outside its sequence.');
            number(key.value, 'Camera keyframe value', track.property === 'zoom' ? .01 : -Infinity);
            check(['linear','sine','quad','cubic','quart','quint','expo','circ','back','bounce','elastic'].includes(String(key.easing)), 'Unknown camera easing family.');
            check(['in','out','inOut'].includes(String(key.direction)), 'Unknown camera easing direction.');
            check(['smooth','hold','stepped'].includes(String(key.mode)), 'Unknown camera animation mode.');
            if (key.steps !== undefined) positive(key.steps, 'Camera stepped cadence');
          }
        }
      }
    }
    const sequenceById=new Map(model.sequences.map(sequence=>[sequence.id,sequence]));
    const checkedSources=new Set<string>();
    const checkSourceChain=(id:string,ancestors=new Set<string>())=>{
      check(ancestors.size<256,'Scene nesting is too deep.');
      check(!ancestors.has(id),'Circular scene references are not supported.');
      if(checkedSources.has(id))return;
      const sequence=sequenceById.get(id);
      check(!!sequence,'A linked scene refers to a missing source.');
      if(sequence.sourceSceneId){
        const source=sequenceById.get(sequence.sourceSceneId);
        check(!!source,'A linked scene refers to a missing source.');
        const from=sequence.sourceIn??0,to=sequence.sourceOut??source.duration;
        check(to>from&&to<=source.duration,'A linked scene source range is invalid.');
        checkSourceChain(source.id,new Set([...ancestors,id]));
      }
      checkedSources.add(id);
    };
    for(const sequence of model.sequences)checkSourceChain(sequence.id);
    for (const caption of model.captions) {
      check(record(caption), 'Invalid caption.'); uniqueId(caption.id, captionIds, 'Caption ID');
      string(caption.text, 'Caption text'); number(caption.start, 'Caption start', 0); number(caption.end, 'Caption end', 0);
      check(caption.end > caption.start, 'Caption end must be after its start.');
      if (caption.sceneId !== undefined) {
        string(caption.sceneId, 'Caption scene ID'); check(caption.sceneId.length > 0, 'Caption scene ID cannot be empty.');
      }
    }
    for (const element of elements) if (element.sceneId !== undefined) {
      check(sequenceIds.has(element.sceneId), 'An element refers to a missing scene.');
    }
    for (const caption of model.captions) if (caption.sceneId !== undefined) {
      check(sequenceIds.has(caption.sceneId), 'A caption refers to a missing scene.');
    }
  }
}

function escapeXml(value: string): string {
  check(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), 'Text contains unsupported XML control characters.');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;').replaceAll('\r', '&#13;');
}
function encodeValue(value: unknown, depth = 0): string {
  check(depth < 64, 'Manifest nesting is too deep.');
  if (value === null) return '<null/>';
  if (typeof value === 'string') return `<string>${escapeXml(value)}</string>`;
  if (typeof value === 'number') { number(value, 'Manifest number'); return `<number>${value}</number>`; }
  if (typeof value === 'boolean') return `<boolean>${value}</boolean>`;
  if (Array.isArray(value)) return `<array>${value.map(item => encodeValue(item, depth + 1)).join('')}</array>`;
  check(record(value), 'Unsupported manifest value.');
  return `<object>${Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => `<field name="${escapeXml(key)}">${encodeValue(child, depth + 1)}</field>`).join('')}</object>`;
}
function decodeValue(node: Element, depth = 0): unknown {
  check(depth < 64, 'Manifest nesting is too deep.');
  const children = Array.from(node.children);
  const text = node.textContent ?? '';
  switch (node.tagName) {
    case 'null': check(children.length === 0 && text === '', 'Invalid null value.'); return null;
    case 'string': check(children.length === 0, 'Invalid string value.'); return text;
    case 'number': { check(children.length === 0 && text.trim() !== '', 'Invalid number value.'); const n = Number(text); number(n, 'Manifest number'); return n; }
    case 'boolean': check(children.length === 0 && ['true', 'false'].includes(text), 'Invalid boolean value.'); return text === 'true';
    case 'array': return children.map(child => decodeValue(child, depth + 1));
    case 'object': {
      const result: RecordValue = {};
      for (const child of children) {
        const key = child.getAttribute('name');
        check(child.tagName === 'field' && key !== null && child.children.length === 1, 'Invalid object field.');
        check(!['__proto__', 'prototype', 'constructor'].includes(key) && !Object.hasOwn(result, key), 'Unsafe or repeated object field.');
        result[key] = decodeValue(child.children[0], depth + 1);
      }
      return result;
    }
    default: return fail('Unknown XML value type.');
  }
}

function dataBytes(url: string): Uint8Array {
  const comma = url.indexOf(',');
  check(url.startsWith('data:') && comma >= 0, 'Malformed embedded asset.');
  try {
    if (url.slice(0, comma).toLowerCase().endsWith(';base64')) return Uint8Array.from(atob(url.slice(comma + 1)), char => char.charCodeAt(0));
    return strToU8(decodeURIComponent(url.slice(comma + 1)));
  } catch { return fail('Malformed embedded asset encoding.'); }
}
function bytesDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}
function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !/[\\:\u0000]/.test(path) && path.split('/').every(part => part !== '..' && part !== '.' && part !== '');
}
async function readBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.')); reader.readAsArrayBuffer(blob);
  });
}
async function pack(model: DocumentModel, assembly: boolean): Promise<Blob> {
  validate(model, assembly);
  const files: Record<string, Uint8Array> = {};
  const dataPaths = new Map<string, string>();
  let size = 0;
  const assets = model.assets.map(({ dataUrl, ...metadata }, index) => {
    let archivePath = dataPaths.get(dataUrl);
    if (!archivePath) {
      archivePath = `assets/${index}.bin`;
      const bytes = dataBytes(dataUrl); size += bytes.byteLength;
      check(size <= MAX_EXPANDED, 'Project assets exceed the supported archive size.');
      files[archivePath] = bytes; dataPaths.set(dataUrl, archivePath);
    }
    return { ...metadata, archivePath };
  });
  model.assets.forEach((asset,index)=>{if(asset.kind==='font'&&asset.licenseNotice?.trim()){
    const bytes=strToU8(asset.licenseNotice);
    size+=bytes.byteLength;check(size<=MAX_EXPANDED,'Project assets and notices exceed the supported archive size.');
    files[`licenses/fonts/${index}.txt`]=bytes;
  }});
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<hyde-document type="${assembly ? 'assembly' : 'project'}" version="1">${encodeValue({ ...model, assets })}</hyde-document>`;
  files[MANIFEST] = strToU8(xml);
  check(files[MANIFEST].byteLength <= MAX_MANIFEST, 'Manifest exceeds the supported size.');
  check(Object.keys(files).length <= MAX_ENTRIES, 'Too many asset files.');
  const archive = zipSync(files, { level: 1 });
  check(archive.byteLength <= MAX_ARCHIVE, 'Project archive exceeds the supported size.');
  return new Blob([new Uint8Array(archive).buffer], { type: 'application/zip' });
}
async function unpack(file: File, assembly: boolean): Promise<DocumentModel> {
  check((assembly ? /\.hyproj$/i : /\.(hyde|hy)$/i).test(file.name), assembly ? 'Choose a .hyproj assembly file.' : 'Choose a .hyde or .hy project file.');
  check(file.size > 0 && file.size <= MAX_ARCHIVE, 'File is empty or exceeds the supported archive size.');
  let files: Record<string, Uint8Array>;
  try {
    const names = new Set<string>(); let expanded = 0;
    files = unzipSync(await readBytes(file), { filter: entry => {
      check(safePath(entry.name), 'Archive contains an unsafe path.');
      check(!names.has(entry.name), 'Archive contains duplicate paths.'); names.add(entry.name);
      check(names.size <= MAX_ENTRIES, 'Archive contains too many entries.');
      expanded += entry.originalSize;
      check(expanded <= MAX_EXPANDED, 'Expanded archive exceeds the supported size.');
      check(entry.name !== MANIFEST || entry.originalSize <= MAX_MANIFEST, 'Manifest exceeds the supported size.');
      return true;
    } });
  } catch (error) { throw new Error(`Unable to open Hyde archive: ${error instanceof Error ? error.message : 'invalid ZIP data'}`); }
  check(files[MANIFEST], 'Archive is missing manifest.xml.');
  const xml = strFromU8(files[MANIFEST]);
  check(!/<!DOCTYPE|<!ENTITY/i.test(xml), 'Document type and entity declarations are not allowed.');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  check(document.getElementsByTagName('parsererror').length === 0, 'Malformed XML manifest.');
  const root = document.documentElement;
  check(root.tagName === 'hyde-document' && root.getAttribute('version') === '1', 'Unsupported archive format or version.');
  check(root.getAttribute('type') === (assembly ? 'assembly' : 'project'), 'Wrong archive type.');
  check(root.children.length === 1, 'Invalid manifest contents.');
  const model = decodeValue(root.children[0]);
  check(record(model) && Array.isArray(model.assets), 'Invalid asset manifest.');
  model.assets = model.assets.map(asset => {
    check(record(asset), 'Invalid asset entry.');
    const { archivePath, ...metadata } = asset;
    check(typeof archivePath === 'string' && safePath(archivePath) && archivePath.startsWith('assets/') && Object.hasOwn(files, archivePath), 'An asset file is missing or has an invalid path.');
    string(metadata.mime, 'Asset MIME type');
    return { ...metadata, dataUrl: bytesDataUrl(files[archivePath], metadata.mime) };
  });
  validate(model, assembly);
  return model;
}

export function saveProjectBlob(project: Project): Promise<Blob> { return pack(project, false); }
export async function loadProjectFile(file: File): Promise<Project> { return await unpack(file, false) as Project; }
export function saveAssemblyBlob(assembly: Assembly): Promise<Blob> { return pack(assembly, true); }
export async function loadAssemblyFile(file: File): Promise<Assembly> { return await unpack(file, true) as Assembly; }

/** Import is intentionally a local independent copy; only identical binary
 * asset representations are deduplicated in this first model. */
export function importAssembly(project: Project, assembly: Assembly): Project {
  validate(project, false); validate(assembly, true);
  const assetIds = new Map<string, string>(), elementIds = new Map(assembly.elements.map(element => [element.id, uid()]));
  const assets: Asset[] = [...project.assets];
  for (const asset of assembly.assets) {
    const existing = assets.find(candidate => candidate.mime === asset.mime && candidate.dataUrl === asset.dataUrl);
    if (existing) assetIds.set(asset.id, existing.id);
    else { const next = { ...structuredClone(asset), id: uid() }; assets.push(next); assetIds.set(asset.id, next.id); }
  }
  const elements = assembly.elements.map(element => {
    const next = structuredClone(element);
    next.id = elementIds.get(element.id)!;
    delete next.folderId;
    delete next.sceneId;
    if (next.parentId) next.parentId = elementIds.get(next.parentId)!;
    if (next.attachment) next.attachment.parentId = elementIds.get(next.attachment.parentId)!;
    if (next.assetId) next.assetId = assetIds.get(next.assetId)!;
    remapAnimationAssetIds(next,assetIds);
    if (next.flowAroundId) next.flowAroundId = elementIds.get(next.flowAroundId)!;
    for (const track of next.tracks) for (const key of track.keyframes) key.id = uid();
    rekeyMotionBehaviors(next.motionBehaviors);
    remapAssemblyClipReferences(next, elementIds);
    return next;
  });
  return { ...project, assets, elements: [...project.elements, ...elements], updatedAt: new Date().toISOString() };
}

const RECOVERY_LIMIT = 10;
const EXTERNAL_ASSET_LENGTH = 256 * 1024;
const ASSET_GRACE_MS = 24 * 60 * 60 * 1000;
interface RecoveryEntryBase { format: 'hyde-recovery'; order: number; savedAt: number; project: Project }
interface RecoveryEntryV1 extends RecoveryEntryBase { version: 1 }
interface RecoveryEntryV2 extends RecoveryEntryBase { version: 2; assetRefs: BrowserAssetRef[] }
type RecoveryEntry = RecoveryEntryV1 | RecoveryEntryV2;
interface RecoverySchema extends DBSchema {
  recovery: { key: string; value: RecoveryEntry | Project };
}
const recoveryKey = (id: string) => `project:${id}`;
const recoveryRefs = (entry: RecoveryEntry): BrowserAssetRef[] => entry.version === 2 ? entry.assetRefs : [];
function validateRecoveryEntry(value: unknown): RecoveryEntry {
  check(record(value) && value.format === 'hyde-recovery' && (value.version === 1 || value.version === 2), 'Invalid browser recovery entry.');
  check(Number.isSafeInteger(value.order) && Number(value.order) > 0, 'Invalid browser recovery order.');
  number(value.savedAt, 'Recovery save time', 0);
  if (value.version === 1) { validate(value.project, false); return value as unknown as RecoveryEntryV1; }
  check(record(value.project) && Array.isArray(value.project.assets) && Array.isArray(value.assetRefs), 'Invalid browser recovery asset references.');
  const refs = value.assetRefs as unknown[];
  const ids = new Set<string>(), keys = new Set<string>();
  for (const ref of refs) {
    check(validBrowserAssetRef(ref), 'Invalid browser recovery asset reference.');
    check(!ids.has(ref.assetId) && !keys.has(ref.key), 'Repeated browser recovery asset reference.');
    ids.add(ref.assetId); keys.add(ref.key);
  }
  const project = value.project as RecordValue;
  const assets = project.assets as unknown[];
  const validatedAssets = assets.map(asset => {
    if (!record(asset) || !ids.has(String(asset.id))) return asset;
    check(asset.dataUrl === '', 'External browser recovery asset must have an empty inline value.');
    return { ...asset, dataUrl: 'data:application/octet-stream;base64,' };
  });
  for (const id of ids) check(assets.some(asset => record(asset) && asset.id === id), 'Browser recovery asset refers to a missing asset.');
  validate({ ...project, assets: validatedAssets }, false);
  return value as unknown as RecoveryEntryV2;
}
function recoveryEntries(values: unknown[]): RecoveryEntry[] {
  return values.map(validateRecoveryEntry).sort((a, b) => b.order - a.order || b.savedAt - a.savedAt || a.project.id.localeCompare(b.project.id));
}
async function database(): Promise<IDBPDatabase<RecoverySchema>> {
  let connection: IDBPDatabase<RecoverySchema> | undefined;
  connection = await openDB<RecoverySchema>('hyde-local', 2, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      // openDB rejects on an aborted upgrade; consume the separate transaction
      // completion promise as well, so the same failure is not unhandled.
      void transaction.done.catch(() => {});
      if (!db.objectStoreNames.contains('recovery')) db.createObjectStore('recovery');
      if (oldVersion === 1) {
        // A versionchange transaction makes legacy migration all-or-nothing.
        // Keep the existing store, so an aborted upgrade leaves v1 recovery safe.
        void transaction.objectStore('recovery').get('latest').then(async legacy => {
          if (!legacy) return;
          validate(legacy, false);
          const project = legacy as Project;
          const savedAt = Date.parse(project.updatedAt);
          await transaction.objectStore('recovery').put({ format: 'hyde-recovery', version: 1, order: 1, savedAt: Number.isFinite(savedAt) ? Math.max(0, savedAt) : Date.now(), project }, recoveryKey(project.id));
          await transaction.objectStore('recovery').delete('latest');
        }).catch(() => { try { transaction.abort(); } catch { /* already aborted */ } });
      }
    },
    blocking() { connection?.close(); },
  });
  return connection;
}

/** Save and retention share one readwrite transaction. Failed/quota-limited
 * saves cannot evict older recovery copies or leave a partial recent list.
 * A transactional order, rather than project.updatedAt or wall time, makes
 * concurrent saves and projects imported from another device sort reliably. */
export async function saveAutosave(project: Project): Promise<void> {
  validate(project, false);
  const snapshot = structuredClone(project);
  const db = await database();
  const created: BrowserAssetRef[] = [];
  try {
    const priorValue = await db.get('recovery', recoveryKey(snapshot.id));
    const prior = priorValue ? validateRecoveryEntry(priorValue) : null;
    const refs: BrowserAssetRef[] = [];
    for (const asset of snapshot.assets) {
      if (asset.dataUrl.length < EXTERNAL_ASSET_LENGTH) continue;
      const dataUrl = asset.dataUrl;
      const digest = await browserAssetDigest(dataUrl).catch(() => undefined);
      const old = prior && recoveryRefs(prior).find(ref => ref.assetId === asset.id);
      let ref: BrowserAssetRef | undefined;
      // A one-day reuse limit keeps a concurrent tab from reviving a key that
      // another tab is eligible to remove as an orphan.
      if (old && old.createdAt >= Date.now() - ASSET_GRACE_MS) {
        if (digest && old.digest === digest) ref = old;
        else if (await readBrowserAsset(old).then(saved => saved === dataUrl).catch(() => false)) ref = old;
      }
      if (!ref) { ref = await writeBrowserAsset(asset.id, dataUrl, digest); created.push(ref); }
      refs.push(ref);
      asset.dataUrl = '';
    }
    const transaction = db.transaction('recovery', 'readwrite');
    const completion = transaction.done;
    void completion.catch(() => {});
    try {
      const existing = recoveryEntries(await transaction.store.getAll());
      const order = (existing[0]?.order ?? 0) + 1;
      check(Number.isSafeInteger(order), 'Browser recovery order exceeded its supported range.');
      const entry: RecoveryEntry = refs.length
        ? { format: 'hyde-recovery', version: 2, order, savedAt: Date.now(), project: snapshot, assetRefs: refs }
        : { format: 'hyde-recovery', version: 1, order, savedAt: Date.now(), project: snapshot };
      const retained = [entry, ...existing.filter(value => value.project.id !== snapshot.id)];
      await transaction.store.put(entry, recoveryKey(snapshot.id));
      for (const expired of retained.slice(RECOVERY_LIMIT)) await transaction.store.delete(recoveryKey(expired.project.id));
      await completion;
    } catch (error) {
      try { transaction.abort(); } catch { /* transaction may already have aborted */ }
      await completion.catch(() => {});
      throw error;
    }
  } catch (error) {
    await Promise.allSettled(created.map(removeBrowserAsset));
    throw error;
  } finally { db.close(); }
  await schedulePrune();
}
async function hydrateRecovery(entry: RecoveryEntry): Promise<Project> {
  if (entry.version === 1) return entry.project;
  const project = structuredClone(entry.project);
  for (const ref of entry.assetRefs) {
    const asset = project.assets.find(candidate => candidate.id === ref.assetId);
    check(asset, 'Browser recovery asset refers to a missing asset.');
    asset.dataUrl = await readBrowserAsset(ref);
    if (ref.digest) {
      const actual = await browserAssetDigest(asset.dataUrl).catch(() => undefined);
      check(!actual || actual === ref.digest, 'A browser recovery asset failed its integrity check.');
    }
  }
  validate(project, false);
  return project;
}
/** Newest first; callers receive detached snapshots, never a mutable cache. */
export async function listAutosaves(): Promise<Project[]> {
  const db = await database();
  let entries: RecoveryEntry[];
  try { entries = recoveryEntries(await db.getAll('recovery')); }
  finally { db.close(); }
  return Promise.all(entries.map(hydrateRecovery));
}
export async function loadAutosave(): Promise<Project | null> {
  return (await listAutosaves())[0] ?? null;
}
/** Remove browser recovery only. Explicitly downloaded project files are not
 * touched; subsequent edits to the same project may create a new autosave. */
export async function deleteAutosave(id: string): Promise<void> {
  string(id, 'Project ID');
  const db = await database();
  try { await db.delete('recovery', recoveryKey(id)); }
  finally { db.close(); }
  await schedulePrune();
}
/** Remove orphaned payloads after a grace period, never touching data still
 * referenced by a recovery snapshot. Safe to call during ordinary editor use. */
export async function pruneAutosaveAssets(): Promise<void> {
  const db = await database();
  let entries: RecoveryEntry[];
  try { entries = recoveryEntries(await db.getAll('recovery')); }
  finally { db.close(); }
  const live = new Set(entries.flatMap(entry => recoveryRefs(entry).map(ref => ref.key)));
  await pruneBrowserAssets(live, Date.now() - ASSET_GRACE_MS);
}
let lastPrune = 0;
async function schedulePrune(): Promise<void> {
  if (Date.now() - lastPrune < 60_000) return;
  lastPrune = Date.now();
  await pruneAutosaveAssets().catch(() => { lastPrune = 0; });
}
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
