import {describe, expect, it} from 'vitest';
import {CURATED_FONTS, curatedFontAsset} from './curatedFonts';

describe('offline Google Fonts catalog', () => {
  it('provides unique, embedded WOFF2 files and complete license notices', () => {
    expect(CURATED_FONTS.map(font => font.label)).toEqual(['Inter', 'DM Sans', 'Space Grotesk']);
    const names = new Set<string>();
    for (const font of CURATED_FONTS) {
      const asset = curatedFontAsset(font.id);
      expect(asset.kind).toBe('font');
      expect(asset.mime).toBe('font/woff2');
      expect(asset.dataUrl).toMatch(/^data:.*;base64,/);
      const bytes = Buffer.from(asset.dataUrl.slice(asset.dataUrl.indexOf(',') + 1), 'base64');
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('wOF2');
      expect(asset.licenseNotice).toContain('SIL OPEN FONT LICENSE Version 1.1');
      expect(asset.licenseNotice).toContain('Copyright');
      names.add(asset.name);
    }
    expect(names.size).toBe(CURATED_FONTS.length);
  });

  it('returns ordinary asset metadata without attaching a project-specific ID', () => {
    const asset = curatedFontAsset('inter');
    expect(asset).not.toHaveProperty('id');
    expect(asset.name).toBe('Inter (Google Fonts).woff2');
  });
});
