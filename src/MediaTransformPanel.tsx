import type {MediaTransform} from './mediaTransform';
import {DEFAULT_MEDIA_TRANSFORM} from './mediaTransform';

function Field({label,value,min,max,onChange}:{label:string;value:number;min:number;max:number;onChange:(value:number)=>void}){
  return <label className="number-field"><span>{label}</span><input type="number" aria-label={label} step="any" min={min} max={max} value={value} onChange={event=>{if(event.target.value==='')return;const parsed=Number(event.target.value);if(Number.isFinite(parsed))onChange(Math.min(max,Math.max(min,parsed)));}}/></label>;
}

export function MediaTransformPanel({value,onChange}:{value:MediaTransform|undefined;onChange:(next:MediaTransform|undefined)=>void}){
  const transform=value??DEFAULT_MEDIA_TRANSFORM;
  const edit=(patch:Partial<MediaTransform>)=>onChange({...transform,...patch});
  return <section className="inspector-section media-transform-panel"><h3>Texture placement</h3><p className="muted-note">Move, scale, or turn the media inside this shape. The shape and its mask stay in place.</p>
    <div className="field-pair"><Field label="Offset X px" value={transform.x} min={-100000} max={100000} onChange={x=>edit({x})}/><Field label="Offset Y px" value={transform.y} min={-100000} max={100000} onChange={y=>edit({y})}/></div>
    <div className="field-pair"><Field label="Texture scale X" value={transform.scaleX} min={.001} max={100} onChange={scaleX=>edit({scaleX})}/><Field label="Texture scale Y" value={transform.scaleY} min={.001} max={100} onChange={scaleY=>edit({scaleY})}/></div>
    <Field label="Texture rotation °" value={transform.rotation} min={-36000} max={36000} onChange={rotation=>edit({rotation})}/>
    <button className="text-action" onClick={()=>onChange(undefined)}>Reset texture placement</button>
  </section>;
}
