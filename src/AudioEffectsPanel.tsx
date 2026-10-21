import { ArrowDown, ArrowUp, RotateCcw, Trash2 } from 'lucide-react';
import type { AudioEffect, AudioEffectType } from './model';
import { boundedAudioEffect, createAudioEffect, MAX_AUDIO_EFFECTS } from './audioEffects';
import './audio-effects.css';

type Parameter = { key: string; label: string; min: number; max: number; step: number; scale?: number };
const TYPES: AudioEffectType[] = ['echo', 'chorus', 'compressor', 'distortion', 'equalizer', 'reverb'];
const NAMES: Record<AudioEffectType,string> = { echo:'Echo', chorus:'Chorus', compressor:'Compressor', distortion:'Distortion', equalizer:'Equalizer', reverb:'Reverb' };
const PARAMETERS: Record<AudioEffectType, Parameter[]> = {
  echo: [{key:'delay',label:'Delay s',min:.05,max:1,step:.01},{key:'feedback',label:'Feedback %',min:0,max:80,step:1,scale:100},{key:'mix',label:'Mix %',min:0,max:100,step:1,scale:100}],
  chorus: [{key:'rate',label:'Rate Hz',min:.1,max:3,step:.1},{key:'depth',label:'Depth ms',min:0,max:8,step:.1,scale:1000},{key:'delay',label:'Delay ms',min:10,max:30,step:1,scale:1000},{key:'mix',label:'Mix %',min:0,max:100,step:1,scale:100}],
  compressor: [{key:'threshold',label:'Threshold dB',min:-60,max:0,step:1},{key:'ratio',label:'Ratio',min:1,max:20,step:.1},{key:'knee',label:'Knee dB',min:0,max:40,step:1},{key:'attack',label:'Attack ms',min:1,max:100,step:1,scale:1000},{key:'release',label:'Release ms',min:10,max:1000,step:10,scale:1000}],
  distortion: [{key:'drive',label:'Drive %',min:0,max:100,step:1,scale:100},{key:'mix',label:'Mix %',min:0,max:100,step:1,scale:100}],
  equalizer: [{key:'low',label:'Low dB',min:-24,max:24,step:1},{key:'mid',label:'Mid dB',min:-24,max:24,step:1},{key:'high',label:'High dB',min:-24,max:24,step:1}],
  reverb: [{key:'seconds',label:'Length s',min:.1,max:2.5,step:.1},{key:'decay',label:'Decay',min:.25,max:5,step:.1},{key:'mix',label:'Mix %',min:0,max:100,step:1,scale:100}],
};

export function AudioEffectsPanel({effects,onChange}:{effects:AudioEffect[];onChange:(effects:AudioEffect[])=>void}) {
  function update(index:number,patch:Partial<AudioEffect>) { onChange(effects.map((effect,i)=>i===index?boundedAudioEffect({...effect,...patch} as AudioEffect):effect)); }
  function move(index:number,direction:-1|1) {const next=effects.slice();[next[index],next[index+direction]]=[next[index+direction],next[index]];onChange(next);}
  return <section className="inspector-section audio-effects-panel">
    <h3>Audio effects</h3>
    <label className="select-label">Add effect<select aria-label="Add audio effect" value="" disabled={effects.length>=MAX_AUDIO_EFFECTS} onChange={event=>{if(!event.target.value)return;onChange([...effects,createAudioEffect(event.target.value as AudioEffectType)]);}}><option value="">Choose an effect…</option>{TYPES.map(type=><option value={type} key={type}>{NAMES[type]}</option>)}</select></label>
    {effects.length===0&&<p className="muted-note">Add an effect to this clip. Effects play in the order shown here.</p>}
    {effects.map((effect,index)=><div className={`audio-effect-card ${effect.enabled?'':'bypassed'}`} key={effect.id}>
      <div className="audio-effect-heading"><label><input aria-label={`Enable ${NAMES[effect.type]} effect`} type="checkbox" checked={effect.enabled} onChange={event=>update(index,{enabled:event.target.checked})}/><strong>{NAMES[effect.type]}</strong></label><div className="audio-effect-actions"><button className="icon-button" aria-label={`Move ${NAMES[effect.type]} effect earlier`} disabled={index===0} onClick={()=>move(index,-1)}><ArrowUp size={13}/></button><button className="icon-button" aria-label={`Move ${NAMES[effect.type]} effect later`} disabled={index===effects.length-1} onClick={()=>move(index,1)}><ArrowDown size={13}/></button><button className="icon-button" aria-label={`Reset ${NAMES[effect.type]} effect`} onClick={()=>{const fresh=createAudioEffect(effect.type);onChange(effects.map((item,i)=>i===index?{...fresh,id:effect.id,enabled:effect.enabled}:item));}}><RotateCcw size={13}/></button><button className="icon-button" aria-label={`Remove ${NAMES[effect.type]} effect`} onClick={()=>onChange(effects.filter((_,i)=>i!==index))}><Trash2 size={13}/></button></div></div>
      <div className="audio-effect-fields">{PARAMETERS[effect.type].map(parameter=>{const scale=parameter.scale??1;const value=Number((effect as unknown as Record<string,number>)[parameter.key]);return <label key={parameter.key}><span>{parameter.label}</span><input type="number" aria-label={`${NAMES[effect.type]} ${parameter.label}`} min={parameter.min} max={parameter.max} step={parameter.step} value={Number((value*scale).toFixed(3))} onChange={event=>{if(event.target.value==='')return;update(index,{[parameter.key]:Number(event.target.value)/scale} as Partial<AudioEffect>);}}/></label>;})}</div>
    </div>)}
  </section>;
}
