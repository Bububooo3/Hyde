// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createElement, createProject } from './model';
import { decodeAssemblyBytes, decodeProjectBytes, encodeAssemblyBytes, encodeProjectBytes } from './archive';
import type { Assembly } from './model';
import { zipSync } from 'fflate';

describe('portable archive bytes in Node', () => {
  it('round-trips native projects, embedded bytes, and safe optional fields', () => {
    const project = createProject('Node round trip');
    project.assets.push({ id: 'image', name: 'dot.png', kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,AQIDBA==' });
    project.elements.push(createElement('rectangle', { id: 'body', assetId: 'image', sceneId: project.sequences[0].id }));
    const extended = project as typeof project & { producerNote?: string };
    extended.producerNote = 'preserve me';
    const before = structuredClone(project);
    const bytes = encodeProjectBytes(project);
    const opened = decodeProjectBytes(bytes);
    expect(opened).toEqual(before);
    expect(project).toEqual(before);
    expect(decodeProjectBytes(encodeProjectBytes(opened))).toEqual(opened);
  });

  it('round-trips native assemblies and rejects unsupported schema versions', () => {
    const assembly: Assembly = { format: 'hyde-assembly', version: 1, name: 'Parts', elements: [createElement('ellipse')], assets: [] };
    expect(decodeAssemblyBytes(encodeAssemblyBytes(assembly))).toEqual(assembly);
    expect(() => decodeProjectBytes(encodeAssemblyBytes(assembly))).toThrow(/Wrong archive type/);
    const future = { ...createProject(), version: 2 };
    expect(() => encodeProjectBytes(future as never)).toThrow(/Unsupported document version/);
  });

  it('rejects extreme ZIP expansion before allocating the inflated asset', () => {
    const bomb = zipSync({ 'assets/huge.bin': new Uint8Array(36 * 1024 * 1024) }, { level: 9 });
    expect(() => decodeProjectBytes(bomb)).toThrow(/expansion ratio/);
  });
});
