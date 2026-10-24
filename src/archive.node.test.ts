// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createElement, createProject } from './model';
import { decodeAssemblyBytes, decodeProjectBytes, encodeAssemblyBytes, encodeProjectBytes, HydeSchemaUnsupportedError, migrateArchiveBytes } from './archive';
import type { Assembly } from './model';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createPrimaryShowcase } from './showcase';

const bytesUrl = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
function archiveWithAsset(mime: string, kind: 'image' | 'video' | 'audio' | 'font', bytes: Uint8Array): Uint8Array {
  const project = createProject('Import safety');
  project.assets.push({ id: 'asset', name: 'reference', kind, mime, dataUrl: bytesUrl(mime, bytes) });
  return encodeProjectBytes(project);
}
function changeManifest(bytes: Uint8Array, edit: (xml: string) => string): Uint8Array {
  const files = unzipSync(bytes);
  files['manifest.xml'] = strToU8(edit(strFromU8(files['manifest.xml'])));
  return zipSync(files);
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
    expect(() => encodeProjectBytes(future as never)).toThrow(HydeSchemaUnsupportedError);
  });

  it('validates a detached migration result and explicitly rejects future schema versions', () => {
    const project = createProject('Safe migration boundary') as ReturnType<typeof createProject> & { optionalProducer?: { note: string } };
    project.optionalProducer = { note: 'preserved' };
    const original = encodeProjectBytes(project);
    const source = Uint8Array.from(original);
    const current = migrateArchiveBytes(source, 'project');
    expect(current).toMatchObject({ archiveType: 'project', sourceVersion: 1, targetVersion: 1, changed: false });
    expect(current.bytes).toEqual(original);
    expect(current.bytes).not.toBe(source);
    expect((decodeProjectBytes(current.bytes) as typeof project).optionalProducer).toEqual({ note: 'preserved' });
    current.bytes[0] ^= 1;
    expect(source).toEqual(original);

    const futureManifest = changeManifest(original, xml => xml.replace('<hyde-document type="project" version="1">', '<hyde-document type="project" version="2">'));
    const futureCopy = Uint8Array.from(futureManifest);
    expect(() => migrateArchiveBytes(futureManifest, 'project')).toThrowError(HydeSchemaUnsupportedError);
    expect(() => decodeProjectBytes(futureManifest)).toThrowError(HydeSchemaUnsupportedError);
    expect(futureManifest).toEqual(futureCopy);
    try { migrateArchiveBytes(futureManifest, 'project'); }
    catch (error) { expect(error).toMatchObject({ code: 'SCHEMA_UNSUPPORTED', archiveType: 'project', source: 'manifest', actualVersion: 2 }); }

    const futureModel = changeManifest(original, xml => xml.replace('<field name="version"><number>1</number></field>', '<field name="version"><number>2</number></field>'));
    expect(() => migrateArchiveBytes(futureModel, 'project')).toThrowError(HydeSchemaUnsupportedError);
    try { decodeProjectBytes(futureModel); }
    catch (error) { expect(error).toMatchObject({ code: 'SCHEMA_UNSUPPORTED', source: 'model', actualVersion: 2 }); }
    expect(() => migrateArchiveBytes(original, 'project', 2)).toThrowError(HydeSchemaUnsupportedError);
    expect(source).toEqual(original);

    const assembly: Assembly = { format: 'hyde-assembly', version: 1, name: 'Parts', elements: [createElement('ellipse')], assets: [] };
    const assemblyBytes = encodeAssemblyBytes(assembly);
    expect(migrateArchiveBytes(assemblyBytes, 'assembly').bytes).toEqual(assemblyBytes);
    expect(() => migrateArchiveBytes(assemblyBytes, 'project')).toThrow(/Wrong archive type/);
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
