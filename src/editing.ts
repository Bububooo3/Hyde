import { evaluateProject } from './engine';
import { createElement,sceneIdAt, uid, type Assembly, type Project, type StoryElement } from './model';
import { importAssembly } from './storage';
import { animationAssetIds, remapAssemblyClipReferences } from './assemblyClips';

/** The same effective parent rule used by the evaluator. */
export function parentId(element: StoryElement): string | undefined {
  return element.attachment?.parentId ?? element.parentId;
}

/** Include selected objects and every descendant, including attachment-only parts. */
export function descendantIds(project: Project, ids: Iterable<string>): Set<string> {
  const available = new Set(project.elements.map(element => element.id));
  const result = new Set([...ids].filter(id => available.has(id)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const element of project.elements) {
      const parent = parentId(element);
      if (parent && result.has(parent) && !result.has(element.id)) {
        result.add(element.id);
        changed = true;
      }
    }
  }
  return result;
}

function referenceTime(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('Choose a finite time at or after the beginning of the story.');
  return value;
}

/** Selection/editing must still work for a hidden object or outside its active span.
 * Extend only evaluation spans, retaining authored anchors and local key times. */
export function worldPoses(project: Project, time: number): Map<string, StoryElement> {
  const scene = {
    ...project,
    elements: project.elements.map(element => ({
      ...element,
      hidden: false,
      start: Math.min(element.start, time),
      duration: Math.max(element.duration, time - element.start + 1),
    })),
  };
  return new Map(evaluateProject(scene, time).map(element => [element.id, element]));
}

function requirePose(poses: Map<string, StoryElement>, id: string): StoryElement {
  const result = poses.get(id);
  if (!result) throw new Error('This object has a missing or circular parent. Repair the assembly before editing its hierarchy.');
  return result;
}

export function offsetPosition(element: StoryElement, x: number, y: number): void {
  element.x += x;
  element.y += y;
  for (const track of element.tracks) {
    if (track.property !== 'x' && track.property !== 'y') continue;
    const delta = track.property === 'x' ? x : y;
    for (const key of track.keyframes) if (typeof key.value === 'number') key.value += delta;
  }
  for (const clip of element.assemblyClips ?? []) for (const track of clip.tracks) {
    if (track.elementId !== element.id || (track.property !== 'x' && track.property !== 'y')) continue;
    const delta = track.property === 'x' ? x : y;
    for (const key of track.keyframes) if (typeof key.value === 'number') key.value += delta;
  }
}

function finish(project: Project): Project {
  project.duration = Math.max(project.duration, ...project.elements.map(element => element.start + element.duration));
  if (project.sequences.length === 1 && project.sequences[0].start === 0) project.sequences[0].duration = project.duration;
  project.updatedAt = new Date().toISOString();
  return project;
}

/** Package a selected subtree. External parent transforms are sampled at `time`;
 * a nonvisual frame preserves the selected part's own motion and constraints. */
export function makeAssembly(project: Project, ids: Iterable<string>, time?: number): Assembly {
  const included = descendantIds(project, ids);
  if (!included.size) throw new Error('Select at least one object to export as an assembly.');
  const originals = project.elements.filter(element => included.has(element.id));
  const earliest = Math.min(...originals.map(element => element.start));
  const latest = Math.max(...originals.map(element => element.start + element.duration));
  const sampleTime = referenceTime(time ?? earliest);
  const poses = worldPoses(project, sampleTime);
  const roots = originals.filter(element => !included.has(parentId(element) ?? ''));
  if (!roots.length) throw new Error('Circular assemblies cannot be exported.');
  // Capture the origin before modifying any copied object, including the first root.
  const origin = requirePose(poses, roots[0].id);
  const originX = origin.x, originY = origin.y;
  const elements = structuredClone(originals);
  const frames = new Map<string, StoryElement>();

  for (const element of elements) {
    delete element.folderId;
    const external = parentId(element);
    if (!external || included.has(external)) continue;
    let frame = frames.get(external);
    if (!frame) {
      const pose = requirePose(poses, external);
      frame = createElement('group', {
        name: `${pose.name} · export frame`, x: pose.x, y: pose.y,
        rotation: pose.rotation, scaleX: pose.scaleX, scaleY: pose.scaleY, opacity: pose.opacity,
        width: 0, height: 0, pivotX: 0, pivotY: 0,
        start: earliest, duration: latest - earliest,
      });
      frames.set(external, frame);
    }
    element.parentId = frame.id;
    if (element.attachment) element.attachment.parentId = frame.id;
  }
  elements.push(...frames.values());
  const allIds = new Set(elements.map(element => element.id));
  for (const element of elements) {
    if (element.assemblyClips) {
      element.assemblyClips = element.assemblyClips.filter(clip => clip.tracks.every(track => allIds.has(track.elementId)));
      const kept = new Set(element.assemblyClips.map(clip => clip.id));
      if (element.clipInstances) element.clipInstances = element.clipInstances.filter(instance => kept.has(instance.clipId));
    }
    if (element.flowAroundId && !allIds.has(element.flowAroundId)) delete element.flowAroundId;
    const parent = parentId(element);
    if (!parent || !allIds.has(parent)) {
      delete element.parentId;
      delete element.attachment;
      offsetPosition(element, -originX, -originY);
    }
    element.start -= earliest;
  }
  const usedAssets = new Set(elements.flatMap(element => [element.assetId,...animationAssetIds(element)].filter((id):id is string=>!!id)));
  const hasText = elements.some(element => element.kind === 'text');
  return {
    format: 'hyde-assembly', version: 1, name: roots[0].name,
    elements,
    assets: structuredClone(project.assets.filter(asset => usedAssets.has(asset.id) || hasText && asset.kind === 'font')),
  };
}

