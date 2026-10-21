import type {AnimProperty, AssemblyGapTransition, Project} from './model';
import {selectAssemblyClipGapSegments} from './assemblyClips';
import {groupAssemblyGapSegments} from './assemblyGapView';
import type {AssemblyGapGroup} from './assemblyGapView';

const EASING: AssemblyGapTransition['easing'][] = ['linear','sine','quad','cubic','quart','quint','expo','circ','back','bounce','elastic'];
const LABELS: Record<AnimProperty,string> = {x:'Position X',y:'Position Y',rotation:'Rotation',scaleX:'Scale X',scaleY:'Scale Y',opacity:'Opacity',fill:'Fill',volume:'Volume',assetId:'Texture'};
type Patch = Partial<Pick<AssemblyGapTransition,'mode'|'easing'|'direction'|'switchPoint'>> | null;

export function AssemblyGapBands({groups,duration,focusedIncomingId,onSelect}:{groups:readonly AssemblyGapGroup[];duration:number;focusedIncomingId:string|null;onSelect:(group:AssemblyGapGroup)=>void}){
  return <>{groups.map(group=>{
    const hold=group.segments.every(segment=>segment.mode==='hold');
    const mixed=group.segments.some(segment=>segment.mode==='hold')&&!hold;
    const label=hold?'Hold':mixed?'Mixed':'Tween';
    return <button type="button" key={group.id} className={`assembly-gap-band ${focusedIncomingId===group.toInstanceId?'selected':''}`} style={{left:`${group.start/duration*100}%`,width:`${(group.end-group.start)/duration*100}%`}} aria-label={`${label} transition from ${group.start.toFixed(2)} to ${group.end.toFixed(2)} seconds`} title={`${label} · select to edit each part and property`} onClick={event=>{event.stopPropagation();onSelect(group);}}>{label}</button>;
  })}</>;
}

export function AssemblyGapPanel({project,rootId,focusedIncomingId,onFocus,onEdit}:{
  project:Project; rootId:string; focusedIncomingId:string|null; onFocus:(id:string|null)=>void;
  onEdit:(rootId:string,toInstanceId:string,elementId:string,property:AnimProperty,patch:Patch)=>void;
}) {
  const root=project.elements.find(element=>element.id===rootId);
  const groups=groupAssemblyGapSegments(selectAssemblyClipGapSegments(project,{rootId}));
  if(!root?.clipInstances?.length || !groups.length)return null;
  const hasFocus=!!focusedIncomingId&&groups.some(group=>group.toInstanceId===focusedIncomingId);
  const visible=hasFocus?groups.filter(group=>group.toInstanceId===focusedIncomingId):groups;
  return <section className="inspector-section assembly-gap-panel" aria-label="Assembly transitions">
    <div className="assembly-gap-heading"><h3>Between clips</h3>{hasFocus&&<button className="text-action" onClick={()=>onFocus(null)}>Show all</button>}</div>
    <p className="muted-note">A gap tweens automatically to the next clip. Set Hold to keep the previous pose until that clip starts.</p>
    {visible.map(group=>{
      const from=root.assemblyClips?.find(clip=>clip.id===root.clipInstances?.find(item=>item.id===group.fromInstanceId)?.clipId)?.name??'Clip';
      const to=root.assemblyClips?.find(clip=>clip.id===root.clipInstances?.find(item=>item.id===group.toInstanceId)?.clipId)?.name??'Clip';
      return <div className="assembly-gap-group" key={group.id}>
        <div className="assembly-gap-title"><strong>{from} → {to}</strong><small>{group.start.toFixed(2)}–{group.end.toFixed(2)} s</small></div>
        {group.segments.map(segment=>{
          const override=root.clipInstances?.find(item=>item.id===segment.toInstanceId)?.gapTransitions?.find(item=>item.elementId===segment.sourceElementId&&item.property===segment.property);
          const part=project.elements.find(element=>element.id===segment.sourceElementId)?.name??'Part';
          const apply=(patch:Patch)=>onEdit(rootId,segment.toInstanceId,segment.sourceElementId,segment.property,patch);
          return <div className="assembly-gap-property" key={segment.id}>
            <div className="assembly-gap-property-title"><span>{part} · {LABELS[segment.property]}</span><small>{override?'Custom':'Automatic'}</small></div>
            <div className="assembly-gap-controls"><select aria-label={`${part} ${LABELS[segment.property]} transition mode`} value={segment.mode} onChange={event=>apply({mode:event.target.value as AssemblyGapTransition['mode']})}><option value="tween">{segment.property==='assetId'?'Switch':'Tween'}</option><option value="hold">Hold</option></select>{segment.mode==='tween'&&(segment.property==='assetId'?<label>Switch at %<input aria-label={`${part} texture gap switch point percent`} type="number" min={0} max={100} step="any" value={Math.round(segment.switchPoint*100)} onChange={event=>{const value=Number(event.target.value);if(value>=0&&value<=100)apply({switchPoint:value/100});}}/></label>:<><select aria-label={`${part} ${LABELS[segment.property]} transition easing`} value={segment.easing} onChange={event=>apply({easing:event.target.value as AssemblyGapTransition['easing']})}>{EASING.map(family=><option key={family} value={family}>{family}</option>)}</select><select aria-label={`${part} ${LABELS[segment.property]} transition direction`} value={segment.direction} onChange={event=>apply({direction:event.target.value as AssemblyGapTransition['direction']})}><option value="in">In</option><option value="out">Out</option><option value="inOut">In-out</option></select></>)}{override&&<button className="text-action" aria-label={`Reset ${part} ${LABELS[segment.property]} transition`} onClick={()=>apply(null)}>Reset</button>}</div>
          </div>;
        })}
      </div>;
    })}
  </section>;
}
