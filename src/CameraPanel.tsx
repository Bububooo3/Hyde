import {useEffect,useRef,useState} from 'react';
import {Camera, Diamond, Trash2} from 'lucide-react';
import {evaluateCamera} from './engine';
import {uid,type CameraProperty,type Keyframe,type Project,type Sequence,type SequenceCamera} from './model';
import {moveTimelineItems,type TimelineItem} from './timelineSelection';

const PROPERTIES:readonly {property:CameraProperty;label:string;step:number;min?:number}[]=[
  {property:'x',label:'Camera X',step:1},{property:'y',label:'Camera Y',step:1},
  {property:'zoom',label:'Camera zoom',step:.05,min:.01},{property:'rotation',label:'Camera rotation',step:1},
];
const FAMILIES=['linear','sine','quad','cubic','quart','quint','expo','circ','back','bounce','elastic'] as const;
const DEFAULT_KEY=(time:number,value:number):Keyframe=>({id:uid(),time,value,easing:'linear',direction:'inOut',mode:'smooth'});
const frameTime=(time:number,fps:number)=>Math.round(time*fps)/fps;

function Field({label,value,step,min,onChange}:{label:string;value:number;step:number;min?:number;onChange:(value:number)=>void}){
  const [draft,setDraft]=useState(String(Number(value.toFixed(3))));
  const cancelled=useRef(false);
  useEffect(()=>setDraft(String(Number(value.toFixed(3)))),[value]);
  const apply=()=>{if(cancelled.current){cancelled.current=false;setDraft(String(Number(value.toFixed(3))));return;}const number=Number(draft);if(draft.trim()&&Number.isFinite(number)&&number>=(min??-Infinity))onChange(number);else setDraft(String(Number(value.toFixed(3))));};
  return <label className="number-field"><span>{label}</span><input type="number" aria-label={label} value={draft} step={step} min={min} onChange={event=>setDraft(event.target.value)} onBlur={apply} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur();if(event.key==='Escape'){cancelled.current=true;event.currentTarget.blur();}}}/></label>;
}

