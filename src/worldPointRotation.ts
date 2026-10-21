import { evaluateElement, evaluateProject } from './engine';
import { parentId } from './editing';
import { uid, type AnimProperty, type Project, type StoryElement } from './model';

export interface WorldPoint { x: number; y: number }

/** Rotate an evaluated world-space pivot around a fixed point without changing its artwork pivot. */
export function rotatedWorldPivot(pivot: WorldPoint, center: WorldPoint, degrees: number): WorldPoint {
  const radians = degrees * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  const x = pivot.x - center.x, y = pivot.y - center.y;
  return { x: center.x + x*c - y*s, y: center.y + x*s + y*c };
}

function localPosition(world: WorldPoint, parent?: StoryElement): WorldPoint {
  if (!parent) return world;
  const a = -parent.rotation * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const dx = world.x - parent.x, dy = world.y - parent.y;
  return { x: (dx*c - dy*s)/parent.scaleX, y: (dx*s + dy*c)/parent.scaleY };
}

function writeTransform(element: StoryElement, property: AnimProperty & ('x'|'y'|'rotation'), value: number, time: number, fps: number, recordKeys: boolean) {
  if (!recordKeys) { element[property] = value; return; }
  let track = element.tracks.find(item => item.property === property);
  if (!track) { track = {property, keyframes: []}; element.tracks.push(track); }
  const at = Math.min(element.duration, Math.max(0, Math.round((time-element.start)*fps)/fps));
  const key = track.keyframes.find(item => Math.abs(item.time-at)<1e-6);
  if (key) key.value = value;
  else track.keyframes.push({id:uid(),time:at,value,easing:'linear',direction:'inOut',mode:'smooth'});
  track.keyframes.sort((a,b)=>a.time-b.time);
}

/** One project mutation for stage dragging or numeric rotation. Selected descendants follow
 * their selected parent rather than rotating twice. Existing animation requires Auto key. */
export function rotateSelectionAroundWorldPoint(project: Project, ids: readonly string[], time: number, center: WorldPoint, degrees: number, recordKeys: boolean): Project {
  if (![time,center.x,center.y,degrees].every(Number.isFinite)) throw new Error('Choose a finite world point and rotation.');
  const selected = new Set(ids), originals = project.elements.filter(element => selected.has(element.id));
  const byId = new Map(project.elements.map(element=>[element.id,element]));
  const roots = originals.filter(element => {
    const seen = new Set<string>();
    let parent = parentId(element);
    while (parent && !seen.has(parent)) {
      if (selected.has(parent)) return false;
      seen.add(parent);
      parent = byId.get(parent) ? parentId(byId.get(parent)!) : undefined;
    }
    return true;
  });
  if (!roots.length) throw new Error('Select an object to rotate.');
  if (new Set(roots.map(element=>element.sceneId)).size>1) throw new Error('Rotate objects from one scene at a time.');
  for (const element of roots) {
    if (element.locked || element.kind==='audio') throw new Error('Locked and audio objects cannot be rotated on the stage.');
    if (element.attachment) throw new Error('Detach constrained parts before rotating around a world point.');
    if (!recordKeys && element.tracks.some(track=>['x','y','rotation'].includes(track.property)&&track.keyframes.length))
      throw new Error('Turn on Auto key to rotate an animated object around a world point.');
  }
  const poses = new Map(evaluateProject(project,time).map(element=>[element.id,element]));
  const next = structuredClone(project);
  for (const original of roots) {
    const world = poses.get(original.id), local = evaluateElement(original,time)??original;
    if (!world) throw new Error('Move the playhead into the selected object’s active time.');
    const parent = parentId(original) ? poses.get(parentId(original)!) : undefined;
    if (parentId(original) && !parent) throw new Error('The selected object’s parent is not active.');
    const target = next.elements.find(element=>element.id===original.id)!;
    const position = localPosition(rotatedWorldPivot(world,center,degrees),parent);
    writeTransform(target,'x',position.x,time,next.fps,recordKeys);
    writeTransform(target,'y',position.y,time,next.fps,recordKeys);
    writeTransform(target,'rotation',local.rotation+degrees,time,next.fps,recordKeys);
  }
  return next;
}
