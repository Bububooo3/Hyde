import {afterEach, describe, expect, it, vi} from 'vitest';
import type {Asset} from './model';
import {createProject,createElement} from './model';
import {addProjectFont,fontFamilyForAsset, ProjectFontLoader} from './projectFonts';

const font = (name = 'Hand Lettering.woff2', dataUrl = 'data:font/woff2;base64,AA=='): Asset =>
  ({id: 'original-id', name, kind: 'font', mime: 'font/woff2', dataUrl});

afterEach(() => vi.unstubAllGlobals());

describe('packaged project fonts', () => {
  it('adds a font through the project operation, keeps attribution, and assigns unique names', () => {
    const project=createProject();
    const text=createElement('text',{name:'Title'});
    project.elements.push(text);
    const source={name:'Display.woff2',mime:'font/woff2',dataUrl:'data:font/woff2;base64,AA==',licenseNotice:'Font notice'};
    const first=addProjectFont(project,source,text.id);
    expect(first.project.elements[0].fontFamily).toBe(fontFamilyForAsset(first.asset));
    expect(first.asset.licenseNotice).toBe('Font notice');
    const second=addProjectFont(first.project,source,text.id);
    expect(second.asset.name).toBe('Display (2).woff2');
    expect(second.project.elements[0].fontFamily).toBe(fontFamilyForAsset(second.asset));
    expect(project.assets).toHaveLength(0);
  });
  it('uses the unique name rather than an ID and produces a CSS-safe family', () => {
    const original = font('Lettering – A.woff2');
    const remapped = {...original, id: 'assembly-import-id'};
    expect(fontFamilyForAsset(original)).toBe(fontFamilyForAsset(remapped));
    expect(fontFamilyForAsset(original)).toMatch(/^HydeFont_[a-f0-9]{16}$/);
    expect(fontFamilyForAsset(font('Lettering – B.woff2'))).not.toBe(fontFamilyForAsset(original));
  });

  it('loads before layout, shares a face between renderers, and releases it after the last renderer', async () => {
    let finish!: () => void;
    const add = vi.fn(), remove = vi.fn();
    const instances: {family: string; source: string}[] = [];
    class MockFontFace {
      constructor(public family: string, public source: string) { instances.push(this); }
      load() { return new Promise<MockFontFace>(resolve => { finish = () => resolve(this); }); }
    }
    vi.stubGlobal('FontFace', MockFontFace);
    vi.stubGlobal('document', {fonts: {add, delete: remove}});
    const first = new ProjectFontLoader(), second = new ProjectFontLoader();
    const asset = font();
    const firstReady = first.sync([asset]);
    const secondReady = second.sync([{...asset, id: 'remapped'}]);
    expect(add).not.toHaveBeenCalled();
    expect(instances).toHaveLength(1);
    expect(instances[0].family).toBe(fontFamilyForAsset(asset));
    expect(instances[0].source).toContain(asset.dataUrl);
    finish();
    expect(await firstReady).toBe(true);
    expect(await secondReady).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    first.dispose();
    expect(remove).not.toHaveBeenCalled();
    second.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does not register a font whose renderer was destroyed while decoding', async () => {
    let finish!: () => void;
    const add = vi.fn();
    class MockFontFace {
      constructor(public family: string, public source: string) {}
      load() { return new Promise<MockFontFace>(resolve => { finish = () => resolve(this); }); }
    }
    vi.stubGlobal('FontFace', MockFontFace);
    vi.stubGlobal('document', {fonts: {add, delete: vi.fn()}});
    const loader = new ProjectFontLoader();
    const pending = loader.sync([font('Temporary.woff2')]);
    loader.dispose();
    finish();
    await pending;
    expect(add).not.toHaveBeenCalled();
  });

  it('replaces a changed font file with the same name without retaining the old face', async () => {
    const add = vi.fn(), remove = vi.fn();
    class MockFontFace {
      constructor(public family: string, public source: string) {}
      async load() { return this; }
    }
    vi.stubGlobal('FontFace', MockFontFace);
    vi.stubGlobal('document', {fonts: {add, delete: remove}});
    const loader = new ProjectFontLoader();
    expect(await loader.sync([font()])).toBe(true);
    expect(await loader.sync([font()])).toBe(false);
    expect(await loader.sync([font('Hand Lettering.woff2', 'data:font/woff2;base64,AQ==')])).toBe(true);
    expect(add).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
    loader.dispose();
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
