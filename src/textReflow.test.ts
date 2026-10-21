import {describe,expect,it} from 'vitest';
import type {TextReflow} from './model';
import {reflowUnitAt,textReflowEnd} from './textReflow';

const glide:TextReflow={preset:'glide',start:1,duration:2,stagger:.25,easing:'linear',easingDirection:'in'};
const from={id:'word:4',text:'story',x:20,y:0,width:40,height:20};
const to={...from,x:120,y:60};

describe('animated text reflow',()=>{
  it('moves a stable word between project-clock layouts with exact endpoints',()=>{
    expect(textReflowEnd(glide,5)).toBe(3);
    expect(reflowUnitAt(glide,1,2,5,from,to)).toEqual(from);
    expect(reflowUnitAt(glide,2,2,5,from,to)).toEqual({...to,x:70,y:30});
    expect(reflowUnitAt(glide,3,2,5,from,to)).toEqual(to);
    expect(reflowUnitAt(glide,2,2,5,undefined,to)).toEqual(to);
  });

  it('cascades words while preserving the final target position',()=>{
    const cascade={...glide,preset:'cascade' as const};
    expect(textReflowEnd(cascade,5)).toBe(4);
    expect(reflowUnitAt(cascade,1.25,2,5,from,to)).toEqual(from);
    expect(reflowUnitAt(cascade,2.5,2,5,from,to).x).toBe(70);
    expect(reflowUnitAt(cascade,4,4,5,from,to)).toEqual(to);
  });
});
