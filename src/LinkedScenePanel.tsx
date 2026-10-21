import {Copy,Link2,Settings2} from 'lucide-react';
import type {Project,Sequence} from './model';

type Frame=NonNullable<Sequence['frame']>;
type Patch=Partial<Pick<Sequence,'sourceIn'|'sourceOut'|'muted'|'frame'|'frameFit'|'frameRotation'|'opacity'>>;

export function LinkedScenePanel({project,scene,onEdit,onEditSource,onIndependent,onDuration}: {
  project:Project;scene:Sequence;onEdit:(patch:Patch)=>void;onEditSource:()=>void;
  onIndependent:()=>void;onDuration:()=>void;
}) {
  const source=project.sequences.find(item=>item.id===scene.sourceSceneId);
  if(!source)return null;
  const width=project.width,height=project.height;
  const frame=scene.frame??{x:0,y:0,width,height};
  const presets:[string,Frame|undefined][]=[
    ['Full stage',undefined],
    ['Picture in picture',{x:width*.66,y:height*.66,width:width*.3,height:height*.3}],
    ['Left half',{x:0,y:0,width:width/2,height}],
    ['Right half',{x:width/2,y:0,width:width/2,height}],
    ['Grid top left',{x:0,y:0,width:width/2,height:height/2}],
    ['Grid top right',{x:width/2,y:0,width:width/2,height:height/2}],
    ['Grid bottom left',{x:0,y:height/2,width:width/2,height:height/2}],
    ['Grid bottom right',{x:width/2,y:height/2,width:width/2,height:height/2}],
  ];
  const field=(label:string,value:number,onChange:(value:number)=>void,min=-Infinity,max=Infinity)=><label className="number-field" key={label}><span>{label}</span><input aria-label={label} type="number" value={Number(value.toFixed(2))} step={1} min={Number.isFinite(min)?min:undefined} max={Number.isFinite(max)?max:undefined} onChange={event=>{if(event.target.value==='')return;const next=Number(event.target.value);if(Number.isFinite(next))onChange(Math.max(min,Math.min(max,next)));}}/></label>;
  return <section className="inspector-section linked-scene-panel">
    <h3>Linked scene</h3>
    <p className="muted-note">This placement follows changes to {source.name}.</p>
    <div className="field-pair">
      {field('Source in s',scene.sourceIn??0,value=>onEdit({sourceIn:value}),0,source.duration)}
      {field('Source out s',scene.sourceOut??source.duration,value=>onEdit({sourceOut:value}),0,source.duration)}
    </div>
    <label className="check-row"><input type="checkbox" checked={!!scene.muted} onChange={event=>onEdit({muted:event.target.checked})}/>Mute this placement’s audio</label>
    <h4>Placement frame</h4>
    <div className="placement-presets">{presets.map(([label,preset])=><button key={label} type="button" onClick={()=>onEdit({frame:preset,frameRotation:0})}>{label}</button>)}</div>
    <label className="select-label">Frame fitting<select aria-label="Frame fitting" value={scene.frameFit??'fit'} onChange={event=>onEdit({frameFit:event.target.value as NonNullable<Sequence['frameFit']>})}><option value="fit">Fit whole scene</option><option value="fill">Fill and crop</option><option value="stretch">Stretch</option></select></label>
    <div className="field-pair">{field('Frame X',frame.x,value=>onEdit({frame:{...frame,x:value}}))}{field('Frame Y',frame.y,value=>onEdit({frame:{...frame,y:value}}))}</div>
    <div className="field-pair">{field('Frame width',frame.width,value=>onEdit({frame:{...frame,width:value}}),1)}{field('Frame height',frame.height,value=>onEdit({frame:{...frame,height:value}}),1)}</div>
    {field('Frame rotation °',scene.frameRotation??0,value=>onEdit({frame:scene.frame??{x:0,y:0,width,height},frameRotation:value}))}
    {field('Placement opacity %',Math.round((scene.opacity??1)*100),value=>onEdit({opacity:value/100}),0,100)}
    <button className="text-action" onClick={onDuration}><Settings2 size={13}/>Set placement duration</button>
    <button className="text-action" onClick={onEditSource}><Link2 size={13}/>Edit source scene</button>
    <button className="text-action" onClick={onIndependent}><Copy size={13}/>Make independent copy</button>
  </section>;
}
