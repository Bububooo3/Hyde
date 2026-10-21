// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { editAssemblyClipGapTransition, editAssemblyClipPriority, placeAssemblyClip, selectAssemblyClipGapSegments } from './assemblyClips';
import { evaluateProject } from './engine';
import { createElement, createProject, type Keyframe, type Project } from './model';
import { materializeScenePlacements, placeLinkedScene } from './scenePlacement';
import { loadAssemblyFile, loadProjectFile, saveAssemblyBlob, saveProjectBlob } from './storage';
import { insertAssemblyAt, makeAssembly } from './editing';
import { captureAssemblyClip } from './assemblyClips';

const key = (time: number, value: number): Keyframe => ({ id: crypto.randomUUID(), time, value, easing: 'linear', direction: 'in', mode: 'smooth' });

function twoClips(): { project: Project; incomingId: string } {
  let project = createProject();
  const sceneId = project.sequences[0].id;
  project.elements = [
    createElement('group', { id: 'root', name: 'Actor', x: 300, y: 200, width: 0, height: 0, duration: 8, sceneId }),
    createElement('rectangle', { id: 'arm', name: 'Arm', parentId: 'root', x: 40, y: 0, rotation: 0, duration: 8, sceneId,
      tracks: [{ property: 'rotation', keyframes: [key(0, 0), key(2, 90)] }] }),
  ];
  const outgoing = captureAssemblyClip(project, 'root', 0, 2, 'Raise');
  const incoming = captureAssemblyClip(outgoing.project, 'root', 0, 2, 'Lower');
  project = incoming.project;
  const rotation = project.elements[0].assemblyClips![1].tracks.find(track => track.elementId === 'arm' && track.property === 'rotation')!;
  rotation.keyframes[0].value = 180;
  rotation.keyframes[1].value = 270;
  const x = project.elements[0].assemblyClips![1].tracks.find(track => track.elementId === 'arm' && track.property === 'x')!;
  x.keyframes[0].value = 100;
  project = placeAssemblyClip(project, 'root', outgoing.clipId, 2).project;
  const placed = placeAssemblyClip(project, 'root', incoming.clipId, 6);
  return { project: placed.project, incomingId: placed.instanceId };
}

function armRotation(project: Project, time: number, id = 'arm'): number {
  const arm = evaluateProject(project, time).find(element => element.id === id);
  if (!arm) throw new Error('The arm was not visible.');
  return arm.rotation;
}

