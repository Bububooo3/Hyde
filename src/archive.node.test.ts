// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createElement, createProject } from './model';
import { decodeAssemblyBytes, decodeProjectBytes, encodeAssemblyBytes, encodeProjectBytes } from './archive';
import type { Assembly } from './model';
import { zipSync } from 'fflate';
import { createPrimaryShowcase } from './showcase';

const bytesUrl = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
function archiveWithAsset(mime: string, kind: 'image' | 'video' | 'audio' | 'font', bytes: Uint8Array): Uint8Array {
  const project = createProject('Import safety');
  project.assets.push({ id: 'asset', name: 'reference', kind, mime, dataUrl: bytesUrl(mime, bytes) });
  return encodeProjectBytes(project);
}

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

  it('rejects recognized MIME or kind mismatches while preserving historical opaque media', () => {
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64'));
    expect(decodeProjectBytes(archiveWithAsset('image/png', 'image', png)).assets[0].dataUrl).toBe(bytesUrl('image/png', png));
    expect(() => decodeProjectBytes(archiveWithAsset('image/jpeg', 'image', png))).toThrow(/MIME type does not match/);
    expect(() => decodeProjectBytes(archiveWithAsset('audio/wav', 'image', png))).toThrow(/kind does not match/);
    const opaque = Uint8Array.of(1, 2, 3, 4);
    expect(decodeProjectBytes(archiveWithAsset('image/png', 'image', opaque)).assets[0].dataUrl).toBe(bytesUrl('image/png', opaque));
  });

  it('accepts a self-contained SVG and refuses scripts, external resources, and disguised markup', () => {
    const svg = (source: string) => new TextEncoder().encode(source);
    const safe = svg('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="4" height="4" fill="url(#paint)"/></svg>');
    expect(decodeProjectBytes(archiveWithAsset('image/svg+xml', 'image', safe)).assets[0].mime).toBe('image/svg+xml');
    const executable = svg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(() => decodeProjectBytes(archiveWithAsset('image/svg+xml', 'image', executable))).toThrow(/Unsafe SVG asset/);
    const entityEncodedUrl = svg('<svg xmlns="http://www.w3.org/2000/svg"><image href="h&#116;tps://example.com/pixel.png"/></svg>');
    expect(() => decodeProjectBytes(archiveWithAsset('image/svg+xml', 'image', entityEncodedUrl))).toThrow(/external resource reference/);
    const doctype = svg('<!DOCTYPE svg [<!ENTITY ext SYSTEM "https://example.com/a">]><svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(() => decodeProjectBytes(archiveWithAsset('image/svg+xml', 'image', doctype))).toThrow(/unsupported declarations/);
    const externalStylesheet = svg('<?xml-stylesheet href="https://example.com/style.css"?><svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(() => decodeProjectBytes(archiveWithAsset('image/svg+xml', 'image', externalStylesheet))).toThrow(/unsupported declarations/);
    expect(() => decodeProjectBytes(archiveWithAsset('image/png', 'image', executable))).toThrow(/MIME type does not match|active markup/);
    expect(() => decodeProjectBytes(archiveWithAsset('image/png', 'image', svg('<!-- comment --><svg xmlns="http://www.w3.org/2000/svg"/>')))).toThrow(/active markup/);
    expect(() => decodeProjectBytes(encodeProjectBytes(createPrimaryShowcase()))).not.toThrow();
  });
});