/** Insert a portable assembly with its root anchor centered and earliest content at time. */
export function insertAssemblyAt(project: Project, assembly: Assembly, time: number): Project {
  referenceTime(time);
  if (!assembly.elements.length) throw new Error('This assembly does not contain any objects.');
  const imported = importAssembly(structuredClone(project), assembly);
  const previousIds = new Set(project.elements.map(element => element.id));
  const inserted = imported.elements.filter(element => !previousIds.has(element.id));
  const insertedIds = new Set(inserted.map(element => element.id));
  const roots = inserted.filter(element => !insertedIds.has(parentId(element) ?? ''));
  if (!roots.length) throw new Error('This assembly does not have a valid root.');
  const originX = roots[0].x, originY = roots[0].y;
  const earliest = Math.min(...inserted.map(element => element.start));
  for (const element of inserted) {
    if (!insertedIds.has(parentId(element) ?? '')) offsetPosition(element, project.width / 2 - originX, project.height / 2 - originY);
    element.start += time - earliest;
  }
  return finish(imported);
}

function localVector(parent: StoryElement | undefined, x: number, y: number): { x: number; y: number } {
  if (!parent) return { x, y };
  if (Math.abs(parent.scaleX) < 1e-10 || Math.abs(parent.scaleY) < 1e-10) throw new Error('An object under a zero-scale parent cannot be repositioned.');
  const radians = -parent.rotation * Math.PI / 180;
  return {
    x: (x * Math.cos(radians) - y * Math.sin(radians)) / parent.scaleX,
    y: (x * Math.sin(radians) + y * Math.cos(radians)) / parent.scaleY,
  };
}

/** Duplicate subtrees as independent scene objects, keeping reusable assets shared. */
export function duplicateElements(project: Project, ids: Iterable<string>): { project: Project; ids: string[] } {
  const included = descendantIds(project, ids);
  if (!included.size) return { project: structuredClone(project), ids: [] };
  const originals = project.elements.filter(element => included.has(element.id));
  const mapping = new Map(originals.map(element => [element.id, uid()]));
  const poses = worldPoses(project, Math.min(...originals.map(element => element.start)));
  const copies = structuredClone(originals);
  for (const copy of copies) {
    const external = parentId(copy);
    copy.id = mapping.get(copy.id)!;
    copy.name += ' copy';
    if (!external || !included.has(external)) {
      const offset = localVector(external ? requirePose(poses, external) : undefined, 24, 24);
      offsetPosition(copy, offset.x, offset.y);
    }
    if (copy.parentId && mapping.has(copy.parentId)) copy.parentId = mapping.get(copy.parentId)!;
    if (copy.attachment && mapping.has(copy.attachment.parentId)) copy.attachment.parentId = mapping.get(copy.attachment.parentId)!;
    if (copy.flowAroundId && mapping.has(copy.flowAroundId)) copy.flowAroundId = mapping.get(copy.flowAroundId)!;
    for (const track of copy.tracks) for (const key of track.keyframes) key.id = uid();
    remapAssemblyClipReferences(copy, mapping);
  }
  const next = structuredClone(project);
  next.elements.push(...copies);
  return { project: finish(next), ids: copies.map(element => element.id) };
}

function ancestors(project: Project, id: string | undefined): StoryElement[] {
  const result: StoryElement[] = [], visited = new Set<string>();
  const byId = new Map(project.elements.map(element => [element.id, element]));
  while (id) {
    if (visited.has(id)) throw new Error('That parent relationship would create a cycle.');
    visited.add(id);
    const element = byId.get(id);
    if (!element) throw new Error('The chosen parent no longer exists.');
    result.push(element);
    id = parentId(element);
  }
  return result;
}

