import type { StoryElement } from './model';

/** Move an anchor while preserving artwork at the current pose, including keyed positions. */
export function setPivotWithoutMovingArt(element: StoryElement, pivotX: number, pivotY: number, pose: Pick<StoryElement, 'rotation' | 'scaleX' | 'scaleY'> = element): void {
  const localX = (pivotX - element.pivotX) * element.width * pose.scaleX;
  const localY = (pivotY - element.pivotY) * element.height * pose.scaleY;
  const angle = pose.rotation * Math.PI / 180;
  const dx = localX * Math.cos(angle) - localY * Math.sin(angle);
  const dy = localX * Math.sin(angle) + localY * Math.cos(angle);
  element.x += dx;
  element.y += dy;
  for (const track of element.tracks) {
    if (track.property !== 'x' && track.property !== 'y') continue;
    const offset = track.property === 'x' ? dx : dy;
    for (const key of track.keyframes) if (typeof key.value === 'number') key.value += offset;
  }
  element.pivotX = pivotX;
  element.pivotY = pivotY;
}
