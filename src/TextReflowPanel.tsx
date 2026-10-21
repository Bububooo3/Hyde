import type {EasingDirection,EasingFamily,TextReflow} from './model';

const FAMILIES:EasingFamily[]=['linear','sine','quad','cubic','quart','quint','expo','circ','back','bounce','elastic'];
const DEFAULT:TextReflow={preset:'glide',start:0,duration:1,stagger:.08,easing:'sine',easingDirection:'inOut'};

export function TextReflowPanel({value,onChange,playheadStart}:{
  value?:TextReflow;
  onChange:(value:TextReflow|undefined)=>void;
  playheadStart:number;
}){
  const change=(patch:Partial<TextReflow>)=>onChange({...DEFAULT,...value,...patch});
  const number=(key:'start'|'duration'|'stagger',label:string,minimum:number,step:number)=><label className="select-label">{label}
    <input aria-label={`Text reflow ${key}`} type="number" min={minimum} step={step} value={value?.[key]??0}
      onChange={event=>{const parsed=Number(event.target.value);if(Number.isFinite(parsed))change({[key]:Math.max(minimum,parsed)});}}/>
  </label>;
  return <section className="inspector-section text-reflow-panel">
    <h3>Animated reflow</h3>
    <label className="check-row"><input aria-label="Animate text reflow" type="checkbox" checked={!!value}
      onChange={event=>onChange(event.target.checked?{...DEFAULT,start:playheadStart}:undefined)}/>Animate layout change</label>
    {value&&<>
      <p className="muted-note">Words move from the live layout at Start to the layout at the end of this interval. Shape and text geometry can be animated in the same interval.</p>
      <label className="select-label">Preset<select aria-label="Text reflow preset" value={value.preset} onChange={event=>change({preset:event.target.value as TextReflow['preset']})}>
        <option value="glide">Glide together</option><option value="cascade">Cascade by word</option>
      </select></label>
      <div className="field-pair">{number('start','Start s',0,.1)}{number('duration','Duration s',.01,.1)}</div>
      {value.preset==='cascade'&&number('stagger','Stagger s',0,.05)}
      <div className="field-pair"><label className="select-label">Easing<select aria-label="Text reflow easing" value={value.easing} onChange={event=>change({easing:event.target.value as EasingFamily})}>
        {FAMILIES.map(family=><option key={family}>{family}</option>)}
      </select></label><label className="select-label">Direction<select aria-label="Text reflow easing direction" value={value.easingDirection} onChange={event=>change({easingDirection:event.target.value as EasingDirection})}>
        <option value="in">Ease in</option><option value="out">Ease out</option><option value="inOut">Ease in-out</option>
      </select></label></div>
    </>}
  </section>;
}
