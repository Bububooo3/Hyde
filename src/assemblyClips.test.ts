// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { captureAssemblyClip, editAssemblyClipInstance, placeAssemblyClip, removeAssemblyClipInstance } from './assemblyClips';
import { duplicateElements, insertAssemblyAt, makeAssembly } from './editing';
import { evaluateProject } from './engine';
import { createElement, createProject, type Keyframe, type Project } from './model';
import { bakeScenePlacements, makeSceneIndependent, placeLinkedScene } from './scenePlacement';
import { duplicateScene, retimeScene } from './sceneOperations';
import { loadAssemblyFile, loadProjectFile, saveAssemblyBlob, saveProjectBlob } from './storage';

const key = (time: number, value: number): Keyframe => ({ id: crypto.randomUUID(), time, value, easing: 'linear', direction: 'in', mode: 'smooth' });
function assemblyProject(): Project {
  const project = createProject();
  project.elements = [
    createElement('group', { id: 'root', name: 'Paper actor', x: 300, y: 200, width: 0, height: 0, duration: 8, sceneId: project.sequences[0].id }),
    createElement('rectangle', { id: 'arm', name: 'Arm', parentId: 'root', x: 40, y: 0, rotation: 0, duration: 8, sceneId: project.sequences[0].id,
      tracks: [{ property: 'rotation', keyframes: [key(0, 0), key(2, 90)] }] }),
  ];
  return project;
}
function armRotation(project: Project, at: number, id = 'arm'): number {
  const arm = evaluateProject(project, at).find(element => element.id === id);
  if (!arm) throw new Error('Arm was not visible.');
  return arm.rotation;
}

