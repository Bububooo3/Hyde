import { uid, type CameraProperty, type CameraTrack, type Caption, type Keyframe, type Project, type Sequence, type SequenceCamera, type StoryElement } from './model';
import { evaluateCameraForScene } from './engine';
import {sceneVisualFrames} from './sceneFrame';
import {remapAssemblyClipReferences} from './assemblyClips';
import {rekeyMotionBehaviors,scaleMotionTime} from './motion';
import {remapObjectMask} from './objectMask';

const cache = new WeakMap<Project, Project>();
const epsilon = 1e-7;

interface SceneContent {
  elements: StoryElement[];
  captions: Caption[];
  placedElements: StoryElement[];
  placedCaptions: Caption[];
}

/** Scene links form a directed acyclic graph, even when their source is itself
 * a placement. A broken source cannot be silently rendered as an empty scene. */
export function validateSceneLinks(project: Pick<Project, 'sequences'>): void {
  const scenes = new Map(project.sequences.map(scene => [scene.id, scene]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(scene: Sequence): void {
    if (visiting.has(scene.id)) throw new Error('Circular linked scenes are not supported.');
    if (visited.has(scene.id)) return;
    visiting.add(scene.id);
    if (scene.sourceSceneId) {
      const source = scenes.get(scene.sourceSceneId);
      if (!source) throw new Error(`The source scene for ${scene.name} is unavailable.`);
      visit(source);
    }
    visiting.delete(scene.id);
    visited.add(scene.id);
  }
  for (const scene of project.sequences) visit(scene);
}

function sourceRange(source: Sequence, placement: Sequence): { start: number; end: number; speed: number } {
  const start = placement.sourceIn ?? 0;
  const end = placement.sourceOut ?? source.duration;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > source.duration + epsilon || end <= start + epsilon) {
    throw new Error(`The source range for ${placement.name} is invalid.`);
  }
  return { start, end, speed: (end - start) / placement.duration };
}

function placedElements(source: Sequence, placement: Sequence, originals: StoryElement[], timedAssets:Set<string>): StoryElement[] {
  const range = sourceRange(source, placement);
  const ids = new Map(originals.map(element => [element.id, `${placement.id}::${element.id}`]));
  const carriesTimedAudio = (element:StoryElement) => {
    if(element.kind==='audio'||element.kind==='video'||!!element.assetId&&timedAssets.has(element.assetId))return true;
    const tracks=[...element.tracks,...(element.assemblyClips??[]).flatMap(clip=>clip.tracks),...(element.clipInstances??[]).flatMap(instance=>instance.trackOverrides??[])];
    return tracks.some(track=>track.property==='assetId'&&track.keyframes.some(key=>typeof key.value==='string'&&timedAssets.has(key.value)));
  };
  return originals.map(original => {
    const element = structuredClone(original);
    element.id = ids.get(original.id)!;
    element.sceneId = placement.id;
    element.start = placement.start + (original.start - source.start - range.start) / range.speed;
    element.duration = original.duration / range.speed;
    element.speed = (original.speed ?? 1) * range.speed;
    if (element.textAnimation) {
      element.textAnimation.start /= range.speed;
      element.textAnimation.duration /= range.speed;
      element.textAnimation.stagger /= range.speed;
    }
    if(element.motionBehaviors)element.motionBehaviors=scaleMotionTime(element.motionBehaviors,1/range.speed);
    element.tracks = original.tracks.map(track => ({...track,keyframes:track.keyframes.map(key => ({...key,id:`${placement.id}::${key.id}`,time:key.time/range.speed}))}));
    if (element.parentId) element.parentId = ids.get(element.parentId) ?? element.parentId;
    if (element.attachment) element.attachment.parentId = ids.get(element.attachment.parentId) ?? element.attachment.parentId;
    if (element.flowAroundId) element.flowAroundId=ids.get(element.flowAroundId)??element.flowAroundId;
    remapObjectMask(element,ids,true);
    if (element.assemblyClips?.length) {
      const clipIds=new Map(element.assemblyClips.map(clip=>[clip.id,`${placement.id}::${clip.id}`]));
      for (const clip of element.assemblyClips) {
        clip.id=clipIds.get(clip.id)!;
        for (const track of clip.tracks) {
          for (const key of track.keyframes) key.id=`${placement.id}::${key.id}`;
        }
      }
      for (const instance of element.clipInstances??[]) {
        instance.id=`${placement.id}::${instance.id}`;
        instance.clipId=clipIds.get(instance.clipId)??instance.clipId;
        for (const track of instance.trackOverrides??[]) {
          for (const key of track.keyframes) key.id=`${placement.id}::${key.id}`;
        }
      }
    }
    if ((placement.muted || placement.mutedSourceClipIds?.includes(original.id)) &&
      carriesTimedAudio(original)) element.muted = true;
    return element;
  });
}

function placedCaptions(source: Sequence, placement: Sequence, originals: Caption[]): Caption[] {
  const range = sourceRange(source, placement);
  return originals.map(caption => ({
    ...caption, id:`${placement.id}::${caption.id}`, sceneId:placement.id,
    start:placement.start + (caption.start-source.start-range.start)/range.speed,
    end:placement.start + (caption.end-source.start-range.start)/range.speed,
  }));
}

/** Resolve each scene once. The source of a nested placement includes both
 * authored content and its derived content, including local audio overrides. */
function deriveSceneContents(project: Project): Map<string, SceneContent> {
  validateSceneLinks(project);
  const timedAssets=new Set(project.assets.filter(asset=>asset.kind==='video'||asset.kind==='audio').map(asset=>asset.id));
  const scenes = new Map(project.sequences.map(scene => [scene.id, scene]));
  const contents = new Map<string, SceneContent>();
  function resolve(scene: Sequence): SceneContent {
    const existing = contents.get(scene.id);
    if (existing) return existing;
    const authoredElements = project.elements.filter(element => element.sceneId === scene.id);
    const authoredCaptions = project.captions.filter(caption => caption.sceneId === scene.id);
    const source = scene.sourceSceneId ? scenes.get(scene.sourceSceneId)! : undefined;
    const sourceContent = source ? resolve(source) : undefined;
    const virtualElements = source && sourceContent ? placedElements(source, scene, sourceContent.elements,timedAssets) : [];
    const virtualCaptions = source && sourceContent ? placedCaptions(source, scene, sourceContent.captions) : [];
    const content = {
      elements: [...authoredElements, ...virtualElements],
      captions: [...authoredCaptions, ...virtualCaptions],
      placedElements: virtualElements,
      placedCaptions: virtualCaptions,
    };
    contents.set(scene.id, content);
    return content;
  }
  for (const scene of project.sequences) resolve(scene);
  return contents;
}

/** Preserve inherited camera motion when breaking a link. A source range can
 * begin or end between authored keys, so evaluate those boundaries explicitly. */
function inheritedCamera(project: Project, placement: Sequence): SequenceCamera | undefined {
  let owner = placement;
  let sourceOffset = 0;
  let sourceSpeed = 1;
  while (!owner.camera && owner.sourceSceneId) {
    const source = project.sequences.find(scene => scene.id === owner.sourceSceneId)!;
    const range = sourceRange(source, owner);
    sourceOffset = range.start + sourceOffset * range.speed;
    sourceSpeed *= range.speed;
    owner = source;
  }
  if (!owner.camera) return undefined;
  const start = evaluateCameraForScene(project, placement, placement.start);
  const finish = evaluateCameraForScene(project, placement, placement.start + placement.duration);
  const properties: CameraProperty[] = ['x', 'y', 'zoom', 'rotation'];
  const tracks: CameraTrack[] = [];
  const endOffset = sourceOffset + sourceSpeed * placement.duration;
  for (const track of owner.camera.tracks ?? []) {
    if (!properties.includes(track.property) || !track.keyframes.length) continue;
    const sorted = [...track.keyframes].sort((a,b)=>a.time-b.time);
    const before = sorted.filter(key=>key.time<=sourceOffset+epsilon).at(-1) ?? sorted[0];
    const after = sorted.filter(key=>key.time<=endOffset+epsilon).at(-1) ?? sorted.at(-1)!;
    const boundary = (key:Keyframe,time:number,value:number):Keyframe => ({
      ...key,id:uid(),time,value,
    });
    const middle = sorted.filter(key=>key.time>sourceOffset+epsilon&&key.time<endOffset-epsilon)
      .map(key=>({...key,id:uid(),time:(key.time-sourceOffset)/sourceSpeed}));
    tracks.push({property:track.property,keyframes:[
      boundary(before,0,start[track.property]),
      ...middle,
      boundary(after,placement.duration,finish[track.property]),
    ]});
  }
  return {...start,tracks};
}

/** A cached, derived view. Virtual parts are never persisted or edited directly. */
export function materializeScenePlacements(project: Project): Project {
  const existing=cache.get(project);
  if(existing)return existing;
  const placements=project.sequences.filter(scene=>scene.sourceSceneId);
  if(!placements.length){cache.set(project,project);return project;}
  const contents=deriveSceneContents(project);
  const elements=placements.flatMap(scene=>contents.get(scene.id)!.placedElements);
  const captions=placements.flatMap(scene=>contents.get(scene.id)!.placedCaptions);
  const result={...project,elements:[...project.elements,...elements],captions:[...project.captions,...captions]};
  cache.set(project,result);
  cache.set(result,result);
  return result;
}

/** A new timeline placement remains linked to its source scene. */
export function placeLinkedScene(project: Project, sourceId: string, start?: number): {project:Project;sceneId:string} {
  validateSceneLinks(project);
  const source=project.sequences.find(scene=>scene.id===sourceId);
  if(!source)throw new Error('Choose an existing scene as the linked source.');
  const at=start??Math.max(project.duration,...project.sequences.map(scene=>scene.start+scene.duration));
  if(!Number.isFinite(at)||at<0)throw new Error('Choose a valid timeline position.');
  const next=structuredClone(project),id=uid();
  const overlap=next.sequences.some(scene=>scene.id===sourceId&&at<scene.start+scene.duration&&at+source.duration>scene.start);
  next.sequences.push({id,name:`${source.name} linked`,start:at,duration:source.duration,color:source.color,sourceSceneId:source.id,muted:overlap});
  next.sequences.sort((a,b)=>a.start-b.start);
  next.duration=Math.max(next.duration,at+source.duration);
  next.updatedAt=new Date().toISOString();
  return {project:next,sceneId:id};
}

/** Break the link by copying the currently derived scene content into this scene. */
export function makeSceneIndependent(project:Project,sceneId:string):Project {
  const placement=project.sequences.find(scene=>scene.id===sceneId);
  if(!placement?.sourceSceneId)throw new Error('Choose a linked scene.');
  const next=structuredClone(project);
  const scene=next.sequences.find(item=>item.id===sceneId)!;
  const resolved=deriveSceneContents(project).get(sceneId)!;
  const elements=resolved.placedElements;
  const captions=resolved.placedCaptions;
  const ids=new Map(elements.map(element=>[element.id,uid()]));
  for(const element of elements){
    const old=element.id;
    if(element.assemblyClips?.length){
      const separator=old.lastIndexOf('::');
      const originalId=separator<0?old:old.slice(separator+2);
      const prefix=separator<0?'':old.slice(0,separator+2);
      const original=project.elements.find(item=>item.id===originalId);
      const timeScale=original&&original.duration>0?element.duration/original.duration:1;
      for(const instance of element.clipInstances??[]){instance.start*=timeScale;instance.duration*=timeScale;}
      const targetIds=new Map<string,string>();
      for(const clip of element.assemblyClips)for(const track of clip.tracks){
        const mapped=ids.get(`${prefix}${track.elementId}`);
        if(mapped)targetIds.set(track.elementId,mapped);
      }
      remapAssemblyClipReferences(element,targetIds);
    }
    element.id=ids.get(old)!;
    if(element.parentId)element.parentId=ids.get(element.parentId)??element.parentId;
    if(element.attachment)element.attachment.parentId=ids.get(element.attachment.parentId)??element.attachment.parentId;
    if(element.flowAroundId)element.flowAroundId=ids.get(element.flowAroundId)??element.flowAroundId;
    remapObjectMask(element,ids,true);
    for(const track of element.tracks)for(const key of track.keyframes)key.id=uid();
    rekeyMotionBehaviors(element.motionBehaviors);
  }
  for(const caption of captions)caption.id=uid();
  next.elements.push(...elements);next.captions.push(...captions);
  if(!scene.camera)scene.camera=inheritedCamera(project,placement);
  scene.frameStack=sceneVisualFrames(project,placement).slice(1).map(viewport=>({
    ...(viewport.frame?{frame:structuredClone(viewport.frame)}:{}),
    ...(viewport.frameFit?{frameFit:viewport.frameFit}:{}),
    ...(viewport.frameRotation!==undefined?{frameRotation:viewport.frameRotation}:{}),
    ...(viewport.opacity!==undefined?{opacity:viewport.opacity}:{}),
  }));
  delete scene.sourceSceneId;delete scene.sourceIn;delete scene.sourceOut;delete scene.muted;delete scene.mutedSourceClipIds;
  next.updatedAt=new Date().toISOString();
  return next;
}

/** Standalone packages carry the rendered sources as ordinary local scenes. */
export function bakeScenePlacements(project:Project):Project {
  validateSceneLinks(project);
  // Descendants must be baked before their linked sources: their per-source
  // mute IDs refer to the pre-baked virtual clips.
  const linked=project.sequences.filter(scene=>scene.sourceSceneId);
  const remaining=new Set(linked.map(scene=>scene.id));
  let next=project;
  while(remaining.size){
    const leaf=[...remaining].find(id=>!next.sequences.some(scene=>remaining.has(scene.id)&&scene.sourceSceneId===id));
    if(!leaf)throw new Error('Circular linked scenes are not supported.');
    next=makeSceneIndependent(next,leaf);
    remaining.delete(leaf);
  }
  return next;
}
