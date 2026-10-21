import { parentId } from './editing';
import type { Project, SceneFolder, StoryElement } from './model';

export type SceneRow =
  | { type: 'folder'; folder: SceneFolder; depth: number; hasChildren: boolean; expanded: boolean }
  | { type: 'element'; element: StoryElement; depth: number; hasChildren: boolean; expanded: boolean };

/** A list view of the hierarchy. Folder order never changes project.elements,
 * which remains the source of truth for stage drawing order. */
export function sceneRows(project: Project, closed: ReadonlySet<string>, query: string, kind: string): SceneRow[] {
  const text = query.trim().toLocaleLowerCase();
  const filtering = !!text || kind !== 'all';
  const elementIds = new Set(project.elements.map(element => element.id));
  const folderIds = new Set((project.folders ?? []).map(folder => folder.id));
  const children = new Map<string, StoryElement[]>();
  const folderChildren = new Map<string, SceneFolder[]>();
  const roots = new Map<string, StoryElement[]>();
  const add = <T,>(map: Map<string, T[]>, key: string, value: T) => map.set(key, [...(map.get(key) ?? []), value]);
  for (const folder of project.folders ?? []) add(folderChildren, folderIds.has(folder.parentId ?? '') ? folder.parentId! : '', folder);
  for (const element of [...project.elements].reverse()) {
    const parent = parentId(element);
    if (parent && elementIds.has(parent)) add(children, parent, element);
    else add(roots, folderIds.has(element.folderId ?? '') ? element.folderId! : '', element);
  }
  const typeMatches = (element: StoryElement) => kind === 'all' || (kind === 'shapes' ? ['rectangle', 'ellipse', 'polygon'].includes(element.kind) : element.kind === kind);
  const rows: SceneRow[] = [];
  const visiting = new Set<string>();

  function walkElement(element: StoryElement, depth: number, ancestorTextMatched: boolean): boolean {
    if (visiting.has(element.id)) return false;
    visiting.add(element.id);
    const nameMatch = !!text && element.name.toLocaleLowerCase().includes(text);
    const ownMatch = typeMatches(element) && (!text || ancestorTextMatched || nameMatch);
    const childRows = rows.length;
    const childList = children.get(element.id) ?? [];
    // Collect descendants first, then insert their parent before them.
    let childMatch = false;
    for (const child of childList) childMatch = walkElement(child, depth + 1, ancestorTextMatched || nameMatch) || childMatch;
    const show = ownMatch || childMatch;
    if (show) {
      const expanded = filtering || !closed.has(`element:${element.id}`);
      if (!expanded) rows.splice(childRows);
      rows.splice(childRows, 0, { type: 'element', element, depth, hasChildren: childList.length > 0, expanded });
    } else rows.splice(childRows);
    visiting.delete(element.id);
    return show;
  }

  function walkFolder(folder: SceneFolder, depth: number, ancestorTextMatched: boolean): boolean {
    if (visiting.has(folder.id)) return false;
    visiting.add(folder.id);
    const nameMatch = !!text && folder.name.toLocaleLowerCase().includes(text);
    const start = rows.length;
    const nested = folderChildren.get(folder.id) ?? [];
    const elements = roots.get(folder.id) ?? [];
    let childMatch = false;
    for (const child of nested) childMatch = walkFolder(child, depth + 1, ancestorTextMatched || nameMatch) || childMatch;
    for (const child of elements) childMatch = walkElement(child, depth + 1, ancestorTextMatched || nameMatch) || childMatch;
    const show = childMatch || kind === 'all' && (!text || nameMatch || ancestorTextMatched);
    if (show) {
      const expanded = filtering || !closed.has(`folder:${folder.id}`);
      if (!expanded) rows.splice(start);
      rows.splice(start, 0, { type: 'folder', folder, depth, hasChildren: nested.length + elements.length > 0, expanded });
    } else rows.splice(start);
    visiting.delete(folder.id);
    return show;
  }
  for (const folder of folderChildren.get('') ?? []) walkFolder(folder, 0, false);
  for (const element of roots.get('') ?? []) walkElement(element, 0, false);
  return rows;
}
