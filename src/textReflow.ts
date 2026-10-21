import type {TextReflow} from './model';
import type {TextUnit} from './textUnits';
import {ease} from './engine';

export function textReflowEnd(reflow:TextReflow,wordCount:number):number{
  return reflow.start+reflow.duration+(reflow.preset==='cascade'?Math.max(0,wordCount-1)*reflow.stagger:0);
}

/** Source offsets remain the identity even when a word changes line or slot. */
export function reflowUnitAt(reflow:TextReflow,time:number,index:number,count:number,from:TextUnit|undefined,to:TextUnit):TextUnit{
  if(!from)return to;
  const begin=reflow.start+(reflow.preset==='cascade'?index*reflow.stagger:0);
  const progress=Math.max(0,Math.min(1,(time-begin)/reflow.duration));
  const blend=ease(reflow.easing,reflow.easingDirection,progress);
  return {...to,x:from.x+(to.x-from.x)*blend,y:from.y+(to.y-from.y)*blend,
    width:from.width+(to.width-from.width)*blend,height:from.height+(to.height-from.height)*blend};
}
