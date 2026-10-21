import {useMemo,useState} from 'react';
import type {PointerEvent} from 'react';
import {ChevronDown,ChevronRight,GitBranch} from 'lucide-react';
import type {AnimProperty,Project} from './model';
import {selectAssemblyMasterRows,type AssemblyMasterKey} from './assemblyMaster';

const LABELS:Record<AnimProperty,string>={x:'Position X',y:'Position Y',rotation:'Rotation',scaleX:'Scale X',scaleY:'Scale Y',opacity:'Opacity',fill:'Fill',volume:'Volume',assetId:'Texture'};

type PointerHandlers={onKeyPointerDown:(event:PointerEvent<HTMLButtonElement>,key:AssemblyMasterKey)=>void;onKeyPointerMove:(event:PointerEvent<HTMLButtonElement>)=>void;onKeyPointerUp:()=>void};

function MasterBody({project,rootId,onSelectKey,onKeyPointerDown,onKeyPointerMove,onKeyPointerUp}:{project:Project;rootId:string;onSelectKey:(key:AssemblyMasterKey)=>void}&PointerHandlers){
  const rows=useMemo(()=>selectAssemblyMasterRows(project,rootId),[project,rootId]);
  return <>{rows.map(row=><div className="assembly-master-row" key={row.id}>
    <div className="timeline-label"><span>{row.partName} · {LABELS[row.property]}</span></div>
    <div className="timeline-lane">{row.curve.length>1&&<svg className="assembly-master-curve" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polyline points={row.curve.map(point=>`${point.x},${point.y}`).join(' ')} /></svg>}{row.keys.map(key=><button type="button" className={`assembly-master-key ${key.scope==='instance'?'local':''}`} key={key.id} style={{left:`${key.time/project.duration*100}%`}} aria-label={`${row.partName} ${LABELS[row.property]} ${key.scope==='instance'?'local':'shared'} key at ${key.time.toFixed(2)} seconds`} title={`${key.scope==='instance'?'This placement':'Shared source'} · drag to retime`} onPointerDown={event=>onKeyPointerDown(event,key)} onPointerMove={onKeyPointerMove} onPointerUp={onKeyPointerUp} onPointerCancel={onKeyPointerUp} onClick={()=>onSelectKey(key)}/>)}</div>
  </div>)}</>;
}

export function AssemblyMasterRows({project,rootId,onSelectKey,onKeyPointerDown,onKeyPointerMove,onKeyPointerUp}:{project:Project;rootId:string;onSelectKey:(key:AssemblyMasterKey)=>void}&PointerHandlers){
  const [open,setOpen]=useState(false);
  return <><div className="assembly-master-header"><div className="timeline-label"><button type="button" aria-label={`${open?'Hide':'Show'} assembly master`} aria-expanded={open} onClick={()=>setOpen(!open)}>{open?<ChevronDown size={12}/>:<ChevronRight size={12}/>}</button><GitBranch size={11}/><span>MASTER CURVES</span></div><div className="timeline-lane"><span>{open?'Select or drag a key to edit its source or placed clip':'Combined motion preview'}</span></div></div>{open&&<MasterBody project={project} rootId={rootId} onSelectKey={onSelectKey} onKeyPointerDown={onKeyPointerDown} onKeyPointerMove={onKeyPointerMove} onKeyPointerUp={onKeyPointerUp}/>}</>;
}
