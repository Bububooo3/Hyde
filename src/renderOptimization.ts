import type { Asset, Project, StoryElement } from './model';

export type RenderOptimization = 'auto' | 'motion' | 'static';

function parentOf(element: StoryElement): string | undefined {
  return element.attachment?.parentId ?? element.parentId;
}

/** A manual choice can be inherited from an assembly. Dynamic media and text
 * effects always stay live; a static hint must never change the story. */
export function effectiveRenderOptimization(
  element: StoryElement,
  elements: ReadonlyMap<string, StoryElement>,
  asset?: Asset,
): 'motion' | 'static' {
  if (asset?.kind === 'video' || element.textAnimation) return 'motion';
  let choice: RenderOptimization = element.optimize ?? 'auto';
  if (choice === 'auto') {
    const seen = new Set<string>([element.id]);
    let id = parentOf(element);
    while (id && !seen.has(id)) {
      seen.add(id);
      const parent = elements.get(id);
      if (!parent) break;
      if (parent.optimize && parent.optimize !== 'auto') { choice = parent.optimize; break; }
      id = parentOf(parent);
    }
  }
  if (choice !== 'auto') return choice;
  const dynamic = (part: StoryElement) => part.tracks.some(track => track.keyframes.length > 0)
    || !!part.clipInstances?.length || !!part.motionBehaviors?.some(behavior => behavior.enabled);
  if (dynamic(element)) return 'motion';
  const seen = new Set<string>([element.id]);
  let id = parentOf(element);
  while (id && !seen.has(id)) {
    seen.add(id);
    const parent = elements.get(id);
    if (!parent) break;
    if (dynamic(parent)) return 'motion';
    id = parentOf(parent);
  }
  return 'static';
}

/** Project identity invalidates authored geometry/text/style edits. This small
 * key tracks only values that deterministic evaluation can change over time. */
export function staticVisualSignature(element: StoryElement, flowTarget?: StoryElement): string {
  return JSON.stringify([
    element.x,element.y,element.rotation,element.scaleX,element.scaleY,
    element.opacity,element.fill,element.assetId,
    flowTarget && [flowTarget.x,flowTarget.y,flowTarget.rotation,
      flowTarget.scaleX,flowTarget.scaleY],
  ]);
}

/** Resolve the selected object's authored or inherited hint for inspector copy. */
export function projectRenderOptimization(project: Project, element: StoryElement): 'motion' | 'static' {
  const elements = new Map(project.elements.map(part => [part.id, part]));
  const asset = project.assets.find(item => item.id === element.assetId);
  return effectiveRenderOptimization(element,elements,asset);
}
