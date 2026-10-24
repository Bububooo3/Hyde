// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { validateDocument } from './archive';
import { applyCatalogCommand, type CatalogCommand, type CatalogContext } from './authoringCatalog';
import { elementBounds } from './alignment';
import { makeAssembly } from './editing';
import { createElement, createProject, uid, type Assembly, type Project } from './model';
import { placeLinkedScene } from './scenePlacement';

function harness() {
  const aliases = new Map<string, string>();
  const used: string[] = [];
  let assembly: Assembly | undefined;
  const context: CatalogContext = {
    resolve(id) { if (!id.startsWith('$')) return id; const value = aliases.get(id); if (!value) throw new Error(`Unknown alias ${id}`); return value; },
    register(alias, id) { if (alias) { if (!alias.startsWith('$') || aliases.has(alias)) throw new Error('Invalid duplicate alias'); aliases.set(alias, id); } },
    stagedAsset(handle) { return handle === 'image-two' ? { kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,YmJi' } : undefined; },
    useHandle(handle) { used.push(handle); },
    stagedAssembly(handle) { return handle === 'assembly-one' ? assembly : undefined; },
    useAssemblyHandle(handle) { used.push(handle); },
  };
  const apply = (project: Project, command: CatalogCommand) => applyCatalogCommand(project, command, context);
  return { aliases, used, apply, setAssembly(value: Assembly) { assembly = value; } };
}

describe('remaining authoring command catalog', () => {
  it('ripple shifts later owned content while boundary trim only changes visibility', () => {
    const h = harness();
    const project = createProject();
    const first = project.sequences[0];
    const second = { id: uid(), name: 'Second', start: 8, duration: 4, color: '#fff' };
    project.sequences.push(second);
    project.duration = 12;
    const item = createElement('rectangle', { sceneId: second.id, start: 8, duration: 4 });
    project.elements.push(item);
    const rippled = h.apply(project, { op: 'scene.ripple', args: { id: first.id, deltaSeconds: 2 } });
    expect(rippled.sequences.find(scene => scene.id === first.id)?.duration).toBe(10);
    expect(rippled.sequences.find(scene => scene.id === second.id)?.start).toBe(10);
    expect(rippled.elements[0].start).toBe(10);
    expect(project.elements[0].start).toBe(8);
    const trimmed = h.apply(rippled, { op: 'scene.trimBoundary', args: { id: first.id, edge: 'start', timeSeconds: 1 } });
    expect(trimmed.sequences.find(scene => scene.id === first.id)).toMatchObject({ start: 1, duration: 9 });
    expect(trimmed.elements[0].start).toBe(10);
    validateDocument(trimmed, false);
  });

  it('edits linked placement range and frame without changing the source scene', () => {
    const h = harness();
    const base = createProject();
    const source = base.sequences[0];
    const linked = placeLinkedScene(base, source.id, 8);
    const next = h.apply(linked.project, { op: 'scene.setPlacement', args: { id: linked.sceneId, placement: {
      start: 12, duration: 3, sourceIn: 1, sourceOut: 7, frame: { x: 30, y: 40, width: 400, height: 300 }, frameFit: 'fit', frameRotation: 12, opacity: 0.7, muted: true,
    } } });
    expect(next.sequences.find(scene => scene.id === source.id)).toEqual(source);
    expect(next.sequences.find(scene => scene.id === linked.sceneId)).toMatchObject({ start: 12, duration: 3, sourceIn: 1, sourceOut: 7, frameRotation: 12, opacity: 0.7 });
    validateDocument(next, false);
    expect(() => h.apply(next, { op: 'scene.setPlacement', args: { id: linked.sceneId, placement: { sourceOut: 20 } } })).toThrow();
  });

  it('groups and clones hierarchy with remapped IDs, and preserves pivot artwork', () => {
    const h = harness();
    let project = createProject();
    const first = createElement('rectangle', { sceneId: project.sequences[0].id, x: 100, y: 100, width: 80, height: 60 });
    const second = createElement('ellipse', { sceneId: first.sceneId, x: 250, y: 100 });
    project.elements.push(first, second);
    const before = elementBounds(first);
    project = h.apply(project, { op: 'element.setPivot', args: { id: first.id, pivotX: 0, pivotY: 0, preserveArtwork: true } });
    expect(elementBounds(project.elements.find(item => item.id === first.id)!)).toEqual(before);
    project = h.apply(project, { op: 'folder.create', args: { alias: '$folder', name: 'Character' } });
    project = h.apply(project, { op: 'folder.assign', args: { folderId: '$folder', elementIds: [first.id, second.id] } });
    project = h.apply(project, { op: 'assembly.create', args: { ids: [first.id, second.id], alias: '$body', name: 'Body' } });
    expect(project.elements.filter(item => item.parentId === h.aliases.get('$body'))).toHaveLength(2);
    project = h.apply(project, { op: 'element.clone', args: { id: '$body', alias: '$copy' } });
    const copy = project.elements.find(item => item.id === h.aliases.get('$copy'))!;
    expect(copy.kind).toBe('group');
    expect(project.elements.filter(item => item.parentId === copy.id)).toHaveLength(2);
    expect(project.elements.find(item => item.id === first.id)?.parentId).toBe(h.aliases.get('$body'));
    project = h.apply(project, { op: 'element.setVisibility', args: { id: '$copy', hidden: true } });
    project = h.apply(project, { op: 'element.setLock', args: { id: '$copy', locked: true } });
    project = h.apply(project, { op: 'element.reorder', args: { id: '$copy', beforeId: '$body' } });
    expect(project.elements.find(item => item.id === copy.id)).toMatchObject({ hidden: true, locked: true });
    validateDocument(project, false);
  });

  it('keeps logical asset ID on replacement and removes only unused assets', () => {
    const h = harness();
    let project = createProject();
    const used = { id: uid(), name: 'Old', kind: 'image' as const, mime: 'image/png', dataUrl: 'data:image/png;base64,YWFh' };
    const unused = { ...used, id: uid(), name: 'Unused' };
    project.assets.push(used, unused);
    project.elements.push(createElement('image', { assetId: used.id, sceneId: project.sequences[0].id }));
    project = h.apply(project, { op: 'asset.replace', args: { id: used.id, handle: 'image-two', name: 'New' } });
    expect(project.assets.find(item => item.id === used.id)).toMatchObject({ name: 'New', dataUrl: 'data:image/png;base64,YmJi' });
    expect(h.used).toEqual(['image-two']);
    expect(() => h.apply(project, { op: 'asset.removeUnused', args: { ids: [used.id] } })).toThrow();
    project = h.apply(project, { op: 'asset.removeUnused', args: {} });
    expect(project.assets.map(item => item.id)).toEqual([used.id]);
    validateDocument(project, false);
  });

  it('updates captions and attachment limits with target checks', () => {
    const h = harness();
    let project = createProject();
    const parent = createElement('rectangle', { sceneId: project.sequences[0].id });
    const child = createElement('ellipse', { sceneId: parent.sceneId, parentId: parent.id, attachment: { type: 'hinge', parentId: parent.id, min: -20, max: 20 } });
    project.elements.push(parent, child);
    const caption = { id: uid(), sceneId: parent.sceneId, text: 'Start', start: 0, end: 2 };
    project.captions.push(caption);
    project = h.apply(project, { op: 'assembly.setLimits', args: { id: child.id, min: -40, max: 45 } });
    expect(project.elements.find(item => item.id === child.id)?.attachment).toMatchObject({ min: -40, max: 45 });
    expect(() => h.apply(project, { op: 'assembly.setLimits', args: { id: child.id, min: 100 } })).toThrow();
    project = h.apply(project, { op: 'caption.update', args: { id: caption.id, patch: { text: 'Finish', start: 1, end: 3 } } });
    expect(project.captions[0]).toMatchObject({ text: 'Finish', start: 1, end: 3 });
    project = h.apply(project, { op: 'caption.delete', args: { id: caption.id } });
    expect(project.captions).toHaveLength(0);
    validateDocument(project, false);
  });

  it('imports a native assembly with new identities and a batch alias', () => {
    const h = harness();
    const project = createProject();
    const item = createElement('rectangle', { sceneId: project.sequences[0].id, name: 'Original' });
    project.elements.push(item);
    h.setAssembly(makeAssembly(project, [item.id], 0));
    const imported = h.apply(project, { op: 'assembly.import', args: { handle: 'assembly-one', timeSeconds: 2, alias: '$imported' } });
    expect(imported.elements).toHaveLength(2);
    expect(imported.elements[0].id).toBe(item.id);
    expect(imported.elements[1].id).not.toBe(item.id);
    expect(imported.elements[1].id).toBe(h.aliases.get('$imported'));
    expect(imported.elements[1].sceneId).toBe(project.sequences[0].id);
    expect(h.used).toEqual(['assembly-one']);
    validateDocument(imported, false);
  });
});
