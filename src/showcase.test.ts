// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {evaluateProject} from './engine';
import {createPrimaryShowcase} from './showcase';
import {loadProjectFile,saveProjectBlob} from './storage';

it('primary showcase integrates assemblies, cameras, creative text, audio and a linked inset through a project archive',async()=>{
  const project=createPrimaryShowcase();
  expect(project.sequences.map(scene=>scene.name)).toEqual(['01 · A small beginning','02 · Across the night','The beginning · inset']);
  expect(project.elements.find(element=>element.name==='Paper lantern · assembly')?.assemblyClips?.length).toBe(1);
  expect(project.elements.some(element=>element.textAnimation?.effect==='slide')).toBe(true);
  expect(project.elements.some(element=>element.shapePath&&element.assetId==='map-paper')).toBe(true);
  expect(project.elements.some(element=>element.audioEffects?.some(effect=>effect.type==='reverb'))).toBe(true);
  expect(project.assets.find(asset=>asset.id==='keeper-chime')?.dataUrl).toMatch(/^data:audio\/wav;base64,/);
  const before=evaluateProject(project,8.5);
  expect(before.some(element=>element.id.startsWith('showcase-memory::'))).toBe(true);
  expect(before.find(element=>element.id==='sky-assembly')?.y).toBeLessThan(444);
  const reopened=await loadProjectFile(new File([await saveProjectBlob(project)],'lantern.hyde'));
  expect(evaluateProject(reopened,8.5).map(element=>element.id)).toEqual(before.map(element=>element.id));
  expect(reopened.webPlayer?.posterTime).toBe(1.3);
});
