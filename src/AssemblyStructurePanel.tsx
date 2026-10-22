import {useEffect,useState} from 'react';
import type {Project,StoryElement} from './model';
import {descendantIds,parentId} from './editing';

function LimitField({label,value,onChange}:{label:string;value:number;onChange:(value:number)=>void}){
  const [draft,setDraft]=useState(String(value));
  useEffect(()=>setDraft(String(value)),[value]);
  return <label className="number-field"><span>{label}</span><input aria-label={`${label} attachment limit`} type="number" step="any" value={draft} onChange={event=>setDraft(event.target.value)} onBlur={()=>{const number=Number(draft);if(draft.trim()&&Number.isFinite(number))onChange(number);else setDraft(String(value));}} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur();if(event.key==='Escape'){setDraft(String(value));event.currentTarget.blur();}}}/></label>;
}

export function AssemblyStructurePanel({project,elementId,onReparent,onChange}:{project:Project;elementId:string;onReparent:(parentId:string|undefined)=>void;onChange:(patch:Partial<StoryElement>)=>void}){
  const element=project.elements.find(item=>item.id===elementId);
  if(!element)return null;
  const parent=parentId(element),excluded=descendantIds(project,[element.id]);
  const attachment=element.attachment;
  return <section className="inspector-section assembly-structure-panel" aria-label="Assembly attachment">
    <h3>Parent and attachment</h3>
    <label className="select-label">Parent<select aria-label="Parent assembly" value={parent??''} onChange={event=>onReparent(event.target.value||undefined)}><option value="">None (world)</option>{project.elements.filter(item=>!excluded.has(item.id)&&item.kind!=='audio').map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {parent&&<><label className="select-label">Attachment type<select aria-label="Attachment type" value={attachment?.type??'hinge'} onChange={event=>onChange({attachment:{...attachment,parentId:parent,type:event.target.value as 'fixed'|'hinge'|'slider'}})}><option value="hinge">Hinge</option><option value="fixed">Fixed</option><option value="slider">Slider</option></select></label><div className="field-pair"><LimitField label="Min" value={attachment?.min??-180} onChange={min=>onChange({attachment:{parentId:parent,type:attachment?.type??'hinge',...attachment,min}})}/><LimitField label="Max" value={attachment?.max??180} onChange={max=>onChange({attachment:{parentId:parent,type:attachment?.type??'hinge',...attachment,max}})}/></div><p className="muted-note">Limits constrain hinge rotation or slider travel. Fixed attachments retain the parent pose.</p></>}
  </section>;
}
