import { describe, expect, it } from 'vitest';
import { decodeProjectBytes, encodeProjectBytes, validateDocument } from './archive';
import { applyMediaAuthoringCommand, MediaAuthoringError, type MediaAuthoringContext, type MediaAuthoringCommand } from './authoringMedia';
import { createElement, createProject, type Project } from './model';

function fixture(): Project {
  const project = createProject('Media commands');
  const sceneId = project.sequences[0].id;
  project.assets.push(
    { id: 'image-source', name: 'Picture', mime: 'image/png', kind: 'image', dataUrl: 'data:image/png;base64,AA==' },
    { id: 'audio-source', name: 'Sound', mime: 'audio/wav', kind: 'audio', duration: 12, dataUrl: 'data:audio/wav;base64,AA==' },
    { id: 'video-source', name: 'Movie', mime: 'video/mp4', kind: 'video', duration: 10, dataUrl: 'data:video/mp4;base64,AA==' },
  );
  project.elements.push(
    createElement('rectangle', { id: 'shape', sceneId, width: 200, height: 100 }),
    createElement('text', { id: 'label', sceneId, text: 'First', textLayout: 'static', staticLayoutWidth: 120 }),
    createElement('audio', { id: 'sound', sceneId, assetId: 'audio-source', duration: 8, start: 0, sourceOffset: 0, fadeIn: .5, fadeOut: .5 }),
    createElement('video', { id: 'movie', sceneId, assetId: 'video-source', duration: 8, start: 0, sourceOffset: 0 }),
  );
  validateDocument(project, false);
  return project;
}

function commands(initial: Project, list: MediaAuthoringCommand[]): { project: Project; aliases: Map<string, string> } {
  const aliases = new Map<string, string>();
  const context: MediaAuthoringContext = {
    resolveAlias: ref => ref.startsWith('$') ? aliases.get(ref) ?? (() => { throw new Error(`Unknown alias ${ref}`); })() : ref,
    bindAlias: (alias, id) => { if (aliases.has(alias)) throw new Error('Alias already exists.'); aliases.set(alias, id); },
  };
  const project = list.reduce((current, command) => applyMediaAuthoringCommand(current, command, context), initial);
  validateDocument(project, false);
  return { project, aliases };
}