export function CameraPanel({project,sequence,time,recordKeys,selectedKey,selectedKeys,onSelectKey,onCommit,onSeek,onError}:{project:Project;sequence:Sequence;time:number;recordKeys:boolean;selectedKey:{property:CameraProperty;id:string}|null;selectedKeys:readonly {property:CameraProperty;id:string}[];onSelectKey:(key:{property:CameraProperty;id:string}|null)=>void;onCommit:(project:Project)=>void;onSeek:(time:number)=>void;onError:(message:string)=>void}){
  const camera=evaluateCamera(project,time);
  const cameraSource=sequence.camera;
  const selectedTrack=selectedKey&&cameraSource?.tracks.find(track=>track.property===selectedKey.property);
  const key=selectedTrack?.keyframes.find(frame=>frame.id===selectedKey?.id);
  const local=frameTime(Math.max(0,Math.min(sequence.duration,time-sequence.start)),project.fps);
  const makeCamera=():SequenceCamera=>structuredClone(cameraSource??{x:project.width/2,y:project.height/2,zoom:1,rotation:0,tracks:[]});
  function updateCamera(property:CameraProperty,value:number,forceKey=false){
    if(!Number.isFinite(value)||property==='zoom'&&value<.01)return;
    const next=structuredClone(project),scene=next.sequences.find(item=>item.id===sequence.id);
    if(!scene)return;
    scene.camera=makeCamera();
    let track=scene.camera.tracks.find(item=>item.property===property);
    if(forceKey||recordKeys||!!track?.keyframes.length){
      if(!track){track={property,keyframes:[]};scene.camera.tracks.push(track);}
      const existing=track.keyframes.find(frame=>Math.abs(frame.time-local)<1e-7);
      if(existing){existing.value=value;onSelectKey({property,id:existing.id});}
      else {const created=DEFAULT_KEY(local,value);track.keyframes.push(created);track.keyframes.sort((a,b)=>a.time-b.time);onSelectKey({property,id:created.id});}
    }else scene.camera[property]=value;
    onCommit(next);
  }
  function updateSelected(patch:Partial<Keyframe>){
    if(!selectedKey||!key)return;
    if(patch.time!==undefined){
      const proposed=frameTime(patch.time,project.fps),delta=proposed-key.time;
      const items:TimelineItem[]=selectedKeys.map(item=>({kind:'cameraKey',sequenceId:sequence.id,property:item.property,keyId:item.id}));
      try { const next=moveTimelineItems(project,items,delta);if(next!==project)onCommit(next); }
      catch(error){onError(error instanceof Error?error.message:String(error));}
      return;
    }
    const next=structuredClone(project),scene=next.sequences.find(item=>item.id===sequence.id);
    if(!scene?.camera)return;
    for(const item of selectedKeys){const track=scene.camera.tracks.find(candidate=>candidate.property===item.property);const frame=track?.keyframes.find(candidate=>candidate.id===item.id);if(frame)Object.assign(frame,patch);}
    onCommit(next);
  }
  function removeSelected(){if(!selectedKeys.length)return;const next=structuredClone(project),scene=next.sequences.find(item=>item.id===sequence.id);if(!scene?.camera)return;const ids=new Set(selectedKeys.map(item=>item.id));for(const track of scene.camera.tracks)track.keyframes=track.keyframes.filter(item=>!ids.has(item.id));scene.camera.tracks=scene.camera.tracks.filter(item=>item.keyframes.length);onSelectKey(null);onCommit(next);}
  function resetCamera(){const next=structuredClone(project),scene=next.sequences.find(item=>item.id===sequence.id);if(!scene)return;delete scene.camera;onSelectKey(null);onCommit(next);}
  return <details className="inspector-section camera-panel">
    <summary><Camera size={14}/>Camera <span>{sequence.name}</span></summary>
    <div className="camera-fields">{PROPERTIES.map(({property,label,step,min})=><div className="camera-field" key={property}><Field label={label} value={camera[property]} step={step} min={min} onChange={value=>updateCamera(property,value)}/><button type="button" aria-label={`Keyframe ${label.toLowerCase()}`} title={`Add ${label.toLowerCase()} keyframe at playhead`} onClick={()=>updateCamera(property,camera[property],true)}><Diamond size={13}/></button></div>)}</div>
    <p className="muted-note">Camera keys are relative to this scene. A new scene cuts to its own camera.</p>
    {(cameraSource?.tracks.some(track=>track.keyframes.length)??false)&&<div className="camera-key-list"><strong>Camera keyframes</strong>{cameraSource!.tracks.flatMap(track=>track.keyframes.map(frame=>({property:track.property,frame}))).sort((a,b)=>a.frame.time-b.frame.time).map(({property,frame})=><button key={frame.id} className={selectedKey?.id===frame.id?'active':''} onClick={()=>{onSelectKey({property,id:frame.id});onSeek(sequence.start+frame.time);}}><Diamond size={10}/>{property} · {frame.time.toFixed(2)} s</button>)}</div>}
    {key&&<div className="camera-key-editor"><strong>{selectedKeys.length>1?`${selectedKeys.length} camera keyframes`:`${selectedKey!.property} keyframe`}</strong><Field label="Camera key time s" value={key.time} step={1/project.fps} min={0} onChange={value=>updateSelected({time:value})}/><label>Interpolation<select aria-label="Camera key interpolation" value={key.mode} onChange={event=>updateSelected({mode:event.target.value as Keyframe['mode']})}><option value="smooth">Smooth</option><option value="hold">Held (cut)</option><option value="stepped">Stepped</option></select></label><label>Easing<select aria-label="Camera key easing" value={key.easing} onChange={event=>updateSelected({easing:event.target.value as Keyframe['easing']})}>{FAMILIES.map(family=><option key={family}>{family}</option>)}</select></label><button className="text-action danger" onClick={removeSelected}><Trash2 size={13}/>Delete camera keyframe{selectedKeys.length>1?'s':''}</button></div>}
    {cameraSource&&<button className="text-action" onClick={resetCamera}>Reset scene camera</button>}
  </details>;
}
