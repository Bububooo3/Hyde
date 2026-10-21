// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createElement, createProject } from './model';
import { createAudioEffect } from './audioEffects';
import type { Assembly, Project } from './model';
import { createExampleProject } from './example';
import { deleteAutosave, importAssembly, listAutosaves, loadAssemblyFile, loadAutosave, loadProjectFile, pruneAutosaveAssets, saveAssemblyBlob, saveAutosave, saveProjectBlob } from './storage';
import { withEditablePath } from './shapePath';
import {duplicateElements,makeAssembly} from './editing';

const dataUrl = 'data:image/png;base64,AQIDBA==';
function fixture(): Project {
  const project = createProject('Hyde <story> & "characters"\r\nUnicode: 雪');
  project.assets.push({ id: 'image-1', name: 'paper.png', mime: 'image/png', kind: 'image', dataUrl });
  project.elements.push(createElement('rectangle', {
    id: 'root', assetId: 'image-1', points: [{ x: 1, y: 2 }, { x: 10, y: 20 }],
    tracks: [{ property: 'rotation', keyframes: [{ id: 'k-1', time: 0.25, value: 32, easing: 'elastic', direction: 'out', mode: 'stepped', steps: 12 }] }],
  }));
  project.elements.push(createElement('ellipse', {
    id: 'child', parentId: 'root', attachment: { type: 'hinge', parentId: 'root', min: -90, max: 90 },
  }));
  project.captions = [{ id: 'caption', start: 1, end: 2, text: 'A <caption> & a pause.' }];
  return project;
}
function readBlob(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer)); reader.onerror = reject; reader.readAsArrayBuffer(blob);
  });
}
function archiveFile(files: Record<string, Uint8Array>, name = 'story.hyde') {
  return new File([new Uint8Array(zipSync(files)).buffer], name);
}
const largeDataUrl = (letter = 'A') => `data:image/png;base64,${btoa(letter.repeat(200_000))}`;
function memoryOpfs() {
  const files = new Map<string, { data: string; lastModified: number }>();
  const folder = {
    async getFileHandle(name: string, options?: {create?: boolean}) {
      if (!files.has(name) && !options?.create) throw new DOMException('Missing file', 'NotFoundError');
      return {
        kind: 'file', name,
        async getFile() {
          const file = files.get(name);
          if (!file) throw new DOMException('Missing file', 'NotFoundError');
          return { text: async () => file.data, lastModified: file.lastModified };
        },
        async createWritable() {
          let data = '';
          return { async write(value: string) { data = value; }, async close() { files.set(name, { data, lastModified: Date.now() }); }, async abort() {} };
        },
      };
    },
    async removeEntry(name: string) { if (!files.delete(name)) throw new DOMException('Missing file', 'NotFoundError'); },
    async *[Symbol.asyncIterator]() {
      for (const name of files.keys()) yield [name, await this.getFileHandle(name)] as const;
    },
  };
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => folder }) } });
  return files;
}
async function mutateManifest(project: Project, change: (xml: string) => string) {
  const entries = unzipSync(await readBlob(await saveProjectBlob(project)));
  entries['manifest.xml'] = strToU8(change(strFromU8(entries['manifest.xml'])));
  return archiveFile(entries);
}

