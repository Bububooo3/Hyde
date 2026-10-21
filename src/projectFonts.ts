import {uid, type Asset, type Project} from './model';

/** Import a self-contained font and optionally apply it to the selected text. */
export function addProjectFont(project: Project, source: Pick<Asset, 'name' | 'mime' | 'dataUrl'> & {licenseNotice?: string}, textId?: string): {project: Project; asset: Asset} {
  const next = structuredClone(project);
  const match = /^(.*?)(\.[^.]+)?$/.exec(source.name)!;
  const stem = match[1] || 'Font', extension = match[2] || '';
  let name = source.name, index = 2;
  while (next.assets.some(asset => asset.kind === 'font' && asset.name.toLowerCase() === name.toLowerCase())) {
    name = `${stem} (${index++})${extension}`;
  }
  const asset: Asset = {id: uid(), kind: 'font', name, mime: source.mime, dataUrl: source.dataUrl};
  if (source.licenseNotice) asset.licenseNotice = source.licenseNotice;
  next.assets.push(asset);
  const text = next.elements.find(element => element.id === textId && element.kind === 'text');
  if (text) text.fontFamily = fontFamilyForAsset(asset);
  next.updatedAt = new Date().toISOString();
  return {project: next, asset};
}

/** A project font is addressed by its unique asset name, so archive and assembly ID remaps preserve references. */
export function fontFamilyForAsset(asset: Pick<Asset, 'name'>): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < asset.name.length; index++) {
    const code = asset.name.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x5bd1e995);
  }
  return `HydeFont_${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

interface LoadedFont {
  family: string;
  source: string;
  references: number;
  face?: FontFace;
  ready: Promise<void>;
}

// Renderer instances (editor, player, and a temporary export renderer) share one
// document FontFace. The data URL is already embedded in the project package.
const loadedFonts = new Map<string, LoadedFont>();

function release(font: LoadedFont): void {
  font.references--;
  if (font.references > 0) return;
  if (loadedFonts.get(font.family) === font) loadedFonts.delete(font.family);
  if (font.face) document.fonts.delete(font.face);
}

function acquire(asset: Asset): LoadedFont {
  const family = fontFamilyForAsset(asset);
  const existing = loadedFonts.get(family);
  if (existing) {
    if (existing.source !== asset.dataUrl) {
      throw new Error(`Two different font files use the same project font name: ${asset.name}`);
    }
    existing.references++;
    return existing;
  }
  const font: LoadedFont = { family, source: asset.dataUrl, references: 1, ready: Promise.resolve() };
  loadedFonts.set(family, font);
  font.ready = (async () => {
    try {
      const face = new FontFace(family, `url(${JSON.stringify(asset.dataUrl)})`);
      await face.load();
      // The owning renderer may have been destroyed while the font was decoding.
      if (font.references && loadedFonts.get(family) === font) {
        document.fonts.add(face);
        font.face = face;
      }
    } catch (error) {
      console.warn(`Hyde could not load font ${asset.name}:`, error);
    }
  })();
  return font;
}

/** Keeps a renderer's packaged fonts registered before its first text layout. */
export class ProjectFontLoader {
  private retained = new Map<string, LoadedFont>();
  private disposed = false;

  async sync(assets: readonly Asset[]): Promise<boolean> {
    if (this.disposed) return false;
    const desired = new Map<string, Asset>();
    for (const asset of assets) if (asset.kind === 'font') desired.set(fontFamilyForAsset(asset), asset);
    let changed = false;
    for (const [family, font] of this.retained) {
      if (desired.get(family)?.dataUrl === font.source) continue;
      release(font);
      this.retained.delete(family);
      changed = true;
    }
    for (const [family, asset] of desired) {
      if (this.retained.has(family)) continue;
      try { this.retained.set(family, acquire(asset)); }
      catch (error) { console.warn(`Hyde could not register font ${asset.name}:`, error); }
      changed = true;
    }
    await Promise.all([...this.retained.values()].map(font => font.ready));
    return changed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const font of this.retained.values()) release(font);
    this.retained.clear();
  }
}
