import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {CONTROL_HELP,HELP_TOPICS,WALKTHROUGH_STEPS} from './helpContent';

type Tip={text:string;left:number;top:number};

/** One viewport-aware tooltip serves annotated controls and small info buttons.
 * aria-description keeps the same guidance available to screen readers. */
export function HelpTooltips({disabled=false}:{disabled?:boolean}){
  const [tip,setTip]=useState<Tip|null>(null);
  const active=useRef<HTMLElement|null>(null);
  const tipElement=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    if(!tip||!tipElement.current||!active.current)return;
    const control=active.current.getBoundingClientRect();
    const bubble=tipElement.current.getBoundingClientRect();
    const left=Math.max(10,Math.min(control.left,window.innerWidth-bubble.width-10));
    const below=control.bottom+8;
    const top=below+bubble.height<=window.innerHeight-10?below:Math.max(10,control.top-bubble.height-8);
    if(Math.abs(left-tip.left)>1||Math.abs(top-tip.top)>1)setTip({...tip,left,top});
  },[tip]);
  useEffect(()=>{
    if(disabled){active.current=null;setTip(null);return;}
    const show=(event:Event)=>{
      const element=event.target instanceof Element?event.target.closest<HTMLElement>('[data-help]'):null;
      const text=element?.dataset.help?CONTROL_HELP[element.dataset.help]:undefined;
      if(!element||!text)return;
      active.current=element;
      const rect=element.getBoundingClientRect();
      setTip({text,left:rect.left,top:rect.bottom+8});
    };
    const hide=(event:Event)=>{
      const element=active.current;if(!element)return;
      const related=(event as FocusEvent|PointerEvent).relatedTarget;
      if(related instanceof Node&&element.contains(related))return;
      if(event.type==='pointerout'&&element.contains(document.activeElement))return;
      active.current=null;setTip(null);
    };
    const touch=(event:PointerEvent)=>{if(event.pointerType!=='touch')return;
      if(event.target instanceof Element&&event.target.closest('[data-help]'))show(event);
      else{active.current=null;setTip(null);}
    };
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){active.current=null;setTip(null);}};
    const clear=()=>{active.current=null;setTip(null);};
    document.addEventListener('pointerover',show);document.addEventListener('pointerout',hide);
    document.addEventListener('focusin',show);document.addEventListener('focusout',hide);
    document.addEventListener('pointerdown',touch);document.addEventListener('keydown',escape);
    window.addEventListener('resize',clear);window.addEventListener('scroll',clear,true);
    return()=>{document.removeEventListener('pointerover',show);document.removeEventListener('pointerout',hide);
      document.removeEventListener('focusin',show);document.removeEventListener('focusout',hide);
      document.removeEventListener('pointerdown',touch);document.removeEventListener('keydown',escape);
      window.removeEventListener('resize',clear);window.removeEventListener('scroll',clear,true);};
  },[disabled]);
  return tip?<div ref={tipElement} className="control-tooltip" role="tooltip" style={{left:tip.left,top:tip.top}}>{tip.text}</div>:null;
}

export function HelpHint({id,label}:{id:string;label:string}){
  return <button type="button" className="help-hint" data-help={id} aria-label={`About ${label}`} aria-description={CONTROL_HELP[id]}><span aria-hidden="true">i</span></button>;
}

export function HelpDialog({onClose,onRestart}:{onClose:()=>void;onRestart:()=>void}){
  const [query,setQuery]=useState(''),[selectedId,setSelectedId]=useState('start');
  const search=useRef<HTMLInputElement>(null),dialog=useRef<HTMLDivElement>(null);
  const topics=useMemo(()=>HELP_TOPICS.filter(topic=>`${topic.title} ${topic.intro} ${topic.steps.join(' ')}`.toLowerCase().includes(query.toLowerCase().trim())),[query]);
  const selected=topics.find(topic=>topic.id===selectedId)??topics[0]??HELP_TOPICS[0];
  useEffect(()=>{
    const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
    search.current?.focus();
    return()=>opener?.focus();
  },[]);
  function onKeyDown(event:React.KeyboardEvent){
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();return;}
    if(event.key!=='Tab'||!dialog.current)return;
    const focusable=Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled])'));
    const first=focusable[0],last=focusable.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
  return <div className="help-backdrop" onPointerDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <div ref={dialog} className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="decomposer-help-title" onKeyDown={onKeyDown}>
      <header className="help-dialog-header"><div><small>Hyde Image Decomposer</small><h1 id="decomposer-help-title">Help</h1></div><button type="button" onClick={onClose} aria-label="Close Help">Close</button></header>
      <div className="help-dialog-layout"><nav className="help-topics" aria-label="Help topics"><label>Find a topic<input ref={search} aria-label="Search help topics" type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search settings, masks, export…"/></label>
        <div className="help-topic-list">{topics.length?topics.map(topic=><button key={topic.id} type="button" aria-current={selected.id===topic.id?'page':undefined} onClick={()=>setSelectedId(topic.id)}>{topic.title}</button>):<p>No topics match. Try “path”, “part” or “export”.</p>}</div>
      </nav><article className="help-article" aria-live="polite"><h2>{selected.title}</h2><p>{selected.intro}</p><ol>{selected.steps.map((step,index)=><li key={index}>{step}</li>)}</ol></article></div>
      <footer className="help-dialog-footer"><button type="button" onClick={onRestart}>Restart walkthrough</button><button type="button" className="accent" onClick={onClose}>Done</button></footer>
    </div>
  </div>;
}

export function Walkthrough({onExit}:{onExit:()=>void}){
  const [index,setIndex]=useState(0),step=WALKTHROUGH_STEPS[index];
  useEffect(()=>{
    const target=document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    target?.classList.add('walkthrough-target');
    target?.scrollIntoView({block:'nearest',inline:'nearest'});
    return()=>target?.classList.remove('walkthrough-target');
  },[step.target]);
  useEffect(()=>{
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')onExit();};
    document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);
  },[onExit]);
  return <aside className="walkthrough-card" aria-label="Getting started walkthrough" aria-live="polite">
    <div className="walkthrough-top"><span>Getting started · {index+1} of {WALKTHROUGH_STEPS.length}</span><button type="button" aria-label="Close walkthrough" onClick={onExit}>×</button></div>
    <h2>{step.title}</h2><p>{step.body}</p>
    <div className="walkthrough-actions"><button type="button" onClick={onExit}>Skip</button><span/><button type="button" disabled={index===0} onClick={()=>setIndex(index-1)}>Back</button><button type="button" className="accent" onClick={()=>index===WALKTHROUGH_STEPS.length-1?onExit():setIndex(index+1)}>{index===WALKTHROUGH_STEPS.length-1?'Finish':'Next'}</button></div>
  </aside>;
}