/** Preserve the current stage pose when changing a static hierarchy. Animated
 * ancestor changes require baking and are explicitly unavailable in this build. */
export function reparentElement(project: Project, id: string, newParentId: string | undefined, time: number): Project {
  referenceTime(time);
  const original = project.elements.find(element => element.id === id);
  if (!original) throw new Error('The selected object no longer exists.');
  const targetParent = newParentId || undefined;
  if (parentId(original) === targetParent) return structuredClone(project);
  const oldChain = ancestors(project, id);
  const newChain = ancestors(project, targetParent);
  if (newChain.some(element => element.id === id)) throw new Error('That parent relationship would create a cycle.');
  const transformProperties = new Set(['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity']);
  if ([...oldChain, ...newChain].some(element => element.tracks.some(track => transformProperties.has(track.property) && track.keyframes.length))) {
    throw new Error('Reparenting animated transforms or inherited opacity requires animation baking, which is not available yet. Keep this hierarchy or remove those tracks first.');
  }
  const poses = worldPoses(project, time);
  const world = requirePose(poses, id);
  const parent = targetParent ? requirePose(poses, targetParent) : undefined;
  const local = localVector(parent, world.x - (parent?.x ?? 0), world.y - (parent?.y ?? 0));
  if (parent?.opacity === 0 && world.opacity > 0) throw new Error('A fully transparent parent cannot preserve this object’s visible appearance.');
  const next = structuredClone(project);
  const element = next.elements.find(candidate => candidate.id === id)!;
  Object.assign(element, {
    x: local.x, y: local.y,
    rotation: world.rotation - (parent?.rotation ?? 0),
    scaleX: world.scaleX / (parent?.scaleX ?? 1),
    scaleY: world.scaleY / (parent?.scaleY ?? 1),
    opacity: parent ? parent.opacity > 0 ? world.opacity / parent.opacity : original.opacity : world.opacity,
  });
  if (element.opacity > 1 + 1e-10) throw new Error('This parent is too transparent to preserve the object’s current opacity.');
  element.opacity = Math.min(1, element.opacity);
  if (targetParent) element.parentId = targetParent; else delete element.parentId;
  // A constraint's old anchors and limits do not describe the new coordinate space.
  delete element.attachment;
  if(targetParent){
    const parentElement=next.elements.find(candidate=>candidate.id===targetParent)!;
    const owner=parentElement.sceneId??sceneIdAt(next,parentElement.start);
    const moved=descendantIds(next,[id]);
    for(const child of next.elements)if(moved.has(child.id))child.sceneId=owner;
  }
  return finish(next);
}

/** Move a complete assembly in time without changing internal offsets or local keys. */
export function translateAssemblyTime(project: Project, id: string, newStart: number): Project {
  referenceTime(newStart);
  const original = project.elements.find(element => element.id === id);
  if (!original) throw new Error('The selected object no longer exists.');
  const included = descendantIds(project, [id]);
  const delta = newStart - original.start;
  if (project.elements.some(element => included.has(element.id) && element.start + delta < -1e-10)) throw new Error('Moving this assembly would put one of its parts before the beginning of the story.');
  const next = structuredClone(project);
  for (const element of next.elements) if (included.has(element.id)) element.start = Math.max(0, element.start + delta);
  return finish(next);
}

/** Move an editor folder without changing stage drawing or element transforms. */
export function moveSceneFolder(project: Project, id: string, newParentId?: string): Project {
  const next = structuredClone(project);
  const folder = next.folders?.find(candidate => candidate.id === id);
  if (!folder) throw new Error('The folder no longer exists.');
  if (newParentId && !next.folders?.some(candidate => candidate.id === newParentId)) throw new Error('The destination folder no longer exists.');
  let ancestor = newParentId;
  const visited = new Set<string>();
  while (ancestor) {
    if (ancestor === id || visited.has(ancestor)) throw new Error('A folder cannot be moved inside itself.');
    visited.add(ancestor);
    ancestor = next.folders?.find(candidate => candidate.id === ancestor)?.parentId;
  }
  if (newParentId) folder.parentId = newParentId; else delete folder.parentId;
  return finish(next);
}

/** Removing a folder promotes its contents into the containing folder. */
export function removeSceneFolder(project: Project, id: string): Project {
  const next = structuredClone(project);
  const folder = next.folders?.find(candidate => candidate.id === id);
  if (!folder) throw new Error('The folder no longer exists.');
  for (const child of next.folders ?? []) if (child.parentId === id) child.parentId = folder.parentId;
  for (const element of next.elements) if (element.folderId === id) element.folderId = folder.parentId;
  next.folders = next.folders?.filter(candidate => candidate.id !== id) ?? [];
  return finish(next);
}
