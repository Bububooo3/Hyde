import { assignSceneOwnership,captionWindow,elementWindow, uid, type Caption, type Project, type Sequence, type StoryElement } from './model';
import { remapAssemblyClipReferences } from './assemblyClips';
import { rekeyMotionBehaviors, scaleMotionTime } from './motion';
import { pruneObjectMasks, remapObjectMask } from './objectMask';

const EPSILON = 1e-7;
const end = (scene: Sequence) => scene.start + scene.duration;

interface SceneContext {
  project: Project;
  scenes: Sequence[];
  scene: Sequence;
  ownedElements: StoryElement[];
  ownedCaptions: Caption[];
  ownedIds: Set<string>;
}

/** Resolve legacy clips once, then use explicit source-scene IDs. Timeline
 * overlaps and gaps are valid; neither can make an owned clip ambiguous. */
function context(project: Project, sceneId: string): SceneContext {
  const normalized = assignSceneOwnership(project);
  const scenes = normalized.sequences.slice().sort((a, b) => a.start - b.start);
  const scene = scenes.find(item => item.id === sceneId);
  if (!scene) throw new Error('The selected scene no longer exists.');
  const ownedElements = normalized.elements.filter(element => element.sceneId === sceneId);
  return {
    project: normalized, scenes, scene, ownedElements,
    ownedCaptions: normalized.captions.filter(caption => caption.sceneId === sceneId),
    ownedIds: new Set(ownedElements.map(element => element.id)),
  };
}

/** Constraints and inherited transforms must move with their parent. */
function ensureIndependentHierarchy(project: Project, selectedIds: Set<string>): void {
  for (const element of project.elements) {
    const parentIds = [element.parentId, element.attachment?.parentId].filter((id): id is string => !!id);
    if (parentIds.some(parentId => selectedIds.has(parentId) !== selectedIds.has(element.id))) {
      throw new Error('This scene shares an assembly with another scene. Keep its parts together before editing the scene.');
    }
  }
}

function ensureOwnedHierarchy(project: Project): void {
  const byId = new Map(project.elements.map(element => [element.id, element]));
  for (const element of project.elements) {
    for (const parentId of [element.parentId, element.attachment?.parentId]) {
      if (parentId && byId.get(parentId)?.sceneId !== element.sceneId) {
        throw new Error('Moving scenes would separate parts of an assembly across scenes.');
      }
    }
  }
}

/** Shift complete later scenes and all their content, including clips that
 * cross the insertion point. Global clips in gaps follow their own root start. */
function shiftFollowing(project: Project, boundary: number, delta: number): void {
  if (!delta) return;
  const shiftedScenes = new Set(project.sequences.filter(scene => scene.start >= boundary - EPSILON).map(scene => scene.id));
  const byId = new Map(project.elements.map(element => [element.id, element]));
  function root(element: StoryElement): StoryElement {
    const parent = byId.get(element.parentId ?? element.attachment?.parentId ?? '');
    return parent && parent !== element ? root(parent) : element;
  }
  for (const element of project.elements) {
    if (element.sceneId ? shiftedScenes.has(element.sceneId) : root(element).start >= boundary - EPSILON) element.start += delta;
  }
  for (const caption of project.captions) {
    if (caption.sceneId ? shiftedScenes.has(caption.sceneId) : caption.start >= boundary - EPSILON) {
      caption.start += delta; caption.end += delta;
    }
  }
  for (const scene of project.sequences) if (shiftedScenes.has(scene.id)) scene.start += delta;
}

function ensureValidTiming(project: Project): void {
  if (project.elements.some(element => element.start < -EPSILON) ||
      project.captions.some(caption => caption.start < -EPSILON || caption.end <= caption.start) ||
      project.sequences.some(scene => scene.start < -EPSILON)) {
    throw new Error('This scene change would move content before the start of the project.');
  }
}

function finish(project: Project, requestedDuration: number): Project {
  ensureValidTiming(project);
  project.duration = Math.max(
    1 / project.fps, requestedDuration,
    ...project.elements.map(element => elementWindow(project,element)?.end??0),
    ...project.captions.map(caption => captionWindow(project,caption)?.end??0),
    ...project.sequences.map(end),
  );
  project.updatedAt = new Date().toISOString();
  return project;
}