describe('reusable assembly animation clips', () => {
  it('retimes one placement on project frames without mutating its shared definition',()=>{
    const source=assemblyProject();
    const captured=captureAssemblyClip(source,'root',0,2,'Wave');
    const first=placeAssemblyClip(captured.project,'root',captured.clipId,3);
    const moved=editAssemblyClipInstance(first.project,'root',first.instanceId,{at:4.02,duration:1.01,loop:true});
    expect(moved.elements[0].clipInstances![0]).toMatchObject({start:4.033333333333333,duration:1,loop:true});
    expect(moved.elements[0].assemblyClips![0].duration).toBe(2);
    expect(first.project.elements[0].clipInstances![0].start).toBe(3);
    expect(()=>editAssemblyClipInstance(first.project,'root',first.instanceId,{duration:0})).toThrow(/one frame/);
  });
  it('captures local movement once and applies linked instances without changing the source project', () => {
    const source = assemblyProject(), before = structuredClone(source);
    const { project: captured, clipId } = captureAssemblyClip(source, 'root', 0, 2, 'Wave');
    expect(source).toEqual(before);
    const clip = captured.elements[0].assemblyClips![0];
    expect(clip.name).toBe('Wave');
    expect(clip.tracks.find(track => track.elementId === 'root' && track.property === 'rotation')).toBeUndefined();
    expect(clip.tracks.find(track => track.elementId === 'arm' && track.property === 'rotation')?.keyframes.map(frame => frame.value)).toEqual([0, 90]);
    const first = placeAssemblyClip(captured, 'root', clipId, 3);
    const second = placeAssemblyClip(first.project, 'root', clipId, 5);
    expect(second.project.elements[0].clipInstances).toHaveLength(2);
    expect(armRotation(second.project, 4)).toBeCloseTo(45);
    expect(armRotation(second.project, 6)).toBeCloseTo(45);
    const edited = structuredClone(second.project);
    edited.elements[0].assemblyClips![0].tracks.find(track => track.elementId === 'arm' && track.property === 'rotation')!.keyframes[1].value = 60;
    expect(armRotation(edited, 4)).toBeCloseTo(30);
    expect(armRotation(edited, 6)).toBeCloseTo(30);
    const removed = removeAssemblyClipInstance(second.project, 'root', first.instanceId);
    expect(removed.elements[0].assemblyClips).toHaveLength(1);
    expect(removed.elements[0].clipInstances).toHaveLength(1);
    expect(armRotation(removed, 4)).toBe(90);
  });

  it('captures a single-pose clip with at least one key and holds its result', () => {
    const source = assemblyProject();
    source.elements[1].tracks = [];
    source.elements[1].rotation = 35;
    const { project: captured, clipId } = captureAssemblyClip(source, 'root', 1, 1 / source.fps, 'Pose');
    expect(captured.elements[0].assemblyClips![0].tracks.every(track => track.keyframes.length >= 1)).toBe(true);
    const placed = placeAssemblyClip(captured, 'root', clipId, 3).project;
    placed.elements[1].rotation = 5;
    expect(armRotation(placed, 3.02)).toBe(35);
    expect(armRotation(placed, 7)).toBe(35);
  });

  it('repeats a clip when its placed instance is set to loop', () => {
    const source = assemblyProject();
    const { project: captured, clipId } = captureAssemblyClip(source, 'root', 0, 2, 'Wave');
    const placed = placeAssemblyClip(captured, 'root', clipId, 2, 4).project;
    placed.elements[0].clipInstances![0].loop = true;
    expect(armRotation(placed, 3)).toBeCloseTo(45);
    expect(armRotation(placed, 4.5)).toBeCloseTo(22.5);
    expect(armRotation(placed, 7)).toBe(90);
  });

  it('keeps a copied assembly independent while preserving its clip references', async () => {
    const source = assemblyProject();
    const { project: captured, clipId } = captureAssemblyClip(source, 'root', 0, 2, 'Wave');
    const placed = placeAssemblyClip(captured, 'root', clipId, 3).project;
    const duplicate = duplicateElements(placed, ['root']).project;
    const copiedRoot = duplicate.elements.find(element => element.name === 'Paper actor copy')!;
    const copiedArm = duplicate.elements.find(element => element.parentId === copiedRoot.id)!;
    expect(copiedRoot.assemblyClips![0].id).not.toBe(clipId);
    expect(copiedRoot.assemblyClips![0].tracks.some(track => track.elementId === copiedArm.id)).toBe(true);
    expect(copiedRoot.clipInstances![0].clipId).toBe(copiedRoot.assemblyClips![0].id);
    expect(armRotation(duplicate, 4, copiedArm.id)).toBeCloseTo(45);
    const roundtrip = await loadProjectFile(new File([await saveProjectBlob(duplicate)], 'copies.hy'));
    expect(armRotation(roundtrip, 4, copiedArm.id)).toBeCloseTo(45);
  });

  it('remaps clip references during scene duplication and retimes placements with their scene', async () => {
    const source = assemblyProject();
    const { project: captured, clipId } = captureAssemblyClip(source, 'root', 0, 2, 'Wave');
    const placed = placeAssemblyClip(captured, 'root', clipId, 3).project;
    const duplicated = duplicateScene(placed, placed.sequences[0].id);
    const copiedRoot = duplicated.project.elements.find(element => element.sceneId === duplicated.sceneId && element.name === 'Paper actor')!;
    const copiedArm = duplicated.project.elements.find(element => element.parentId === copiedRoot.id)!;
    expect(copiedRoot.assemblyClips![0].tracks.some(track => track.elementId === copiedArm.id)).toBe(true);
    expect(armRotation(duplicated.project, 12, copiedArm.id)).toBeCloseTo(45);
    await expect(saveProjectBlob(duplicated.project)).resolves.toBeInstanceOf(Blob);
    const retimed = retimeScene(placed, placed.sequences[0].id, 16);
    expect(retimed.elements[0].clipInstances![0]).toMatchObject({ start: 6, duration: 4 });
    expect(armRotation(retimed, 8)).toBeCloseTo(45);
  });

  it('carries playable clips through .hyproj export and import with fresh part/key identities', async () => {
    const source = assemblyProject();
    const { project: captured, clipId } = captureAssemblyClip(source, 'root', 0, 2, 'Wave');
    const placed = placeAssemblyClip(captured, 'root', clipId, 3).project;
    const assembly = makeAssembly(placed, ['root']);
    const opened = await loadAssemblyFile(new File([await saveAssemblyBlob(assembly)], 'actor.hyproj'));
    const imported = insertAssemblyAt(createProject(), opened, 0);
    const root = imported.elements.find(element => element.name === 'Paper actor')!;
    const arm = imported.elements.find(element => element.parentId === root.id)!;
    expect(root.id).not.toBe('root');
    expect(root.assemblyClips![0].tracks.some(track => track.elementId === arm.id)).toBe(true);
    expect(root.assemblyClips![0].tracks.flatMap(track => track.keyframes).every(frame => !source.elements[1].tracks[0].keyframes.some(old => old.id === frame.id))).toBe(true);
    expect(armRotation(imported, 4, arm.id)).toBeCloseTo(45);
  });

  it('plays an assembly clip in linked scenes at the source-time rate', () => {
    const source = assemblyProject();
    const { project: captured, clipId } = captureAssemblyClip(source, 'root', 0, 2, 'Wave');
    const placed = placeAssemblyClip(captured, 'root', clipId, 0).project;
    const linked = placeLinkedScene(placed, placed.sequences[0].id, 10).project;
    const link = linked.sequences[1];
    link.duration = 4;
    linked.duration = 14;
    expect(armRotation(linked, 10.5, `${link.id}::arm`)).toBeCloseTo(45);
  });

  it('keeps linked assembly clips playable when their scene is made independent or baked for export', async () => {
    const source = assemblyProject();
    const { project: captured, clipId } = captureAssemblyClip(source, 'root', 0, 2, 'Wave');
    const placed = placeAssemblyClip(captured, 'root', clipId, 0).project;
    const linked = placeLinkedScene(placed, placed.sequences[0].id, 10).project;
    const link = linked.sequences[1];
    link.duration = 4; linked.duration = 14;
    const detached = makeSceneIndependent(linked, link.id);
    const newRoot = detached.elements.find(element => element.sceneId === link.id && element.name === 'Paper actor')!;
    const newArm = detached.elements.find(element => element.parentId === newRoot.id)!;
    expect(newRoot.clipInstances![0].duration).toBe(1);
    expect(newRoot.assemblyClips![0].tracks.some(track => track.elementId === newArm.id)).toBe(true);
    expect(armRotation(detached, 10.5, newArm.id)).toBeCloseTo(45);
    const reopened = await loadProjectFile(new File([await saveProjectBlob(detached)], 'detached.hyde'));
    expect(armRotation(reopened, 10.5, newArm.id)).toBeCloseTo(45);
    const baked = bakeScenePlacements(linked);
    expect(baked.sequences.every(scene => !scene.sourceSceneId)).toBe(true);
    await expect(saveProjectBlob(baked)).resolves.toBeInstanceOf(Blob);
  });

  it('rejects broken clip references and invalid timing at archive boundaries', async () => {
    const source = assemblyProject();
    const { project, clipId } = captureAssemblyClip(source, 'root', 0, 2, 'Wave');
    project.elements[0].assemblyClips![0].tracks[0].elementId = 'missing';
    await expect(saveProjectBlob(project)).rejects.toThrow('missing part');
    project.elements[0].assemblyClips![0].tracks[0].elementId = 'root';
    project.elements[0].assemblyClips![0].duration = 0;
    await expect(saveProjectBlob(project)).rejects.toThrow('Assembly clip duration');
    project.elements[0].assemblyClips![0].duration = 2;
    project.elements[0].clipInstances = [{ id: 'instance', clipId: 'missing', start: 0, duration: 2 }];
    await expect(saveProjectBlob(project)).rejects.toThrow('missing definition');
    expect(() => placeAssemblyClip(source, 'root', clipId, 0)).toThrow('no longer exists');
    expect(() => captureAssemblyClip(source, 'root', 0, 0, 'Bad')).toThrow('one project frame');
  });
});
