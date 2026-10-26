import type { Project, StoryElement } from './model';
import { descendantIds } from './editing';

function corners(element: StoryElement): { x: number; y: number }[] {
  const angle = element.rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return [[0, 0], [element.width, 0], [element.width, element.height], [0, element.height]].map(([x, y]) => {
    const dx = (x - element.width * element.pivotX) * element.scaleX;
    const dy = (y - element.height * element.pivotY) * element.scaleY;
    return { x: element.x + dx * c - dy * s, y: element.y + dx * s + dy * c };
  });
}

/** The editor's selection geometry, sampled from the same evaluated poses as
 * the renderer. Group outlines enclose visible descendants at the playhead. */
export function selectionBounds(project: Project, evaluated: readonly StoryElement[], id: string): StoryElement | null {
  const raw = project.elements.find(element => element.id === id);
  if (!raw) return null;
  const pose = evaluated.find(element => element.id === id);
  if (raw.kind !== 'group') return pose && pose.kind !== 'audio' ? pose : null;
  const descendants = descendantIds(project, [id]);
  const points = evaluated.filter(element => descendants.has(element.id) && element.kind !== 'group' && element.kind !== 'audio' && !element.hidden).flatMap(corners);
  if (!points.length) return null;
  const left = Math.min(...points.map(point => point.x)), right = Math.max(...points.map(point => point.x));
  const top = Math.min(...points.map(point => point.y)), bottom = Math.max(...points.map(point => point.y));
  return { ...raw, kind: 'rectangle', x: (left + right) / 2, y: (top + bottom) / 2, width: Math.max(1, right - left), height: Math.max(1, bottom - top), rotation: 0, scaleX: 1, scaleY: 1, pivotX: .5, pivotY: .5 };
}