describe('portable Hyde archives', () => {
  it('preserves the example story and percent-encoded SVG bytes without mutating the input', async () => {
    const project = createExampleProject(), before = structuredClone(project);
    const blob = await saveProjectBlob(project);
    const opened = await loadProjectFile(new File([blob], 'example.hyde'));
    const originalSvg = decodeURIComponent(project.assets[0].dataUrl.split(',')[1]);
    const reopenedSvg = atob(opened.assets[0].dataUrl.split(',')[1]);
    expect(reopenedSvg).toBe(originalSvg);
    expect({ ...opened, assets: [] }).toEqual({ ...project, assets: [] });
    expect({ ...opened.assets[0], dataUrl: '' }).toEqual({ ...project.assets[0], dataUrl: '' });
    expect(opened.elements.find(element => element.id === 'box-lid')?.attachment?.parentId).toBe('box-body');
    expect(project).toEqual(before);
    // Once normalized to binary-backed base64, subsequent saves are identical.
    const second = await loadProjectFile(new File([await saveProjectBlob(opened)], 'again.hy'));
    expect(second).toEqual(opened);
  });
  it('round-trips all model fields, keyframes, text and asset bytes through .hyde and .hy', async () => {
    const project = fixture(), blob = await saveProjectBlob(project);
    for (const extension of ['hyde', 'hy']) {
      expect(await loadProjectFile(new File([blob], `story.${extension}`))).toEqual(project);
    }
    const entries = unzipSync(await readBlob(blob));
    expect(entries['assets/0.bin']).toEqual(new Uint8Array([1, 2, 3, 4]));
    const xml = strFromU8(entries['manifest.xml']);
    expect(xml).toContain('<field name="tracks">');
    expect(xml).not.toContain('data:image');
    expect(xml).not.toContain('"keyframes":');
  });
  it('preserves explicit video end behavior and rejects unknown choices',async()=>{
    const project=createProject();
    project.elements.push(createElement('video',{videoEndBehavior:'hide'}));
    const blob=await saveProjectBlob(project);
    for(const extension of ['hyde','hy'])expect((await loadProjectFile(new File([blob],`video.${extension}`))).elements[0].videoEndBehavior).toBe('hide');
    (project.elements[0] as unknown as {videoEndBehavior:string}).videoEndBehavior='repeat';
    await expect(saveProjectBlob(project)).rejects.toThrow(/Invalid video end behavior/);
  });
  it('round-trips bounded static inside-shape text arrangements in both project extensions',async()=>{
    const project=createProject(),sceneId=project.sequences[0].id;
    project.elements.push(createElement('rectangle',{id:'shape',sceneId}));
    project.elements.push(createElement('text',{id:'text',sceneId,text:'Static',textLayout:'static',flowAroundId:'shape',textShapeMode:'inside',staticLayoutWidth:180,
      staticTextFlow:{mode:'inside',sourceText:'Static',fontFamily:'JetBrains Mono',fontSize:40,layoutWidth:180,capturedAt:0,
        lines:[{text:'Static',width:115,x:12,y:0,start:{segmentIndex:0,graphemeIndex:0},end:{segmentIndex:0,graphemeIndex:6}}],
        outline:[{x:0,y:0},{x:180,y:0},{x:180,y:80},{x:0,y:80}]}}));
    const blob=await saveProjectBlob(project);
    for(const extension of ['hyde','hy'])expect((await loadProjectFile(new File([blob],`static.${extension}`))).elements.at(-1)?.staticTextFlow)
      .toEqual(project.elements.at(-1)?.staticTextFlow);
    const broken=structuredClone(project);
    broken.elements.at(-1)!.staticTextFlow!.lines[0].x=Number.NaN;
    await expect(saveProjectBlob(broken)).rejects.toThrow(/Static text line X/);
  });
  it('preserves editable paths in projects and reusable assemblies and rejects invalid handles', async () => {
    const project = fixture();
    project.elements[0] = withEditablePath(project.elements[0]);
    project.elements[0].shapePath!.points[0].out = { x: .25, y: -.3 };
    for (const extension of ['hyde', 'hy']) {
      const reopened = await loadProjectFile(new File([await saveProjectBlob(project)], `path.${extension}`));
      expect(reopened.elements[0].shapePath).toEqual(project.elements[0].shapePath);
    }
    const assembly: Assembly = { format: 'hyde-assembly', version: 1, name: 'Curved part', elements: project.elements, assets: project.assets };
    const reopened = await loadAssemblyFile(new File([await saveAssemblyBlob(assembly)], 'path.hyproj'));
    expect(reopened.elements[0].shapePath).toEqual(project.elements[0].shapePath);
    project.elements[0].shapePath!.points[0].out!.x = Number.NaN;
    await expect(saveProjectBlob(project)).rejects.toThrow(/Path out X/);
  });
  it('preserves media corner pins on textured shapes and rejects folded pins',async()=>{
    const project=fixture();
    project.elements[0].mediaPin=[{x:0,y:0},{x:1,y:.05},{x:.85,y:1},{x:.1,y:.9}];
    const opened=await loadProjectFile(new File([await saveProjectBlob(project)],'pinned.hyde'));
    expect(opened.elements[0].mediaPin).toEqual(project.elements[0].mediaPin);
    const assembly:Assembly={format:'hyde-assembly',version:1,name:'Pinned card',elements:project.elements,assets:project.assets};
    expect((await loadAssemblyFile(new File([await saveAssemblyBlob(assembly)],'pinned.hyproj'))).elements[0].mediaPin).toEqual(project.elements[0].mediaPin);
    project.elements[0].mediaPin=[{x:0,y:0},{x:1,y:1},{x:1,y:0},{x:0,y:1}];
    await expect(saveProjectBlob(project)).rejects.toThrow(/valid four-corner/);
  });
  it('preserves independent media placement in projects and assemblies, and rejects invalid transforms',async()=>{
    const project=fixture();
    project.elements[0].mediaTransform={x:24,y:-13,scaleX:1.4,scaleY:.8,rotation:32};
    for(const extension of ['hyde','hy']){
      const opened=await loadProjectFile(new File([await saveProjectBlob(project)],`placed.${extension}`));
      expect(opened.elements[0].mediaTransform).toEqual(project.elements[0].mediaTransform);
    }
    const assembly:Assembly={format:'hyde-assembly',version:1,name:'Placed paper',elements:project.elements,assets:project.assets};
    expect((await loadAssemblyFile(new File([await saveAssemblyBlob(assembly)],'placed.hyproj'))).elements[0].mediaTransform).toEqual(project.elements[0].mediaTransform);
    project.elements[0].mediaTransform!.scaleX=0;
    await expect(saveProjectBlob(project)).rejects.toThrow(/Media scaleX/);
  });
  it('round-trips a sequence camera and rejects invalid camera keys', async () => {
    const project = fixture();
    project.sequences[0].camera = { x: 470, y: 260, zoom: 1.2, rotation: 5, tracks: [
      { property: 'zoom', keyframes: [{ id: 'camera-zoom', time: 1, value: 2, easing: 'sine', direction: 'inOut', mode: 'smooth' }] },
    ] };
    const reopened = await loadProjectFile(new File([await saveProjectBlob(project)], 'camera.hyde'));
    expect(reopened.sequences[0].camera).toEqual(project.sequences[0].camera);
    project.sequences[0].camera.tracks[0].keyframes[0].value = 0;
    await expect(saveProjectBlob(project)).rejects.toThrow(/Camera keyframe value/);
  });
  it('round-trips ordered clip effects and rejects unsafe effect parameters', async () => {
    const project = fixture();
    project.elements[0].audioEffects = [createAudioEffect('echo'), createAudioEffect('equalizer'), createAudioEffect('reverb')];
    project.elements[0].audioEffects[1].enabled = false;
    const reopened = await loadProjectFile(new File([await saveProjectBlob(project)], 'effects.hyde'));
    expect(reopened.elements[0].audioEffects).toEqual(project.elements[0].audioEffects);
    project.elements[0].audioEffects[0] = { ...createAudioEffect('echo'), delay: 100 };
    await expect(saveProjectBlob(project)).rejects.toThrow('Audio effect delay');
    project.elements[0].audioEffects = Array.from({ length: 17 }, () => createAudioEffect('chorus'));
    await expect(saveProjectBlob(project)).rejects.toThrow('effect chain is too long');
  });
  it('round-trips audio fades and rejects malformed durations', async () => {
    const project = fixture();
    project.elements[0].fadeIn = .4;
    project.elements[0].fadeOut = 1.2;
    const reopened = await loadProjectFile(new File([await saveProjectBlob(project)], 'fades.hyde'));
    expect(reopened.elements[0]).toMatchObject({ fadeIn: .4, fadeOut: 1.2 });
    project.elements[0].fadeOut = -1;
    await expect(saveProjectBlob(project)).rejects.toThrow(/fadeOut/);
    project.elements[0].fadeOut = project.elements[0].duration + 1;
    await expect(saveProjectBlob(project)).rejects.toThrow(/fadeOut/);
  });
  it('round-trips independent pitch settings and rejects out-of-range values', async () => {
    const project = fixture();
    const element = project.elements[0];
    element.pitchSemitones = -7.5;
    element.linkSpeedPitch = false;
    const reopened = await loadProjectFile(new File([await saveProjectBlob(project)], 'pitch.hyde'));
    expect(reopened.elements[0]).toMatchObject({ pitchSemitones: -7.5, linkSpeedPitch: false });
    element.pitchSemitones = 25;
    await expect(saveProjectBlob(project)).rejects.toThrow('Pitch semitones');
    element.pitchSemitones = -25;
    await expect(saveProjectBlob(project)).rejects.toThrow('Pitch semitones');
    element.pitchSemitones = 0;
    (element as unknown as Record<string, unknown>).linkSpeedPitch = 'off';
    await expect(saveProjectBlob(project)).rejects.toThrow('Pitch/speed link');
  });
  it('round-trips editor folders and rejects dangling or circular folder references', async () => {
    const project = fixture();
    project.folders = [{ id: 'folder-a', name: 'Cast' }, { id: 'folder-b', name: 'Props', parentId: 'folder-a' }];
    project.elements[0].folderId = 'folder-b';
    expect(await loadProjectFile(new File([await saveProjectBlob(project)], 'folders.hyde'))).toEqual(project);
    project.folders[0].parentId = 'folder-b';
    await expect(saveProjectBlob(project)).rejects.toThrow('Circular scene folders');
    delete project.folders[0].parentId;
    project.elements[0].folderId = 'missing';
    await expect(saveProjectBlob(project)).rejects.toThrow('missing scene folder');
  });
  it('round-trips nested linked scenes and rejects circular source chains',async()=>{
    const project=fixture();
    project.sequences[0].id='source';
    project.sequences.push({id:'inner',name:'Inner',start:8,duration:4,color:'#fff',sourceSceneId:'source',sourceIn:2,sourceOut:6});
    project.sequences.push({id:'outer',name:'Outer',start:12,duration:8,color:'#fff',sourceSceneId:'inner',sourceIn:1,sourceOut:3});
    expect((await loadProjectFile(new File([await saveProjectBlob(project)],'nested.hyde'))).sequences).toEqual(project.sequences);
    project.sequences[0].sourceSceneId='outer';
    await expect(saveProjectBlob(project)).rejects.toThrow('Circular scene references');
  });
  it('stores duplicated embedded content once', async () => {
    const project = fixture(); project.assets.push({ ...project.assets[0], id: 'copy' });
    const blob = await saveProjectBlob(project), files = unzipSync(await readBlob(blob));
    expect(Object.keys(files).filter(path => path.startsWith('assets/'))).toHaveLength(1);
    expect(await loadProjectFile(new File([blob], 'x.hyde'))).toEqual(project);
  });
  it('round-trips assembly tracks and remaps all import references without modifying source', async () => {
    const project = fixture();
    const assembly: Assembly = { format: 'hyde-assembly', version: 1, name: 'Paper box', elements: project.elements, assets: project.assets };
    const opened = await loadAssemblyFile(new File([await saveAssemblyBlob(assembly)], 'box.hyproj'));
    expect(opened).toEqual(assembly);
    const before = structuredClone(project), source = structuredClone(opened);
    const imported = importAssembly(project, opened), [root, child] = imported.elements.slice(2);
    expect(root.id).not.toBe('root'); expect(child.parentId).toBe(root.id); expect(child.attachment?.parentId).toBe(root.id);
    expect(root.tracks[0].keyframes[0].id).not.toBe('k-1');
    expect(imported.assets).toHaveLength(1); expect(root.assetId).toBe('image-1');
    expect(project).toEqual(before); expect(opened).toEqual(source);
  });
  it('remaps assets when importing into an empty project', () => {
    const project = fixture();
    const imported = importAssembly(createProject(), { format: 'hyde-assembly', version: 1, name: 'Box', elements: project.elements, assets: project.assets });
    expect(imported.assets[0].id).not.toBe('image-1');
    expect(imported.elements[0].assetId).toBe(imported.assets[0].id);
  });
  it('keeps text-shape relations through project, duplicate, and assembly archives',async()=>{
    const project=createProject(),sceneId=project.sequences[0].id;
    project.elements=[
      createElement('ellipse',{id:'shape',sceneId}),
      createElement('text',{id:'words',sceneId,flowAroundId:'shape',textShapeMode:'inside'}),
    ];
    const reopened=await loadProjectFile(new File([await saveProjectBlob(project)],'flow.hyde'));
    expect(reopened.elements[1]).toMatchObject({flowAroundId:'shape',textShapeMode:'inside'});
    const duplicated=duplicateElements(reopened,['shape','words']).project.elements.slice(2);
    expect(duplicated[1].flowAroundId).toBe(duplicated[0].id);
    const archive=makeAssembly(reopened,['shape','words']);
    const loaded=await loadAssemblyFile(new File([await saveAssemblyBlob(archive)],'flow.hyproj'));
    const inserted=importAssembly(createProject(),loaded).elements;
    expect(inserted.find(element=>element.kind==='text')?.flowAroundId).toBe(inserted.find(element=>element.kind==='ellipse')?.id);
    project.elements[1].flowAroundId='missing';
    await expect(saveProjectBlob(project)).rejects.toThrow('missing shape');
  });
  it('rejects wrong extensions and archives with the wrong document type', async () => {
    const blob = await saveProjectBlob(fixture());
    await expect(loadProjectFile(new File([blob], 'story.zip'))).rejects.toThrow('.hyde');
    await expect(loadAssemblyFile(new File([blob], 'box.hyproj'))).rejects.toThrow('Wrong archive type');
  });
  it('rejects missing binary dependencies', async () => {
    const entries = unzipSync(await readBlob(await saveProjectBlob(fixture()))); delete entries['assets/0.bin'];
    await expect(loadProjectFile(archiveFile(entries))).rejects.toThrow('asset file is missing');
  });
  it('rejects invalid manifest versions and malformed XML', async () => {
    const project = fixture();
    await expect(loadProjectFile(await mutateManifest(project, xml => xml.replace('type="project" version="1"', 'type="project" version="7"')))).rejects.toThrow('Unsupported archive');
    await expect(loadProjectFile(await mutateManifest(project, xml => xml.slice(0, -4)))).rejects.toThrow('Malformed XML');
  });
  it('rejects missing element references and zero length clips', async () => {
    const project = fixture(); project.elements[0].assetId = 'missing';
    await expect(saveProjectBlob(project)).rejects.toThrow('missing asset');
    project.elements[0].assetId = 'image-1'; project.elements[0].duration = 0;
    await expect(saveProjectBlob(project)).rejects.toThrow('greater than zero');
  });
  it('rejects dangling asset and attachment references in imported manifests', async () => {
    await expect(loadProjectFile(await mutateManifest(fixture(), xml => xml.replace('<field name="assetId"><string>image-1</string>', '<field name="assetId"><string>missing</string>')))).rejects.toThrow('missing asset');
    await expect(loadProjectFile(await mutateManifest(fixture(), xml => xml.replaceAll('<field name="parentId"><string>root</string>', '<field name="parentId"><string>missing</string>')))).rejects.toThrow('missing parent');
  });
  it('rejects conflicting group and attachment parents', async () => {
    const project = fixture();
    project.elements.push(createElement('group', { id: 'other-parent' }));
    project.elements[1].attachment!.parentId = 'other-parent';
    await expect(saveProjectBlob(project)).rejects.toThrow('conflicting parents');
  });
  it('round-trips nonvisual zero-size assembly containers', async () => {
    const project = fixture();
    project.elements.push(createElement('group', { id: 'assembly', width: 0, height: 0 }));
    project.elements[0].parentId = 'assembly';
    const reopened = await loadProjectFile(new File([await saveProjectBlob(project)], 'group.hyde'));
    expect(reopened).toEqual(project);
  });
  it('rejects cyclic attachment graphs and duplicate keyframe identities', async () => {
    const project = fixture(); project.elements[0].parentId = 'child';
    await expect(saveProjectBlob(project)).rejects.toThrow('Circular');
    delete project.elements[0].parentId;
    project.elements[1].tracks = structuredClone(project.elements[0].tracks);
    await expect(saveProjectBlob(project)).rejects.toThrow('Keyframe ID');
  });
  it('rejects traversal paths and XML entity declarations', async () => {
    const entries = unzipSync(await readBlob(await saveProjectBlob(fixture())));
    entries['../outside'] = strToU8('unsafe');
    await expect(loadProjectFile(archiveFile(entries))).rejects.toThrow('unsafe path');
    await expect(loadProjectFile(await mutateManifest(fixture(), xml => xml.replace('<hyde-document', '<!DOCTYPE x [<!ENTITY x "unsafe">]><hyde-document')))).rejects.toThrow('entity declarations');
  });
  it('rejects unsafe object fields rather than polluting prototypes', async () => {
    const file = await mutateManifest(fixture(), xml => xml.replace('<field name="name">', '<field name="__proto__">'));
    await expect(loadProjectFile(file)).rejects.toThrow('Unsafe or repeated');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('rejects non-ZIP input with a useful error', async () => {
    await expect(loadProjectFile(new File(['bad data'], 'story.hyde'))).rejects.toThrow('Unable to open Hyde archive');
  });
});

describe('browser project recovery', () => {
  beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('starts empty and recovers the latest project after reloading the module', async () => {
    expect(await listAutosaves()).toEqual([]);
    expect(await loadAutosave()).toBeNull();
    const project = fixture();
    await saveAutosave(project);
    vi.resetModules();
    const reloaded = await import('./storage');
    expect(await reloaded.listAutosaves()).toEqual([project]);
    expect(await reloaded.loadAutosave()).toEqual(project);
  });
  it('retains ten distinct projects in save order, independent of embedded timestamps', async () => {
    const projects = Array.from({ length: 12 }, (_, index) => ({ ...createProject(`Project ${index}`), updatedAt: new Date(100_000 - index * 1000).toISOString() }));
    for (const project of projects) await saveAutosave(project);
    expect((await listAutosaves()).map(project => project.id)).toEqual(projects.slice(2).reverse().map(project => project.id));
    const updated = { ...projects[5], name: 'Updated project' };
    await saveAutosave(updated);
    const recent = await listAutosaves();
    expect(recent).toHaveLength(10);
    expect(recent[0]).toEqual(updated);
    expect(recent.filter(project => project.id === updated.id)).toHaveLength(1);
  });
  it('serializes concurrent saves and retention without lost projects', async () => {
    const projects = Array.from({ length: 14 }, (_, index) => createProject(`Concurrent ${index}`));
    await Promise.all(projects.map(saveAutosave));
    const recent = await listAutosaves();
    expect(recent).toHaveLength(10);
    expect(new Set(recent.map(project => project.id)).size).toBe(10);
    expect(recent.every(project => projects.some(saved => saved.id === project.id))).toBe(true);
    expect(await loadAutosave()).toEqual(recent[0]);
  });
  it('deletes only the named recovery and promotes the next most recent', async () => {
    const older = fixture(), newer = createProject('Newer');
    await saveAutosave(older); await saveAutosave(newer);
    await deleteAutosave(newer.id);
    expect(await loadAutosave()).toEqual(older);
    await deleteAutosave('missing-id');
    expect(await listAutosaves()).toEqual([older]);
    await deleteAutosave(older.id);
    expect(await loadAutosave()).toBeNull();
  });
  it('snapshots at invocation and returns independent objects on each read', async () => {
    const project = fixture(), before = structuredClone(project);
    const saving = saveAutosave(project);
    project.name = 'Changed while opening the database';
    project.elements[0].x += 100;
    await saving;
    const first = (await listAutosaves())[0];
    expect(first).toEqual(before);
    first.elements[0].x += 900;
    first.assets.length = 0;
    expect(await loadAutosave()).toEqual(before);
  });
  it('migrates legacy latest recovery in the same store and removes the legacy key', async () => {
    const project = fixture();
    const legacy = await openDB('hyde-local', 1, { upgrade(db) { db.createObjectStore('recovery'); } });
    await legacy.put('recovery', project, 'latest'); legacy.close();
    expect(await listAutosaves()).toEqual([project]);
    const migrated = await openDB('hyde-local', 2);
    expect(await migrated.get('recovery', 'latest')).toBeUndefined();
    expect((await migrated.get('recovery', `project:${project.id}`)).project).toEqual(project);
    migrated.close();
    const next = createProject('Another project'); await saveAutosave(next);
    expect(await listAutosaves()).toEqual([next, project]);
  });
  it('preserves the legacy record and version if migration validation fails', async () => {
    const legacy = await openDB('hyde-local', 1, { upgrade(db) { db.createObjectStore('recovery'); } });
    const broken = { ...fixture(), version: 999 };
    await legacy.put('recovery', broken, 'latest'); legacy.close();
    await expect(listAutosaves()).rejects.toBeDefined();
    const reopened = await openDB('hyde-local');
    expect(reopened.version).toBe(1);
    expect(await reopened.get('recovery', 'latest')).toEqual(broken);
    reopened.close();
  });
  it('surfaces quota failures and keeps all previous recoveries', async () => {
    const project = fixture(); await saveAutosave(project);
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new DOMException('Simulated storage capacity failure', 'QuotaExceededError'); });
    await expect(saveAutosave(createProject('Cannot fit'))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(await listAutosaves()).toEqual([project]);
  });
  it('rolls back the newly written project if retention deletion fails', async () => {
    for (let index = 0; index < 10; index++) await saveAutosave(createProject(`Kept ${index}`));
    const before = await listAutosaves();
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementationOnce(() => { throw new Error('Simulated retention failure'); });
    await expect(saveAutosave(createProject('Must roll back'))).rejects.toThrow('Simulated retention failure');
    expect(await listAutosaves()).toEqual(before);
  });
  it('rejects invalid projects before altering browser recovery', async () => {
    const project = fixture(); await saveAutosave(project);
    await expect(saveAutosave({ ...project, duration: 0 })).rejects.toThrow('greater than zero');
    expect(await loadAutosave()).toEqual(project);
  });
  it('keeps large media outside project records in IndexedDB fallback and reuses unchanged bytes', async () => {
    const project = fixture(); project.assets[0].dataUrl = largeDataUrl();
    await saveAutosave(project);
    const recovery = await openDB('hyde-local', 2);
    const stored = await recovery.get('recovery', `project:${project.id}`);
    expect(stored.version).toBe(2);
    expect(stored.project.assets[0].dataUrl).toBe('');
    expect(stored.assetRefs[0].backend).toBe('indexeddb');
    const key = stored.assetRefs[0].key;
    recovery.close();
    expect(await loadAutosave()).toEqual(project);
    await saveAutosave({ ...project, name: 'Updated without changing the image' });
    const assets = await openDB('hyde-recovery-assets', 1);
    expect(await assets.getAllKeys('assets')).toEqual([key]);
    assets.close();
    expect((await loadAutosave())?.name).toBe('Updated without changing the image');
  });
  it('uses OPFS when available and preserves old recovery on a failed replacement', async () => {
    const files = memoryOpfs();
    const project = fixture(); project.assets[0].dataUrl = largeDataUrl();
    await saveAutosave(project);
    expect(files.size).toBe(1);
    const recovery = await openDB('hyde-local', 2);
    expect((await recovery.get('recovery', `project:${project.id}`)).assetRefs[0].backend).toBe('opfs');
    recovery.close();
    const changed = structuredClone(project); changed.assets[0].dataUrl = largeDataUrl('B');
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new DOMException('Simulated full recovery database', 'QuotaExceededError'); });
    await expect(saveAutosave(changed)).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(files.size).toBe(1);
    expect(await loadAutosave()).toEqual(project);
    vi.restoreAllMocks();
    await saveAutosave(changed);
    expect(files.size).toBe(2);
    expect(await loadAutosave()).toEqual(changed);
  });
  it('prunes only unreferenced assets after their grace period', async () => {
    const project = fixture(); project.assets[0].dataUrl = largeDataUrl();
    await saveAutosave(project);
    const assets = await openDB('hyde-recovery-assets', 1);
    const keys = await assets.getAllKeys('assets');
    expect(keys).toHaveLength(1);
    await deleteAutosave(project.id);
    await pruneAutosaveAssets();
    expect(await assets.getAllKeys('assets')).toEqual(keys);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
    await pruneAutosaveAssets();
    expect(await assets.getAllKeys('assets')).toEqual([]);
    assets.close();
  });
  it('validates scene and nested viewport rotation while preserving finite values in archives', async () => {
    const project = fixture();
    project.sequences[0].frameRotation = -27;
    project.sequences[0].frameStack = [{ frameRotation: 14 }];
    expect((await loadProjectFile(new File([await saveProjectBlob(project)], 'rotated.hyde'))).sequences[0].frameStack?.[0].frameRotation).toBe(14);
    project.sequences[0].frameRotation = Number.NaN;
    await expect(saveProjectBlob(project)).rejects.toThrow('Scene frame rotation');
    project.sequences[0].frameRotation = 0;
    project.sequences[0].frameStack![0].frameRotation = Infinity;
    await expect(saveProjectBlob(project)).rejects.toThrow('Nested frame rotation');
  });
});
