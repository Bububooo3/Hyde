import '@fontsource/inter/latin-400.css';
import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/space-grotesk/latin-400.css';
import {Type} from 'lucide-react';
import type {Asset} from './model';
import {CURATED_FONTS, curatedFontAsset, type CuratedFontAsset} from './curatedFonts';

interface Props {
  projectFonts: readonly Asset[];
  onImport: (asset: CuratedFontAsset) => void;
}

/** The catalog and its WOFF2 files ship with the editor; choosing one embeds it in the project. */
export function GoogleFontsPanel({projectFonts, onImport}: Props) {
  return <section className="inspector-section google-fonts-panel" aria-label="Google Fonts">
    <h3>Google Fonts</h3>
    <p className="muted-note">Choose a bundled font. It works offline and travels with the project and exported story.</p>
    {CURATED_FONTS.map(font => {
      const asset = curatedFontAsset(font.id);
      const alreadyAdded = projectFonts.some(item => item.kind === 'font' && item.dataUrl === asset.dataUrl);
      return <div className="project-font-entry" key={font.id}>
        <div className="project-font-heading">
          <Type size={13}/><span>{font.label}</span>
          <button type="button" className="secondary" aria-label={`${alreadyAdded ? 'Added' : 'Add'} ${font.label} font`} disabled={alreadyAdded} onClick={() => onImport(asset)}>{alreadyAdded ? 'Added' : 'Add'}</button>
        </div>
        <div style={{fontFamily: `'${font.previewFamily}', sans-serif`, fontSize: '1.15rem', lineHeight: 1.3}}>{font.sample}</div>
      </div>;
    })}
  </section>;
}
