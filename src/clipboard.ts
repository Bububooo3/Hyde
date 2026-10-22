import { evaluateProject } from './engine';
import { descendantIds, insertAssemblyAt, makeAssembly, offsetPosition, parentId } from './editing';
import { sceneIdAt, type Assembly, type Project } from './model';

/** A portable in-session copy that owns its assets and does not retain live model references. */
export interface ObjectClipboard {
  assembly: Assembly;
  selectedIndices: number[];
  anchorIndex: number;
  anchor: { x: number; y: number };
}

function poseAt(project: Project, id: string, time: number) {
  // Selected objects can be outside their authored span. Sample their transforms
  // without changing the stored visibility range or key times.
  const extended = {
    ...project,
    elements: project.elements.map(element => ({
      ...element,
      hidden: false,
      start: Math.min(element.start, time),
      duration: Math.max(element.duration, time - element.start + 1),
    })),
  };
  const pose = evaluateProject(extended, time).find(element => element.id === id);
  if (!pose) throw new Error('The copied object has a missing or circular parent.');
  return { x: pose.x, y: pose.y };
}

export function copyObjects(project: Project, selectedIds: readonly string[], time: number): ObjectClipboard {
  const included = descendantIds(project, selectedIds);
  if (!included.size) throw new Error('Select an object to copy.');
  const assembly = makeAssembly(project, included, time);
  const indices = new Map(assembly.elements.map((element, index) => [element.id, index]));
  const selectedIndices = selectedIds.map(id => indices.get(id)).filter((index): index is number => index !== undefined);
  const anchorIndex = selectedIndices[0] ?? 0;
  return { assembly, selectedIndices, anchorIndex, anchor: poseAt(project, assembly.elements[anchorIndex].id, time) };
}

/** Paste at the playhead, preserving the copied stage position and relative hierarchy. */
export function pasteObjects(project: Project, clipboard: ObjectClipboard, time: number, pasteCount = 1): { project: Project; ids: string[] } {
  if (!Number.isSafeInteger(pasteCount) || pasteCount < 1) throw new Error('Invalid paste count.');
  const next = insertAssemblyAt(project, clipboard.assembly, time);
  const inserted = next.elements.slice(project.elements.length);
  const anchor = inserted[clipboard.anchorIndex];
  if (!anchor) throw new Error('The copied object is missing from its assembly.');
  const placed = poseAt(next, anchor.id, time);
  const offset = Math.min(pasteCount, 20) * 24;
  const deltaX = clipboard.anchor.x + offset - placed.x;
  const deltaY = clipboard.anchor.y + offset - placed.y;
  const insertedIds = new Set(inserted.map(element => element.id));
  const sceneId = sceneIdAt(next, time);
  for (const element of inserted) {
    element.sceneId = sceneId;
    if (!insertedIds.has(parentId(element) ?? '')) offsetPosition(element, deltaX, deltaY);
  }
  return { project: next, ids: clipboard.selectedIndices.map(index => inserted[index]?.id).filter((id): id is string => !!id) };
}
