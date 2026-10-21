import { describe, expect, it } from 'vitest';
import { createElement, createProject } from './model';
import { sceneRows } from './sceneTree';
import { moveSceneFolder, removeSceneFolder } from './editing';

describe('scene contents hierarchy', () => {
  it('keeps same-name assemblies separate by ID and leaves drawing order alone', () => {
    const project = createProject();
    const first = createElement('group', { id: 'assembly-a', name: 'New assembly' });
    const second = createElement('group', { id: 'assembly-b', name: 'New assembly' });
    const a = createElement('rectangle', { id: 'part-a', parentId: first.id });
    const b = createElement('rectangle', { id: 'part-b', parentId: second.id });
    project.elements = [a, b, first, second];
    const rows = sceneRows(project, new Set(), '', 'all');
    expect(rows.map(row => [row.type === 'element' ? row.element.id : row.folder.id, row.depth])).toEqual([
      ['assembly-b', 0], ['part-b', 1], ['assembly-a', 0], ['part-a', 1],
    ]);
    expect(project.elements.map(element => element.id)).toEqual(['part-a', 'part-b', 'assembly-a', 'assembly-b']);
    expect(sceneRows(project, new Set(['element:assembly-b']), '', 'all').map(row => row.type === 'element' && row.element.id)).not.toContain('part-b');
  });

  it('shows matching children with their folder and assembly ancestors', () => {
    const project = createProject();
    project.folders = [{ id: 'f1', name: 'Set dressing' }, { id: 'f2', name: 'Props', parentId: 'f1' }];
    const group = createElement('group', { id: 'group', folderId: 'f2', name: 'Cast' });
    const part = createElement('ellipse', { id: 'part', parentId: group.id, name: 'Yellow sun' });
    project.elements = [part, group];
    const closed = new Set(['folder:f1', 'folder:f2', 'element:group']);
    expect(sceneRows(project, closed, 'sun', 'shapes').map(row => row.type === 'element' ? row.element.id : row.folder.id)).toEqual(['f1', 'f2', 'group', 'part']);
    expect(sceneRows(project, closed, '', 'all').map(row => row.type === 'element' ? row.element.id : row.folder.id)).toEqual(['f1']);
  });

  it('rejects folder cycles and promotes children on delete', () => {
    const project = createProject();
    project.folders = [{ id: 'f1', name: 'A' }, { id: 'f2', name: 'B', parentId: 'f1' }];
    project.elements = [createElement('text', { folderId: 'f2' })];
    expect(() => moveSceneFolder(project, 'f1', 'f2')).toThrow(/inside itself/);
    const moved = removeSceneFolder(project, 'f2');
    expect(moved.folders).toEqual([{ id: 'f1', name: 'A' }]);
    expect(moved.elements[0].folderId).toBe('f1');
  });
});
