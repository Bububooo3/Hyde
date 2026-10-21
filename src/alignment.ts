import { evaluateProject } from './engine';
import { descendantIds, parentId } from './editing';
import type { Project, StoryElement } from './model';

export type Alignment = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom' | 'distributeX' | 'distributeY';
type Bounds = { left: number; right: number; top: number; bottom: number };

function elementBounds(element: StoryElement): Bounds {
  const radians = element.rotation * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  const corners = [[0, 0], [element.width, 0], [element.width, element.height], [0, element.height]];
  const points = corners.map(([x, y]) => {
    const localX = (x - element.width * element.pivotX) * element.scaleX;
    const localY = (y - element.height * element.pivotY) * element.scaleY;
    return { x: element.x + localX * cosine - localY * sine, y: element.y + localX * sine + localY * cosine };
  });
  return {
    left: Math.min(...points.map(point => point.x)), right: Math.max(...points.map(point => point.x)),
    top: Math.min(...points.map(point => point.y)), bottom: Math.max(...points.map(point => point.y)),
  };
}

function union(bounds: Bounds[]): Bounds {
  return {
    left: Math.min(...bounds.map(item => item.left)), right: Math.max(...bounds.map(item => item.right)),
    top: Math.min(...bounds.map(item => item.top)), bottom: Math.max(...bounds.map(item => item.bottom)),
  };
}

function localDelta(parent: StoryElement | undefined, dx: number, dy: number): { x: number; y: number } {
  if (!parent) return { x: dx, y: dy };
  if (Math.abs(parent.scaleX) < 1e-10 || Math.abs(parent.scaleY) < 1e-10) throw new Error('Cannot align a part under a zero-scale parent.');
  const radians = -parent.rotation * Math.PI / 180;
  return {
    x: (dx * Math.cos(radians) - dy * Math.sin(radians)) / parent.scaleX,
    y: (dx * Math.sin(radians) + dy * Math.cos(radians)) / parent.scaleY,
  };
}

/** Shift authored positions and every position key, preserving animation around the new location. */
function shift(element: StoryElement, dx: number, dy: number): void {
  element.x += dx;
  element.y += dy;
  for (const track of element.tracks) {
    if (track.property !== 'x' && track.property !== 'y') continue;
    const delta = track.property === 'x' ? dx : dy;
    for (const key of track.keyframes) if (typeof key.value === 'number') key.value += delta;
  }
}

/** Align selected visible objects in stage space without changing their animation or parent hierarchy. */
export function alignSelection(project: Project, ids: Iterable<string>, time: number, mode: Alignment): Project {
  const selected = new Set(ids);
  const byId = new Map(project.elements.map(element => [element.id, element]));
  const hasSelectedAncestor = (element: StoryElement) => {
    let ancestor = parentId(element);
    const visited = new Set<string>();
    while (ancestor && !visited.has(ancestor)) {
      if (selected.has(ancestor)) return true;
      visited.add(ancestor);
      const parent = byId.get(ancestor);
      ancestor = parent ? parentId(parent) : undefined;
    }
    return false;
  };
  const roots = project.elements.filter(element => selected.has(element.id) && !hasSelectedAncestor(element));
  if (roots.length < (mode.startsWith('distribute') ? 3 : 2)) throw new Error(mode.startsWith('distribute') ? 'Select at least three objects to distribute.' : 'Select at least two objects to align.');
  if (roots.some(element => element.locked || element.attachment)) throw new Error('Unlock selected objects and detach constrained parts before aligning.');
  const poses = new Map(evaluateProject(project, time).map(element => [element.id, element]));
  const selections = roots.map(element => {
    const members = element.kind === 'group'
      ? [...descendantIds(project, [element.id])].map(id => poses.get(id)).filter((item): item is StoryElement => !!item && item.kind !== 'group' && item.kind !== 'audio')
      : [poses.get(element.id)].filter((item): item is StoryElement => !!item && item.kind !== 'audio');
    if (!members.length) throw new Error('Every selected object must have visible artwork at the playhead.');
    return { element, bounds: union(members.map(elementBounds)) };
  });
  const overall = union(selections.map(item => item.bounds));
  const changes = new Map<string, { x: number; y: number }>();
  if (mode === 'distributeX' || mode === 'distributeY') {
    const horizontal = mode === 'distributeX';
    const ordered = [...selections].sort((a, b) => (horizontal ? a.bounds.left - b.bounds.left : a.bounds.top - b.bounds.top));
    const first = ordered[0].bounds, last = ordered.at(-1)!.bounds;
    const totalExtent = ordered.reduce((sum, item) => sum + (horizontal ? item.bounds.right - item.bounds.left : item.bounds.bottom - item.bounds.top), 0);
    const gap = ((horizontal ? last.right - first.left : last.bottom - first.top) - totalExtent) / (ordered.length - 1);
    let cursor = horizontal ? first.left : first.top;
    ordered.forEach((item, index) => {
      if (index > 0 && index < ordered.length - 1) changes.set(item.element.id, horizontal ? { x: cursor - item.bounds.left, y: 0 } : { x: 0, y: cursor - item.bounds.top });
      cursor += (horizontal ? item.bounds.right - item.bounds.left : item.bounds.bottom - item.bounds.top) + gap;
    });
  } else {
    for (const item of selections) {
      const b = item.bounds;
      const dx = mode === 'left' ? overall.left - b.left : mode === 'right' ? overall.right - b.right : mode === 'centerX' ? (overall.left + overall.right - b.left - b.right) / 2 : 0;
      const dy = mode === 'top' ? overall.top - b.top : mode === 'bottom' ? overall.bottom - b.bottom : mode === 'centerY' ? (overall.top + overall.bottom - b.top - b.bottom) / 2 : 0;
      changes.set(item.element.id, { x: dx, y: dy });
    }
  }
  const next = structuredClone(project);
  for (const element of next.elements) {
    const delta = changes.get(element.id);
    if (!delta) continue;
    const local = localDelta(poses.get(parentId(element) ?? ''), delta.x, delta.y);
    shift(element, local.x, local.y);
  }
  return next;
}
