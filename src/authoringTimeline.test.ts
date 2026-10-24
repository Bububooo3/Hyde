import { describe, expect, it } from 'vitest';
import { validateDocument } from './archive';
import { applyTimelineCommand, timelineOperations, type TimelineCommand, type TimelineCommandContext } from './authoringTimeline';
import { createElement, createProject } from './model';

function harness() {
  const aliases = new Map<string, string>();
  const context: TimelineCommandContext = {
    resolve(ref) { if (!ref.startsWith('$')) return ref; const id = aliases.get(ref); if (!id) throw new Error(`Unknown batch alias ${ref}.`); return id; },
    register(alias, id) { if (!alias) return; if (!alias.startsWith('$') || aliases.has(alias)) throw new Error('Alias must be a unique name beginning with $.'); aliases.set(alias, id); },
  };
  const original = createProject('Timeline authoring');
  const root = createElement('group', { id: 'root', sceneId: original.sequences[0].id, start: 0, duration: 8 });
  const child = createElement('rectangle', { id: 'child', sceneId: root.sceneId, parentId: root.id, attachment: { type: 'fixed', parentId: root.id }, start: 0, duration: 8 });
  original.elements.push(root, child);
  let project = original;
  const apply = (command: TimelineCommand) => { project = applyTimelineCommand(project, command, context); validateDocument(project, false); return project; };
  return { original, aliases, apply, get project() { return project; } };
}

