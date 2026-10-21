import {useEffect,useRef,useState} from 'react';
import type {AnimProperty,Project} from './model';
import {assemblyTrackView,type AssemblyKeyPatch,type AssemblyTrackTarget} from './assemblyClipEditing';

const LABELS:Record<AnimProperty,string>={x:'Position X',y:'Position Y',rotation:'Rotation',scaleX:'Scale X',scaleY:'Scale Y',opacity:'Opacity',fill:'Fill',volume:'Volume',assetId:'Texture'};
const FAMILIES=['linear','sine','quad','cubic','quart','quint','expo','circ','back','bounce','elastic'] as const;

function DraftNumber({label,value,onCommit}:{label:string;value:number;onCommit:(value:number)=>boolean}){
  const [draft,setDraft]=useState(String(Number(value.toFixed(4))));
  const cancelled=useRef(false);
  useEffect(()=>setDraft(String(Number(value.toFixed(4)))),[value]);
  const commit=()=>{const parsed=Number(draft);if(!draft.trim()||!Number.isFinite(parsed)||!onCommit(parsed))setDraft(String(Number(value.toFixed(4))));};
  return <label className="assembly-key-number"><span>{label}</span><input aria-label={label} type="number" step="any" value={draft} onChange={event=>setDraft(event.target.value)} onBlur={()=>{if(cancelled.current){cancelled.current=false;setDraft(String(Number(value.toFixed(4))));}else commit();}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}else if(event.key==='Escape'){event.preventDefault();cancelled.current=true;event.currentTarget.blur();}}}/></label>;
}

function DraftColor({label,value,onCommit}:{label:string;value:string;onCommit:(value:string)=>boolean}){
  const [draft,setDraft]=useState(value),cancelled=useRef(false);
  useEffect(()=>setDraft(value),[value]);
  return <label className="assembly-key-number"><span>{label}</span><span className="assembly-key-color"><input aria-label={label} type="text" value={draft} onChange={event=>setDraft(event.target.value)} onBlur={()=>{if(cancelled.current){cancelled.current=false;setDraft(value);}else if(draft!==value&&!onCommit(draft))setDraft(value);}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}else if(event.key==='Escape'){event.preventDefault();cancelled.current=true;event.currentTarget.blur();}}}/>{/^#[0-9a-f]{6}$/i.test(value)&&<input aria-label={`${label} picker`} type="color" value={value} onChange={event=>onCommit(event.target.value)}/>}</span></label>;
}