/** Insert a copy after the source scene. Scenes beginning at or after that
 * boundary ripple together with their content; overlapping earlier scenes
 * retain their authored timing. */
export function duplicateScene(project: Project, sceneId: string): { project: Project; sceneId: string; start: number } {
  const { project: source, scene, ownedElements, ownedCaptions, ownedIds } = context(project, sceneId);
  ensureIndependentHierarchy(source, ownedIds);
  const boundary = end(scene);
  const copyIds = new Map(ownedElements.map(element => [element.id, uid()]));
  const newSceneId = uid();
  const copiedElements = structuredClone(ownedElements).map(element => {
    element.id = copyIds.get(element.id)!;
    element.sceneId = newSceneId;
    element.start += scene.duration;
    if (element.parentId) element.parentId = copyIds.get(element.parentId)!;
    if (element.attachment) element.attachment.parentId = copyIds.get(element.attachment.parentId)!;
    if (element.flowAroundId) element.flowAroundId = copyIds.get(element.flowAroundId)!;
    remapObjectMask(element,copyIds,true);
    for (const track of element.tracks) for (const keyframe of track.keyframes) keyframe.id = uid();
    rekeyMotionBehaviors(element.motionBehaviors);
    remapAssemblyClipReferences(element, copyIds);
    return element;
  });
  const copiedCaptions = structuredClone(ownedCaptions).map(caption => ({
    ...caption, id: uid(), sceneId: newSceneId, start: caption.start + scene.duration, end: caption.end + scene.duration,
  }));
  const copiedScene = structuredClone(scene);
  copiedScene.id = newSceneId;
  copiedScene.name = `${scene.name} copy`;
  copiedScene.start = boundary;
  for (const track of copiedScene.camera?.tracks ?? []) for (const key of track.keyframes) key.id = uid();
  const next = structuredClone(source);
  shiftFollowing(next, boundary, scene.duration);
  next.elements.push(...copiedElements);
  next.captions.push(...copiedCaptions);
  next.sequences.push(copiedScene);
  next.sequences.sort((a, b) => a.start - b.start);
  return { project: finish(next, project.duration + scene.duration), sceneId: newSceneId, start: boundary };
}

/** Remove a scene and only its owned content, then close its interval. */
export function deleteScene(project: Project, sceneId: string): Project {
  const { project: source, scene, ownedIds, ownedCaptions } = context(project, sceneId);
  if (source.sequences.length <= 1) throw new Error('A project needs at least one scene.');
  if(source.sequences.some(item=>item.sourceSceneId===sceneId))throw new Error('This scene has linked placements. Make them independent or delete them first.');
  ensureIndependentHierarchy(source, ownedIds);
  const captionIds = new Set(ownedCaptions.map(caption => caption.id));
  const next = structuredClone(source);
  next.elements = next.elements.filter(element => !ownedIds.has(element.id));
  pruneObjectMasks(next,ownedIds);
  next.captions = next.captions.filter(caption => !captionIds.has(caption.id));
  next.sequences = next.sequences.filter(item => item.id !== sceneId);
  shiftFollowing(next, end(scene), -scene.duration);
  return finish(next, project.duration - scene.duration);
}

/** Reorder scenes while preserving each item's offset from its source scene.
 * The gap or overlap at each timeline boundary stays in that position. */
