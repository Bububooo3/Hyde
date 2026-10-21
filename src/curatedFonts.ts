import interDataUrl from '@fontsource/inter/files/inter-latin-400-normal.woff2?inline';
import dmSansDataUrl from '@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff2?inline';
import spaceGroteskDataUrl from '@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff2?inline';
import playfairDisplayDataUrl from '@fontsource/playfair-display/files/playfair-display-latin-400-normal.woff2?inline';
import oswaldDataUrl from '@fontsource/oswald/files/oswald-latin-400-normal.woff2?inline';
import caveatDataUrl from '@fontsource/caveat/files/caveat-latin-400-normal.woff2?inline';
import loraDataUrl from '@fontsource/lora/files/lora-latin-400-normal.woff2?inline';
import interLicense from '@fontsource/inter/LICENSE?raw';
import dmSansLicense from '@fontsource/dm-sans/LICENSE?raw';
import spaceGroteskLicense from '@fontsource/space-grotesk/LICENSE?raw';
import playfairDisplayLicense from '@fontsource/playfair-display/LICENSE?raw';
import oswaldLicense from '@fontsource/oswald/LICENSE?raw';
import caveatLicense from '@fontsource/caveat/LICENSE?raw';
import loraLicense from '@fontsource/lora/LICENSE?raw';
export type CuratedFontId = 'inter' | 'dm-sans' | 'space-grotesk' | 'playfair-display' | 'oswald' | 'caveat' | 'lora';
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
  category: 'Sans serif' | 'Serif' | 'Display' | 'Handwriting';
}

export const CURATED_FONTS: readonly CuratedFont[] = [
  {id: 'inter', label: 'Inter', previewFamily: 'Inter', sample: 'Every scene begins somewhere.',category:'Sans serif'},
  {id: 'dm-sans', label: 'DM Sans', previewFamily: 'DM Sans', sample: 'Every scene begins somewhere.',category:'Sans serif'},
  {id: 'space-grotesk', label: 'Space Grotesk', previewFamily: 'Space Grotesk', sample: 'Every scene begins somewhere.',category:'Display'},
  {id: 'playfair-display',label:'Playfair Display',previewFamily:'Playfair Display',sample:'A story worth telling.',category:'Serif'},
  {id: 'oswald',label:'Oswald',previewFamily:'Oswald',sample:'A BOLD NEW CHAPTER',category:'Display'},
  {id: 'caveat',label:'Caveat',previewFamily:'Caveat',sample:'Notes from the journey',category:'Handwriting'},
  {id: 'lora',label:'Lora',previewFamily:'Lora',sample:'The story continues here.',category:'Serif'},
];

const sources: Record<CuratedFontId, {dataUrl: string; license: string}> = {
  inter: {dataUrl: interDataUrl, license: interLicense},
  'dm-sans': {dataUrl: dmSansDataUrl, license: dmSansLicense},
  'space-grotesk': {dataUrl: spaceGroteskDataUrl, license: spaceGroteskLicense},
  'playfair-display':{dataUrl:playfairDisplayDataUrl,license:playfairDisplayLicense},
  oswald:{dataUrl:oswaldDataUrl,license:oswaldLicense},
  caveat:{dataUrl:caveatDataUrl,license:caveatLicense},
  lora:{dataUrl:loraDataUrl,license:loraLicense},
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
