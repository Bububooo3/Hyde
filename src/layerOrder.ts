import type { Project, StoryElement } from './model';
import { parentId } from './editing';

function layerScope(element: StoryElement): string {
  const parent = parentId(element);
  return JSON.stringify([element.sceneId ?? null, parent ?? null, parent ? null : element.folderId ?? null]);
}

/** Move each eligible selected sibling by one slot. Reverse traversal when
 * moving forward keeps selected runs together and leaves other scopes fixed. */
export function moveLayers(project: Project, ids: readonly string[], direction: -1 | 1): Project {
  const selected = new Set(ids);
  const elements = [...project.elements];
  const scopes = new Map<string, number[]>();
  elements.forEach((element, index) => {
    const scope = layerScope(element);
    scopes.set(scope, [...(scopes.get(scope) ?? []), index]);
  });
  let changed = false;
  for (const slots of scopes.values()) {
    const positions = direction > 0 ? [...slots.keys()].reverse() : [...slots.keys()];
    for (const position of positions) {
      const neighbor = position + direction;
      if (neighbor < 0 || neighbor >= slots.length) continue;
      const from = slots[position], to = slots[neighbor];
      const element = elements[from], adjacent = elements[to];
      if (!selected.has(element.id) || element.locked || selected.has(adjacent.id) || adjacent.locked) continue;
      [elements[from], elements[to]] = [adjacent, element];
      changed = true;
    }
  }
  return changed ? { ...project, elements } : project;
}

export function canMoveLayers(project: Project, ids: readonly string[], direction: -1 | 1): boolean {
  return moveLayers(project, ids, direction) !== project;
}
