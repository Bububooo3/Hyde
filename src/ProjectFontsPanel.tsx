import {useEffect,useState} from 'react';
import {FileUp,Type} from 'lucide-react';
import type {Asset,Project} from './model';
import {fontFamilyForAsset} from './projectFonts';

function Notice({asset,onCommit}:{asset:Asset;onCommit:(notice:string)=>void}){
  const saved=asset.licenseNotice??'';
  const [draft,setDraft]=useState(saved);
  useEffect(()=>setDraft(saved),[saved,asset.id]);
  return <label className="font-notice-label">License / attribution notice<textarea aria-label={`License notice for ${asset.name}`} value={draft} placeholder="Paste the font's required notice here, if any." onChange={event=>setDraft(event.target.value)} onBlur={()=>{if(draft!==saved)onCommit(draft);}}/></label>;
}

export function ProjectFontsPanel({project,selectedFamily,onImport,onUse,onNotice}:{project:Project;selectedFamily:string|undefined;onImport:()=>void;onUse:(family:string)=>void;onNotice:(assetId:string,notice:string)=>void}){
  const fonts=project.assets.filter(asset=>asset.kind==='font');
  return <section className="inspector-section project-fonts-panel"><h3>Project fonts</h3><button className="secondary full" onClick={onImport}><FileUp size={13}/>Import font file</button><p className="muted-note">WOFF2, WOFF, TTF, or OTF. Imported fonts travel with the project and exported story.</p>
    {fonts.map(asset=>{const family=fontFamilyForAsset(asset);return <div className="project-font-entry" key={asset.id}><div className="project-font-heading"><Type size={13}/><span>{asset.name}</span><button className="secondary" disabled={selectedFamily===family} onClick={()=>onUse(family)}>{selectedFamily===family?'Using':'Use'}</button></div><Notice asset={asset} onCommit={notice=>onNotice(asset.id,notice)}/></div>;})}
  </section>;
}
