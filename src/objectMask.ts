import type { Project, StoryElement } from './model';

export const maskObjectKinds = new Set<StoryElement['kind']>(['rectangle', 'ellipse', 'polygon', 'image', 'video']);

export function setObjectMask(project: Project, targetId: string, mode: 'include' | 'exclude', objectIds: readonly string[]): Project {
  const next = structuredClone(project), byId = new Map(next.elements.map(element => [element.id, element]));
  const target = byId.get(targetId);
  if (!target || target.kind === 'audio' || target.kind === 'group') throw new Error('Select a visual target object.');
  if (mode !== 'include' && mode !== 'exclude') throw new Error('Choose Include or Exclude mode.');
  const unique = [...new Set(objectIds)];
  if (unique.length !== objectIds.length || unique.length > 32) throw new Error('Choose up to 32 distinct mask objects.');
  for (const id of unique) {
    const source = byId.get(id);
    if (!source || !maskObjectKinds.has(source.kind)) throw new Error('A mask reference must be an existing shape or visual media object.');
    if (id === targetId) throw new Error('An object cannot mask itself.');
    if (source.sceneId !== target.sceneId) throw new Error('Mask objects must be in the target scene.');
  }
  if (unique.length) target.objectMask = { mode, objectIds: unique };
  else delete target.objectMask;
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error('Object mask references cannot form a cycle.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const ref of byId.get(id)?.objectMask?.objectIds ?? []) visit(ref);
    visiting.delete(id); visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  return next;
}

/** Removing a source removes only its references; empty relationships vanish. */
export function pruneObjectMasks(project: Project, removedIds: ReadonlySet<string>): void {
  for (const element of project.elements) {
    if (!element.objectMask) continue;
    element.objectMask.objectIds = element.objectMask.objectIds.filter(id => !removedIds.has(id));
    if (!element.objectMask.objectIds.length) delete element.objectMask;
  }
}

/** Copies keep internal relationships. Portable assemblies drop external refs. */
export function remapObjectMask(element: StoryElement, mapping: ReadonlyMap<string, string>, dropExternal = false): void {
  if (!element.objectMask) return;
  element.objectMask.objectIds = element.objectMask.objectIds.flatMap(id => {
    const mapped = mapping.get(id);
    return mapped ? [mapped] : dropExternal ? [] : [id];
  });
  if (!element.objectMask.objectIds.length) delete element.objectMask;
}
