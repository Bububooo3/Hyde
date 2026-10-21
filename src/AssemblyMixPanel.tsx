import type {AnimProperty,AssemblyTextureOverlap,Project} from './model';
import {DEFAULT_TEXTURE_CONFLICT} from './textureConflict';

const LABELS:Record<AnimProperty,string>={x:'Position X',y:'Position Y',rotation:'Rotation',scaleX:'Scale X',scaleY:'Scale Y',opacity:'Opacity',fill:'Fill',volume:'Volume',assetId:'Texture'};

export function AssemblyMixPanel({project,rootId,selectedInstanceId,onSelect,onEdit,onTextureEdit}:{project:Project;rootId:string;selectedInstanceId:string|null;onSelect:(id:string)=>void;onEdit:(rootId:string,instanceId:string,elementId:string,property:AnimProperty,priority:number)=>void;onTextureEdit:(rootId:string,instanceId:string,elementId:string,patch:Partial<Omit<AssemblyTextureOverlap,'elementId'>>|null)=>void}){
  const root=project.elements.find(element=>element.id===rootId);
  const instances=root?.clipInstances??[];
  if(instances.length<2)return null;
  const selected=instances.find(item=>item.id===selectedInstanceId)??instances[0];
  const clip=root?.assemblyClips?.find(item=>item.id===selected.clipId);
  if(!clip)return null;
  const overlapping=instances.filter(item=>item.id!==selected.id&&item.start<selected.start+selected.duration&&selected.start<item.start+item.duration);
  const conflictKeys=new Set(overlapping.flatMap(item=>root?.assemblyClips?.find(clip=>clip.id===item.clipId)?.tracks.map(track=>`${track.elementId}\u0000${track.property}`)??[]));
  const conflicts=clip.tracks.filter(track=>conflictKeys.has(`${track.elementId}\u0000${track.property}`));
  return <section className="inspector-section assembly-mix-panel" aria-label="Assembly overlap priority">
    <h3>Clip overlap</h3>
    <label className="select-label">Placed clip<select aria-label="Placed clip to mix" value={selected.id} onChange={event=>onSelect(event.target.value)}>{instances.map(item=><option value={item.id} key={item.id}>{root?.assemblyClips?.find(source=>source.id===item.clipId)?.name??'Clip'} · {(root!.start+item.start).toFixed(2)} s</option>)}</select></label>
    {!conflicts.length?<p className="muted-note">This clip does not overlap another clip on the same part and property.</p>:<><p className="muted-note">Automatic blends overlapping clips. A priority from 1–10 makes this clip win on that property while both are active. Equal priorities use the later clip.</p>{conflicts.map(track=>{
      const part=project.elements.find(item=>item.id===track.elementId)?.name??'Part';
      const priority=selected.priorityOverrides?.find(item=>item.elementId===track.elementId&&item.property===track.property)?.priority??0;
      const hasEarlier=overlapping.some(item=>
        (item.start<selected.start||item.start===selected.start&&instances.indexOf(item)<instances.indexOf(selected))&&
        root?.assemblyClips?.find(source=>source.id===item.clipId)?.tracks.some(other=>other.elementId===track.elementId&&other.property==='assetId'),
      );
      const texture=selected.textureOverlaps?.find(item=>item.elementId===track.elementId);
      const setting=texture??DEFAULT_TEXTURE_CONFLICT;
      return <div className="assembly-mix-property" key={`${track.elementId}:${track.property}`}>
        <label className="assembly-priority-row"><span>{part} · {LABELS[track.property]}</span><select aria-label={`${part} ${LABELS[track.property]} overlap priority`} value={priority} onChange={event=>onEdit(rootId,selected.id,track.elementId,track.property,Number(event.target.value))}><option value={0}>Auto</option>{Array.from({length:10},(_,index)=><option key={index+1} value={index+1}>{index+1}</option>)}</select></label>
        {track.property==='assetId'&&hasEarlier&&<div className="assembly-texture-overlap">
          <label>Texture switch<select aria-label={`${part} texture overlap mode`} value={texture?.mode??'default'} onChange={event=>onTextureEdit(rootId,selected.id,track.elementId,event.target.value==='default'?null:{mode:event.target.value as AssemblyTextureOverlap['mode']})}>
            <option value="default">Alternate (4/s) · default</option><option value="alternate">Alternate · custom</option><option value="single">Switch once</option><option value="holdOutgoing">Hold outgoing</option><option value="useIncoming">Use incoming</option>
          </select></label>
          {setting.mode==='alternate'&&<label>Switches / second<input aria-label={`${part} texture switches per second`} type="number" min={.1} max={60} step="any" value={setting.switchesPerSecond} onChange={event=>{const value=Number(event.target.value);if(value>0&&value<=60)onTextureEdit(rootId,selected.id,track.elementId,{mode:'alternate',switchesPerSecond:value});}}/></label>}
          {setting.mode==='single'&&<label>Switch at %<input aria-label={`${part} texture switch point percent`} type="number" min={0} max={100} step="any" value={Math.round(setting.switchPoint*100)} onChange={event=>{const value=Number(event.target.value);if(value>=0&&value<=100)onTextureEdit(rootId,selected.id,track.elementId,{mode:'single',switchPoint:value/100});}}/></label>}
        </div>}
      </div>;
    })}</>}
  </section>;
}
