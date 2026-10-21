import interDataUrl from '@fontsource/inter/files/inter-latin-400-normal.woff2?inline';
import dmSansDataUrl from '@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff2?inline';
import spaceGroteskDataUrl from '@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff2?inline';
import interLicense from '@fontsource/inter/LICENSE?raw';
import dmSansLicense from '@fontsource/dm-sans/LICENSE?raw';
import spaceGroteskLicense from '@fontsource/space-grotesk/LICENSE?raw';
export type CuratedFontId = 'inter' | 'dm-sans' | 'space-grotesk';
export interface CuratedFontAsset {
  name: string;
  mime: 'font/woff2';
  kind: 'font';
  dataUrl: string;
  licenseNotice: string;
}

export interface CuratedFont {
  id: CuratedFontId;
  label: string;
  previewFamily: string;
  sample: string;
}

export const CURATED_FONTS: readonly CuratedFont[] = [
  {id: 'inter', label: 'Inter', previewFamily: 'Inter', sample: 'Every scene begins somewhere.'},
  {id: 'dm-sans', label: 'DM Sans', previewFamily: 'DM Sans', sample: 'Every scene begins somewhere.'},
  {id: 'space-grotesk', label: 'Space Grotesk', previewFamily: 'Space Grotesk', sample: 'Every scene begins somewhere.'},
];

const sources: Record<CuratedFontId, {dataUrl: string; license: string}> = {
  inter: {dataUrl: interDataUrl, license: interLicense},
  'dm-sans': {dataUrl: dmSansDataUrl, license: dmSansLicense},
  'space-grotesk': {dataUrl: spaceGroteskDataUrl, license: spaceGroteskLicense},
};

/** Returns an ordinary embedded project asset; the caller assigns its unique ID/name. */
export function curatedFontAsset(id: CuratedFontId): CuratedFontAsset {
  const font = CURATED_FONTS.find(item => item.id === id);
  if (!font) throw new Error(`Unknown curated font: ${id}`);
  const source = sources[id];
  return {
    name: `${font.label} (Google Fonts).woff2`,
    kind: 'font',
    mime: 'font/woff2',
    dataUrl: source.dataUrl,
    licenseNotice: source.license,
  };
}
