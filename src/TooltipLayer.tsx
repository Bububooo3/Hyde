import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';

type Tip = { text: string; example?: string; x: number; y: number };

export function TooltipLayer() {
  const [tip,setTip]=useState<Tip|null>(null);
  useEffect(()=>{
    let timer=0,hideTimer=0,tooltipHovered=false,tooltipFocused=false;
    const clear=(event:Event)=>{if((event.target as Element)?.closest?.('.hyde-tooltip'))return;tooltipHovered=false;tooltipFocused=false;window.clearTimeout(timer);window.clearTimeout(hideTimer);setTip(null);};
    const enter=(event:Event)=>{
      if((event.target as Element)?.closest?.('.hyde-tooltip')){if(event.type==='pointerover')tooltipHovered=true;else tooltipFocused=true;window.clearTimeout(hideTimer);return;}
      const target=event.target instanceof Element?event.target.closest<HTMLElement>('[data-hyde-tooltip],[data-help],[title],button.icon-button'):null;
      if(!target)return;
      const native=target.getAttribute('title');
      if(native){
        // Native titles are not exposed once removed. Preserve a name for icon-only buttons.
        if(target instanceof HTMLButtonElement&&!target.getAttribute('aria-label')&&(!target.textContent?.trim()||target.textContent.trim()==='⌂'))target.setAttribute('aria-label',native);
        target.removeAttribute('title');
      }
      if(/^close\b/i.test(target.getAttribute('aria-label')??native??''))return;
      if(native)target.dataset.hydeTooltip=native;
      const label=target.dataset.hydeTooltip||target.dataset.help||(target.matches('button.icon-button')?target.getAttribute('aria-label'):null);
      if(!label)return;
      window.clearTimeout(timer);window.clearTimeout(hideTimer);
      const bounds=target.getBoundingClientRect();
      const below=bounds.bottom+8;
      const above=bounds.top-(target.dataset.example?70:46);
      timer=window.setTimeout(()=>setTip({text:label,example:target.dataset.example,x:Math.min(window.innerWidth-280,Math.max(8,bounds.left)),y:below+70>window.innerHeight?Math.max(8,above):below}),120);
    };
    const leave=(event:Event)=>{
      const from=(event.target as Element)?.closest?.('.hyde-tooltip');
      const to=(event as PointerEvent).relatedTarget;
      if(from){if(to instanceof Element&&to.closest('.hyde-tooltip'))return;if(event.type==='pointerout')tooltipHovered=false;else tooltipFocused=false;}
      if(tooltipHovered||tooltipFocused)return;
      window.clearTimeout(timer);window.clearTimeout(hideTimer);hideTimer=window.setTimeout(()=>setTip(null),230);
    };
    document.addEventListener('pointerover',enter,true);
    document.addEventListener('focusin',enter,true);
    document.addEventListener('pointerout',leave,true);
    document.addEventListener('focusout',leave,true);
    document.addEventListener('pointerdown',clear,true);
    return()=>{window.clearTimeout(timer);window.clearTimeout(hideTimer);document.removeEventListener('pointerover',enter,true);document.removeEventListener('focusin',enter,true);document.removeEventListener('pointerout',leave,true);document.removeEventListener('focusout',leave,true);document.removeEventListener('pointerdown',clear,true);};
  },[]);
  if(!tip)return null;
  return <div className="hyde-tooltip" role="tooltip" style={{left:tip.x,top:tip.y}} onPointerEnter={()=>{}}>
    <span>{tip.text}</span>{tip.example&&<small>{tip.example}</small>}
    <button aria-label="Copy help text" onPointerDown={e=>e.stopPropagation()} onClick={()=>void navigator.clipboard?.writeText([tip.text,tip.example].filter(Boolean).join('\n'))}><Copy size={12}/></button>
  </div>;
}
