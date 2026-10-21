import type {Keyframe,Project} from './model';

export function TextureKeyPanel({project,keyframe,hasNext,onEdit}:{project:Project;keyframe:Keyframe;hasNext:boolean;onEdit:(patch:Partial<Pick<Keyframe,'value'|'switchPoint'>>)=>void}){
  return <section className="inspector-section texture-key-panel" aria-label="Texture keyframe">
    <h3>Texture key</h3>
    <label className="select-label">Texture
      <select aria-label="Texture key value" value={String(keyframe.value)} onChange={event=>onEdit({value:event.target.value})}>
        <option value="">Solid color</option>
        {project.assets.filter(asset=>asset.kind==='image'||asset.kind==='video').map(asset=><option key={asset.id} value={asset.id}>{asset.name}</option>)}
      </select>
    </label>
    {hasNext&&<label className="number-field"><span>Switch to next key at %</span><input aria-label="Texture key switch point percent" type="number" min={0} max={100} step="any" value={Math.round((keyframe.switchPoint??.5)*100)} onChange={event=>{const value=Number(event.target.value);if(value>=0&&value<=100)onEdit({switchPoint:value/100});}}/></label>}
  </section>;
}