describe('SDK timeline command adapter', () => {
  it('authors element tracks and scene-local camera keys with stable aliases', () => {
    const h = harness(), sceneId = h.project.sequences[0].id;
    h.apply({ op: 'keyframe.upsert', args: { elementId: 'child', property: 'x', timeSeconds: 1.25, value: 100, alias: '$move' } });
    h.apply({ op: 'keyframe.move', args: { elementId: 'child', property: 'x', id: '$move', timeSeconds: 2.5 } });
    expect(h.project.elements[1].tracks[0].keyframes[0]).toMatchObject({ id: h.aliases.get('$move'), time: 2.5, value: 100 });
    h.apply({ op: 'scene.setCamera', args: { sceneId, camera: { zoom: 1.5 } } });
    h.apply({ op: 'camera.upsertKeyframe', args: { sceneId, property: 'zoom', timeSeconds: 1.75, value: 1.8, alias: '$camera' } });
    expect(h.project.sequences[0].camera?.tracks[0].keyframes[0].time).toBe(1.75);
    h.apply({ op: 'camera.deleteKeyframe', args: { sceneId, property: 'zoom', id: '$camera' } });
    h.apply({ op: 'keyframe.remove', args: { elementId: 'child', property: 'x', id: '$move' } });
    h.apply({ op: 'track.remove', args: { elementId: 'child', property: 'x' } });
    expect(h.project.elements[1].tracks).toEqual([]);
    expect(h.original.elements[1].tracks).toEqual([]);
  });

  it('creates bounded procedural motion and rejects unsupported settings', () => {
    const h = harness();
    h.apply({ op: 'motion.add', args: { elementId: 'child', behavior: { type: 'oscillation', settings: { property: 'rotation', amplitude: 25, frequency: 2 } }, alias: '$motion' } });
    h.apply({ op: 'motion.update', args: { elementId: 'child', id: '$motion', settings: { phase: 45 } } });
    expect(h.project.elements[1].motionBehaviors?.[0]).toMatchObject({ id: h.aliases.get('$motion'), property: 'rotation', phase: 45 });
    expect(() => h.apply({ op: 'motion.update', args: { elementId: 'child', id: '$motion', settings: { type: 'shake' } as never } })).toThrow(/does not support type/);
    h.apply({ op: 'motion.remove', args: { elementId: 'child', id: '$motion' } });
    expect(h.project.elements[1].motionBehaviors).toBeUndefined();
  });

  it('uses Hyde clip functions for capture, placements, gaps, priority, keys, and shared definition rules', () => {
    const h = harness();
    h.apply({ op: 'keyframe.upsert', args: { elementId: 'child', property: 'x', timeSeconds: 0, value: 480 } });
    h.apply({ op: 'keyframe.upsert', args: { elementId: 'child', property: 'x', timeSeconds: 2, value: 650 } });
    h.apply({ op: 'clip.capture', args: { rootId: 'root', sourceStart: 0, duration: 2, name: 'Move', alias: '$clip' } });
    h.apply({ op: 'clip.place', args: { rootId: 'root', clipId: '$clip', at: 1, alias: '$first' } });
    h.apply({ op: 'clip.place', args: { rootId: 'root', clipId: '$clip', at: 4, alias: '$second' } });
    h.apply({ op: 'clip.setGapTransition', args: { rootId: 'root', instanceId: '$second', elementId: 'child', property: 'x', transition: { mode: 'hold' } } });
    h.apply({ op: 'clip.setPriority', args: { rootId: 'root', instanceId: '$second', elementId: 'child', property: 'x', priority: 3 } });
    h.apply({ op: 'clip.editPlacedKey', args: { rootId: 'root', clipId: '$clip', instanceId: '$second', elementId: 'child', property: 'x', action: 'add', timeSeconds: 1, alias: '$placed' } });
    const root = h.project.elements[0], second = root.clipInstances!.find(item => item.id === h.aliases.get('$second'))!;
    expect(second.gapTransitions?.[0].mode).toBe('hold');
    expect(second.priorityOverrides?.[0].priority).toBe(3);
    expect(second.trackOverrides?.find(item => item.elementId === 'child' && item.property === 'x')?.keyframes.some(key => key.id === h.aliases.get('$placed'))).toBe(true);
    expect(root.assemblyClips!.find(item => item.id === h.aliases.get('$clip'))!.tracks.find(item => item.elementId === 'child' && item.property === 'x')!.keyframes).toHaveLength(2);
    h.apply({ op: 'clip.editPlacedKey', args: { rootId: 'root', clipId: '$clip', instanceId: '$second', elementId: 'child', property: 'x', action: 'edit', keyId: '$placed', patch: { value: 720 } } });
    expect(h.project.elements[0].clipInstances![1].trackOverrides?.find(item => item.elementId === 'child' && item.property === 'x')?.keyframes.find(key => key.id === h.aliases.get('$placed'))?.value).toBe(720);
    h.apply({ op: 'clip.editPlacedKey', args: { rootId: 'root', clipId: '$clip', instanceId: '$second', elementId: 'child', property: 'x', action: 'remove', keyId: '$placed' } });
    h.apply({ op: 'clip.editPlacedKey', args: { rootId: 'root', clipId: '$clip', instanceId: '$second', elementId: 'child', property: 'x', action: 'resetOverride' } });
    expect(h.project.elements[0].clipInstances![1].trackOverrides).toBeUndefined();
    expect(() => h.apply({ op: 'clip.remove', args: { rootId: 'root', clipId: '$clip' } })).toThrow(/placed instances/);
    h.apply({ op: 'clip.remove', args: { rootId: 'root', clipId: '$clip', removeInstances: true } });
    expect(h.project.elements[0].assemblyClips).toBeUndefined();
  });

  it('keeps texture overlap policy on an incoming placement', () => {
    const h = harness();
    h.original.assets.push({ id: 'texture', name: 'Test texture', kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
    h.original.elements[1].assetId = 'texture';
    h.apply({ op: 'clip.capture', args: { rootId: 'root', sourceStart: 0, duration: 2, alias: '$clip' } });
    h.apply({ op: 'clip.place', args: { rootId: 'root', clipId: '$clip', at: 0, alias: '$placed' } });
    h.apply({ op: 'clip.setTextureOverlap', args: { rootId: 'root', instanceId: '$placed', elementId: 'child', overlap: { mode: 'single', switchPoint: 0.7, switchesPerSecond: 4 } } });
    expect(h.project.elements[0].clipInstances?.[0].textureOverlaps).toEqual([{ elementId: 'child', mode: 'single', switchPoint: 0.7, switchesPerSecond: 4 }]);
  });

  it('advertises every implemented operation', () => {
    expect(timelineOperations).toContain('clip.setTextureOverlap');
    expect(timelineOperations).toContain('camera.upsertKeyframe');
  });
});