export function moveScene(project: Project, sceneId: string, targetSceneId?: string): Project {
  const { project: source, scenes } = context(project, sceneId);
  if (sceneId === targetSceneId) return source;
  if (targetSceneId && !scenes.some(scene => scene.id === targetSceneId)) throw new Error('The destination scene no longer exists.');
  if (!targetSceneId && scenes.at(-1)?.id === sceneId) return source;
  ensureOwnedHierarchy(source);
  const reordered = scenes.filter(scene => scene.id !== sceneId);
  const destination = targetSceneId ? reordered.findIndex(scene => scene.id === targetSceneId) : reordered.length;
  reordered.splice(destination, 0, scenes.find(scene => scene.id === sceneId)!);
  const gaps = scenes.slice(1).map((scene, index) => scene.start - end(scenes[index]));
  const newStarts = new Map<string, number>();
  let cursor = scenes[0].start;
  for (let index = 0; index < reordered.length; index++) {
    if (index > 0) {
      const candidate = cursor + reordered[index - 1].duration + gaps[index - 1];
      // An extreme overlap can exceed the newly preceding scene's duration.
      // Retain the original onset separation in that case, so order stays clear.
      const oldOnset = scenes[index].start - scenes[index - 1].start;
      cursor = candidate > cursor + EPSILON ? candidate : cursor + Math.max(1 / source.fps, oldOnset);
    }
    newStarts.set(reordered[index].id, cursor);
  }
  const next = structuredClone(source);
  const oldStarts = new Map(scenes.map(scene => [scene.id, scene.start]));
  const delta = (sceneId: string) => newStarts.get(sceneId)! - oldStarts.get(sceneId)!;
  for (const element of next.elements) if (element.sceneId) element.start += delta(element.sceneId);
  for (const caption of next.captions) if (caption.sceneId) {
    const offset = delta(caption.sceneId); caption.start += offset; caption.end += offset;
  }
  for (const scene of next.sequences) scene.start = newStarts.get(scene.id)!;
  next.sequences.sort((a, b) => a.start - b.start);
  return finish(next, project.duration);
}

/** Scale one scene and its owned clips/keys, then ripple later scenes. */
export function retimeScene(project: Project, sceneId: string, newDuration: number): Project {
  const { project: source, scene, ownedElements, ownedIds } = context(project, sceneId);
  if (!Number.isFinite(newDuration) || newDuration < 1 / source.fps - EPSILON) {
    throw new Error('Scene duration must be at least one project frame.');
  }
  // Frame counts are integral; HTML number-step arithmetic and decimal input
  // must never decide which authored durations are valid.
  newDuration = Math.max(1,Math.round(newDuration*source.fps))/source.fps;
  if (Math.abs(newDuration - scene.duration) < EPSILON) return source;
  ensureIndependentHierarchy(source, ownedIds);
  const factor = newDuration / scene.duration;
  const timedMedia = new Set(source.assets.filter(asset => asset.kind === 'video' || asset.kind === 'audio').map(asset => asset.id));
  const hasTimedMedia = (element: StoryElement) => element.kind === 'video' || element.kind === 'audio' || !!element.assetId && timedMedia.has(element.assetId);
  for (const element of ownedElements) {
    if (element.duration * factor < 1 / source.fps - EPSILON) {
      throw new Error('Retime would make a clip shorter than one project frame.');
    }
    if (hasTimedMedia(element)) {
      const speed = (element.speed ?? 1) / factor;
      if (speed < .25 - EPSILON || speed > 4 + EPSILON) {
        throw new Error('Retime would put media playback outside the supported 0.25×–4× speed range.');
      }
    }
  }
  const oldEnd = end(scene), delta = newDuration - scene.duration;
  const next = structuredClone(source);
  shiftFollowing(next, oldEnd, delta);
  for (const element of next.elements) if (element.sceneId === sceneId) {
    element.start = scene.start + (element.start - scene.start) * factor;
    element.duration *= factor;
    if (element.textAnimation) {
      element.textAnimation.start *= factor;
      element.textAnimation.duration *= factor;
      element.textAnimation.stagger *= factor;
    }
    if(element.motionBehaviors)element.motionBehaviors=scaleMotionTime(element.motionBehaviors,factor);
    for (const track of element.tracks) for (const keyframe of track.keyframes) keyframe.time *= factor;
    for (const instance of element.clipInstances ?? []) { instance.start *= factor; instance.duration *= factor; }
    if (hasTimedMedia(element)) element.speed = (element.speed ?? 1) / factor;
  }
  for (const caption of next.captions) if (caption.sceneId === sceneId) {
    caption.start = scene.start + (caption.start - scene.start) * factor;
    caption.end = scene.start + (caption.end - scene.start) * factor;
  }
  const target = next.sequences.find(item => item.id === sceneId)!;
  target.duration = newDuration;
  for (const track of target.camera?.tracks ?? []) for (const key of track.keyframes) key.time *= factor;
  for(const placement of next.sequences)if(placement.sourceSceneId===sceneId){
    if(placement.sourceIn!==undefined)placement.sourceIn*=factor;
    if(placement.sourceOut!==undefined)placement.sourceOut*=factor;
  }
  return finish(next, project.duration + delta);
}