describe('assembly clip gap transitions', () => {
  it('derives a visible, per-property gap and tweens automatically without changing the reusable clips', () => {
    const { project, incomingId } = twoClips();
    const before = structuredClone(project);
    const gaps = selectAssemblyClipGapSegments(project, { rootId: 'root', start: 4.5, end: 5.5 });
    const rotation = gaps.find(gap => gap.elementId === 'arm' && gap.property === 'rotation')!;
    expect(rotation).toMatchObject({ fromInstanceId: project.elements[0].clipInstances![0].id, toInstanceId: incomingId,
      start: 4, end: 6, mode: 'tween', easing: 'linear', direction: 'inOut' });
    expect(selectAssemblyClipGapSegments(project, { start: 0, end: 3 })).toHaveLength(0);
    expect(armRotation(project, 4)).toBeCloseTo(90);
    expect(armRotation(project, 5)).toBeCloseTo(135);
    expect(armRotation(project, 6)).toBeCloseTo(180);
    expect(project).toEqual(before);
  });

  it('holds or eases one part/property without changing the shared clip or other properties', () => {
    const { project, incomingId } = twoClips();
    const source = structuredClone(project.elements[0].assemblyClips);
    const held = editAssemblyClipGapTransition(project, 'root', incomingId, 'arm', 'rotation', { mode: 'hold' });
    expect(armRotation(held, 5)).toBeCloseTo(90);
    expect(evaluateProject(held, 5).find(element => element.id === 'arm')?.x).toBeCloseTo(370);
    expect(held.elements[0].assemblyClips).toEqual(source);
    const eased = editAssemblyClipGapTransition(held, 'root', incomingId, 'arm', 'rotation', { mode: 'tween', easing: 'quad', direction: 'in' });
    expect(armRotation(eased, 5)).toBeCloseTo(112.5);
    expect(selectAssemblyClipGapSegments(eased).find(gap => gap.elementId === 'arm' && gap.property === 'rotation')).toMatchObject({ mode: 'tween', easing: 'quad', direction: 'in' });
    const restored = editAssemblyClipGapTransition(eased, 'root', incomingId, 'arm', 'rotation', null);
    expect(restored.elements[0].clipInstances![1].gapTransitions).toBeUndefined();
    expect(armRotation(restored, 5)).toBeCloseTo(135);
    expect(project.elements[0].clipInstances![1].gapTransitions).toBeUndefined();
    expect(() => editAssemblyClipGapTransition(project, 'root', incomingId, 'arm', 'volume', { mode: 'hold' })).toThrow(/does not animate/);
  });

  it('does not add gap segments through overlap or change overlap blending', () => {
    const { project, incomingId } = twoClips();
    const overlapping = structuredClone(project);
    overlapping.elements[0].clipInstances!.find(item => item.id === incomingId)!.start = 3;
    expect(selectAssemblyClipGapSegments(overlapping).filter(gap => gap.property === 'rotation')).toHaveLength(0);
    expect(armRotation(overlapping, 3.5)).toBeCloseTo(135);
  });

  it('uses explicit per-property priority only during overlap, preserving the other automatic tracks', async () => {
    const {project,incomingId}=twoClips();
    const overlapping=structuredClone(project);
    overlapping.elements[0].clipInstances!.find(item=>item.id===incomingId)!.start=3;
    const outgoingId=overlapping.elements[0].clipInstances![0].id;
    const outgoing=editAssemblyClipPriority(overlapping,'root',outgoingId,'arm','rotation',4);
    expect(armRotation(outgoing,3.5)).toBeCloseTo(67.5);
    expect(armRotation(outgoing,4.5)).toBeCloseTo(247.5);
    const incoming=editAssemblyClipPriority(outgoing,'root',incomingId,'arm','rotation',5);
    expect(armRotation(incoming,3.5)).toBeCloseTo(202.5);
    const reopened=await loadProjectFile(new File([await saveProjectBlob(incoming)],'priority.hyde'));
    expect(armRotation(reopened,3.5)).toBeCloseTo(202.5);
    const restored=editAssemblyClipPriority(incoming,'root',incomingId,'arm','rotation',0);
    expect(armRotation(restored,3.5)).toBeCloseTo(67.5);
    const automatic=editAssemblyClipPriority(restored,'root',outgoingId,'arm','rotation',0);
    expect(armRotation(automatic,3.5)).toBeCloseTo(135);
    expect(()=>editAssemblyClipPriority(project,'root',incomingId,'arm','rotation',10.5)).toThrow(/whole number/);
  });

  it('maps the same transition into a linked scene and preserves it in project and assembly archives', async () => {
    const { project, incomingId } = twoClips();
    const eased = editAssemblyClipGapTransition(project, 'root', incomingId, 'arm', 'rotation', { easing: 'quad', direction: 'in' });
    const linked = placeLinkedScene(eased, eased.sequences[0].id, 10).project;
    const placement = linked.sequences[1];
    placement.duration = 4; linked.duration = 14;
    const virtualRoot = `${placement.id}::root`;
    const virtualArm = `${placement.id}::arm`;
    const gap = selectAssemblyClipGapSegments(materializeScenePlacements(linked), { rootId: virtualRoot }).find(item => item.property === 'rotation')!;
    expect(gap).toMatchObject({ elementId: virtualArm, start: 12, end: 13, easing: 'quad' });
    expect(armRotation(linked, 12.5, virtualArm)).toBeCloseTo(112.5);

    const reopened = await loadProjectFile(new File([await saveProjectBlob(eased)], 'gap.hyde'));
    expect(armRotation(reopened, 5)).toBeCloseTo(112.5);
    const assembly = makeAssembly(eased, ['root']);
    const loadedAssembly = await loadAssemblyFile(new File([await saveAssemblyBlob(assembly)], 'actor.hyproj'));
    const imported = insertAssemblyAt(createProject(), loadedAssembly, 0);
    const root = imported.elements.find(element => element.name === 'Actor')!;
    const arm = imported.elements.find(element => element.parentId === root.id)!;
    expect(root.clipInstances![1].gapTransitions![0].elementId).toBe(arm.id);
    expect(armRotation(imported, 5, arm.id)).toBeCloseTo(112.5);
  });

  it('rejects broken gap transition metadata at the archive boundary', async () => {
    const { project, incomingId } = twoClips();
    const invalid = editAssemblyClipGapTransition(project, 'root', incomingId, 'arm', 'rotation', { mode: 'hold' });
    invalid.elements[0].clipInstances![1].gapTransitions![0].elementId = 'missing';
    await expect(saveProjectBlob(invalid)).rejects.toThrow(/incoming clip property/);
  });
});