describe('native media authoring commands', () => {
  it('keeps editable geometry while changing fill, placement, and projective pin', () => {
    const base = fixture();
    const { project } = commands(base, [
      { op: 'shape.setPrimitive', args: { id: 'shape', kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 100, y: 100 }] } },
      { op: 'media.setFill', args: { id: 'shape', assetId: 'image-source', fit: 'fit' } },
      { op: 'media.setPlacement', args: { id: 'shape', transform: { x: 10, y: -5, scaleX: 1.25, scaleY: 1, rotation: 20 } } },
      { op: 'media.setPin', args: { id: 'shape', corners: [{ x: 0, y: 0 }, { x: 1, y: .1 }, { x: .9, y: 1 }, { x: .1, y: .9 }] } },
      { op: 'media.setOpacity', args: { id: 'shape', opacity: .6 } },
    ]);
    const shape = project.elements.find(item => item.id === 'shape')!;
    expect(shape.kind).toBe('polygon');
    expect(shape.points).toHaveLength(3);
    expect(shape.mediaFit).toBe('fit');
    expect(shape.mediaPin).toHaveLength(4);
    expect(shape.mediaOpacity).toBe(.6);
    expect(base.elements[0].assetId).toBeUndefined();
    const reopened = decodeProjectBytes(encodeProjectBytes(project));
    expect(reopened.elements.find(item => item.id === 'shape')?.mediaPin).toEqual(shape.mediaPin);
    expect(reopened.elements.find(item => item.id === 'shape')?.points).toEqual(shape.points);
    expect(() => commands(project, [{ op: 'media.setPin', args: { id: 'shape', corners: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }] } }])).toThrow(/strictly convex/);
    expect(() => commands(project, [{ op: 'media.setOpacity', args: { id: 'shape', opacity: .4, opacityOverride: 1 } } as unknown as MediaAuthoringCommand])).toThrow(/does not support opacityOverride/);
  });

  it('edits text source and flow without persisting a stale static snapshot', () => {
    const base = fixture();
    base.elements.find(item => item.id === 'label')!.staticTextFlow = { mode: 'around', sourceText: 'First', fontFamily: 'Georgia', fontSize: 40, layoutWidth: 120, capturedAt: 0, lines: [] };
    const { project } = commands(base, [
      { op: 'text.setContent', args: { id: 'label', text: 'Revised' } },
      { op: 'text.setFont', args: { id: 'label', fontFamily: 'Georgia', fontSize: 28 } },
      { op: 'element.setTextMaskTarget', args: { id: 'label', targetId: 'shape', mode: 'inside' } },
      { op: 'text.setLayout', args: { id: 'label', layout: 'live' } },
      { op: 'text.setReflow', args: { id: 'label', reflow: { preset: 'glide', start: 0, duration: 1, stagger: .1, easing: 'sine', easingDirection: 'inOut' } } },
    ]);
    const label = project.elements.find(item => item.id === 'label')!;
    expect(label.text).toBe('Revised');
    expect(label.flowAroundId).toBe('shape');
    expect(label.staticTextFlow).toBeUndefined();
    expect(label.textReflow?.preset).toBe('glide');
    expect(() => commands(project, [{ op: 'text.captureStaticLayout', args: { id: 'label', timeSeconds: 0 } }])).toThrowError(MediaAuthoringError);
    try { commands(project, [{ op: 'text.captureStaticLayout', args: { id: 'label', timeSeconds: 0 } }]); }
    catch (error) { expect((error as MediaAuthoringError).code).toBe('INVALID_ARGUMENT'); }
    const staticProject = structuredClone(project);
    staticProject.elements.find(item => item.id === 'label')!.textLayout = 'static';
    expect(() => commands(staticProject, [{ op: 'text.captureStaticLayout', args: { id: 'label', timeSeconds: 0 } }])).toThrowError(MediaAuthoringError);
    try { commands(staticProject, [{ op: 'text.captureStaticLayout', args: { id: 'label', timeSeconds: 0 } }]); }
    catch (error) { expect((error as MediaAuthoringError).code).toBe('CAPABILITY_UNAVAILABLE'); }
  });

  it('uses Hyde source-window and split semantics for audio, with stable aliases', () => {
    const base = fixture();
    const { project, aliases } = commands(base, [
      { op: 'audio.setRange', args: { id: 'sound', inTime: 2, outTime: 8 } },
      { op: 'audio.setSpeedPitch', args: { id: 'sound', speed: 2, pitchSemitones: -3, linkSpeedPitch: false } },
      { op: 'audio.setMix', args: { id: 'sound', volume: .7, fadeIn: .2, fadeOut: .3 } },
      { op: 'audio.setEffects', args: { id: 'sound', effects: [{ id: 'echo-1', type: 'echo', enabled: true, delay: .25, feedback: .3, mix: .4 }] } },
      { op: 'audio.updateEffect', args: { id: 'sound', effectId: 'echo-1', patch: { enabled: false } } },
      { op: 'audio.split', args: { id: 'sound', at: 1.5, alias: '$right' } },
      { op: 'audio.duplicate', args: { id: '$right', start: 5, alias: '$copy' } },
    ]);
    const left = project.elements.find(item => item.id === 'sound')!;
    const right = project.elements.find(item => item.id === aliases.get('$right'))!;
    const copy = project.elements.find(item => item.id === aliases.get('$copy'))!;
    expect(left.duration).toBeCloseTo(1.5);
    expect(right.sourceOffset).toBeCloseTo(5);
    expect(right.duration).toBeCloseTo(1.5);
    expect(copy.sourceOffset).toBeCloseTo(5);
    expect(copy.audioEffects?.[0].id).not.toBe(right.audioEffects?.[0].id);
    expect(base.elements.find(item => item.id === 'sound')!.duration).toBe(8);
  });

  it('keeps video picture timing and embedded audio controls on one native element', () => {
    const { project } = commands(fixture(), [
      { op: 'video.setSourceTiming', args: { id: 'movie', inTime: 1, outTime: 7, speed: 2, endBehavior: 'hide' } },
      { op: 'video.setAudioMix', args: { id: 'movie', volume: .4, muted: false, fadeIn: .25, fadeOut: .25, pitchSemitones: 2, linkSpeedPitch: false } },
    ]);
    const movie = project.elements.find(item => item.id === 'movie')!;
    expect(movie.duration).toBeCloseTo(3);
    expect(movie.sourceOffset).toBe(1);
    expect(movie.videoEndBehavior).toBe('hide');
    expect(movie.volume).toBe(.4);
    expect(movie.linkSpeedPitch).toBe(false);
  });
});