export function AssemblyClipEditorPanel({project,rootId,selectedInstanceId,focusedTrack,onSelect,time,onEditKey,onAddKey,onRemoveKey,onReset}:{
  project:Project;rootId:string;selectedInstanceId:string|null;focusedTrack:{rootId:string;elementId:string;property:AnimProperty;scope:'shared'|'instance';keyIndex:number}|null;onSelect:(id:string)=>void;time:number;
  onEditKey:(target:AssemblyTrackTarget,index:number,patch:AssemblyKeyPatch)=>boolean;
  onAddKey:(target:AssemblyTrackTarget,time:number)=>void;
  onRemoveKey:(target:AssemblyTrackTarget,index:number)=>void;
  onReset:(target:AssemblyTrackTarget)=>void;
}){
  const root=project.elements.find(item=>item.id===rootId),instances=root?.clipInstances??[];
  const [scope,setScope]=useState<'instance'|'shared'>('instance');
  const [trackName,setTrackName]=useState('');
  useEffect(()=>{if(focusedTrack?.rootId===rootId){setTrackName(JSON.stringify([focusedTrack.elementId,focusedTrack.property]));setScope(focusedTrack.scope);}},[focusedTrack,rootId]);
  if(!instances.length)return null;
  const instance=instances.find(item=>item.id===selectedInstanceId)??instances[0];
  const clip=root?.assemblyClips?.find(item=>item.id===instance.clipId);
  if(!clip)return null;
  const chosen=clip.tracks.find(track=>JSON.stringify([track.elementId,track.property])===trackName)??clip.tracks[0];
  if(!chosen)return null;
  const target:AssemblyTrackTarget={rootId,clipId:clip.id,elementId:chosen.elementId,property:chosen.property,...(scope==='instance'?{instanceId:instance.id}:{})};
  const view=assemblyTrackView(project,target);
  const at=(time-root!.start-instance.start)/instance.duration*clip.duration;
  const canAdd=at>=0&&at<=clip.duration;
  return <section className="inspector-section assembly-clip-editor" aria-label="Assembly clip keys">
    <h3>Clip keys</h3>
    <label className="select-label">Placed clip<select aria-label="Placed clip to edit" value={instance.id} onChange={event=>onSelect(event.target.value)}>{instances.map(item=><option value={item.id} key={item.id}>{root?.assemblyClips?.find(source=>source.id===item.clipId)?.name??'Clip'} · {(root!.start+item.start).toFixed(2)} s</option>)}</select></label>
    <div className="assembly-key-scope" role="group" aria-label="Clip editing scope"><button className={scope==='instance'?'active':''} aria-pressed={scope==='instance'} onClick={()=>setScope('instance')}>This placement</button><button className={scope==='shared'?'active':''} aria-pressed={scope==='shared'} onClick={()=>setScope('shared')}>Shared source</button></div>
    <p className="muted-note">{scope==='shared'?'Changes to the source update every placement that has no local edit.':'Changes here affect only this placed clip.'}</p>
    <label className="select-label">Part and property<select aria-label="Assembly clip track" value={JSON.stringify([chosen.elementId,chosen.property])} onChange={event=>setTrackName(event.target.value)}>{clip.tracks.map(track=><option value={JSON.stringify([track.elementId,track.property])} key={`${track.elementId}:${track.property}`}>{project.elements.find(part=>part.id===track.elementId)?.name??'Part'} · {LABELS[track.property]}</option>)}</select></label>
    {scope==='instance'&&view.isOverride&&<button className="text-action" onClick={()=>onReset(target)}>Reset this property to shared source</button>}
    <div className="assembly-key-list">{view.track.keyframes.map((key,index)=><div className={`assembly-key-card ${focusedTrack?.rootId===rootId&&focusedTrack.elementId===chosen.elementId&&focusedTrack.property===chosen.property&&focusedTrack.scope===scope&&focusedTrack.keyIndex===index?'selected':''}`} key={key.id}>
      <div className="assembly-key-card-head"><strong>Key {index+1}</strong><button className="text-action danger" aria-label={`Remove assembly key ${index+1}`} disabled={view.track.keyframes.length<=1} onClick={()=>onRemoveKey(target,index)}>Remove</button></div>
      <div className="field-pair"><DraftNumber label={`Assembly key ${index+1} time`} value={key.time} onCommit={value=>onEditKey(target,index,{time:value})}/>{chosen.property==='assetId'?<label className="select-label">Texture<select aria-label={`Assembly key ${index+1} texture`} value={String(key.value)} onChange={event=>onEditKey(target,index,{value:event.target.value})}><option value="">Solid color</option>{project.assets.filter(asset=>asset.kind==='image'||asset.kind==='video').map(asset=><option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>:chosen.property==='fill'?<DraftColor label={`Assembly key ${index+1} fill`} value={String(key.value)} onCommit={value=>onEditKey(target,index,{value})}/>:<DraftNumber label={`Assembly key ${index+1} value`} value={Number(key.value)} onCommit={value=>onEditKey(target,index,{value})}/>}</div>
      <div className="assembly-key-options"><select aria-label={`Assembly key ${index+1} interpolation`} value={key.mode} onChange={event=>onEditKey(target,index,{mode:event.target.value as AssemblyKeyPatch['mode']})}><option value="smooth">Smooth</option><option value="hold">Hold</option><option value="stepped">Stepped</option></select>{chosen.property==='assetId'?index<view.track.keyframes.length-1&&<DraftNumber label={`Assembly key ${index+1} switch at %`} value={(key.switchPoint??.5)*100} onCommit={value=>onEditKey(target,index,{switchPoint:value/100})}/>:<><select aria-label={`Assembly key ${index+1} easing`} value={key.easing} onChange={event=>onEditKey(target,index,{easing:event.target.value as AssemblyKeyPatch['easing']})}>{FAMILIES.map(family=><option value={family} key={family}>{family}</option>)}</select><select aria-label={`Assembly key ${index+1} direction`} value={key.direction} onChange={event=>onEditKey(target,index,{direction:event.target.value as AssemblyKeyPatch['direction']})}><option value="in">In</option><option value="out">Out</option><option value="inOut">In-out</option></select></>}</div>
    </div>)}</div>
    <button className="secondary full" disabled={!canAdd} onClick={()=>onAddKey(target,at)}>Add key at playhead</button>
  </section>;
}
