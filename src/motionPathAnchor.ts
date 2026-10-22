import { evaluateProject } from './engine';
import type { FollowPathMotion, Project, StoryElement } from './model';

const parentId = (element: StoryElement) => element.attachment?.parentId ?? element.parentId;

/** Store the stage guide in the owning part's parent space at path start.
 * Later x/y animation on that part must not move its guide. */
export function motionPathLocalAnchor(project: Project, element: StoryElement, behavior: FollowPathMotion): { x: number; y: number } {
  const start = element.start + behavior.start;
  const withoutOwnMotion = {
    ...project,
    elements: project.elements.map(item => item.id === element.id ? { ...item, motionBehaviors: [] } : item),
  };
  const poses = evaluateProject(withoutOwnMotion, start);
  const pose = poses.find(item => item.id === element.id);
  if (!pose) return { x: element.x, y: element.y };
  const parent = poses.find(item => item.id === parentId(element));
  if (!parent || Math.abs(parent.scaleX) < 1e-10 || Math.abs(parent.scaleY) < 1e-10) return { x: pose.x, y: pose.y };
  const radians = parent.rotation * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  const dx = pose.x - parent.x, dy = pose.y - parent.y;
  return { x: (dx * c + dy * s) / parent.scaleX, y: (-dx * s + dy * c) / parent.scaleY };
}

export function motionPathWorldAnchor(local: { x: number; y: number }, parent: StoryElement | null): { x: number; y: number } {
  if (!parent) return local;
  const radians = parent.rotation * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  const x = local.x * parent.scaleX, y = local.y * parent.scaleY;
  return { x: parent.x + x * c - y * s, y: parent.y + x * s + y * c };
}
