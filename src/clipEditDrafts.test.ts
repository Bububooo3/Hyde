// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import {IDBFactory} from 'fake-indexeddb';
import {beforeEach,describe,expect,it} from 'vitest';
import {createElement,createProject} from './model';
import {ClipDraftConflictError,deleteClipDraft,loadClipDraft,recoverClipDraftCopy,restoreClipDraft,saveClipDraft} from './clipEditDrafts';

beforeEach(()=>{
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:new IDBFactory()});
  localStorage.clear();
});

describe('clip draft revision recovery',()=>{
  it('keeps a stale stored draft when a new session tries to save over it',async()=>{
    const base=createProject();base.elements.push(createElement('rectangle',{id:'clip-target'}));
    const draft=structuredClone(base);draft.elements[0].name='Unapplied edit';
    await saveClipDraft(base,draft,'structure','clip-target');
    const changed=structuredClone(base);changed.updatedAt='later-revision';
    const laterDraft=structuredClone(changed);laterDraft.elements[0].name='Later edit';
    await expect(saveClipDraft(changed,laterDraft,'structure','clip-target')).rejects.toBeInstanceOf(ClipDraftConflictError);
    const saved=await loadClipDraft(base.id);
    expect(saved?.baseUpdatedAt).toBe(base.updatedAt);
    expect(saved?.elements[0].name).toBe('Unapplied edit');
    await deleteClipDraft(base.id);
    await saveClipDraft(changed,laterDraft,'structure','clip-target');
    expect((await loadClipDraft(base.id))?.elements[0].name).toBe('Later edit');
  });

  it('recovers into an independent copy with an unapplied draft',async()=>{
    const original=createProject('Story');original.elements.push(createElement('rectangle',{id:'clip-target'}));
    const edited=structuredClone(original);edited.elements[0].name='Draft part';
    await saveClipDraft(original,edited,'structure','clip-target');
    const saved=(await loadClipDraft(original.id))!;
    const newer=structuredClone(original);newer.updatedAt='later-revision';newer.elements[0].name='Current part';
    expect(()=>restoreClipDraft(newer,saved)).toThrow('different project revision');
    const {base,draft}=recoverClipDraftCopy(newer,saved,'copy-id');
    expect(base.id).toBe('copy-id');
    expect(base.name).toBe('Story (recovered clip edit)');
    expect(base.elements[0].name).toBe('Current part');
    expect(draft.elements[0].name).toBe('Draft part');
    expect(newer.elements[0].name).toBe('Current part');
  });
});
