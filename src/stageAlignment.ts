import {elementBounds} from './alignment';
import type {StoryElement} from './model';

export interface StageAlignmentGuides {x?:number;y?:number}

/** Compare transformed artwork edges and centers in stage coordinates. The
 * selected pivot remains the authored position; only its drag preview moves. */
export function snapStagePosition(
  moving:StoryElement,
  others:readonly StoryElement[],
  desired:{x:number;y:number},
  stage:{width:number;height:number},
  tolerance:number,
):{position:{x:number;y:number};guides:StageAlignmentGuides}{
  const bounds=elementBounds({...moving,x:desired.x,y:desired.y});
  const movingX=[bounds.left,(bounds.left+bounds.right)/2,bounds.right];
  const movingY=[bounds.top,(bounds.top+bounds.bottom)/2,bounds.bottom];
  const targetX=[0,stage.width/2,stage.width];
  const targetY=[0,stage.height/2,stage.height];
  for(const other of others){
    if(other.id===moving.id||other.sceneId!==moving.sceneId||other.kind==='audio'||other.kind==='group')continue;
    const reference=elementBounds(other);
    targetX.push(reference.left,(reference.left+reference.right)/2,reference.right);
    targetY.push(reference.top,(reference.top+reference.bottom)/2,reference.bottom);
  }
  const nearest=(positions:readonly number[],targets:readonly number[])=>{
    let best:{delta:number;guide:number}|undefined;
    for(const value of positions)for(const guide of targets){
      const delta=guide-value;
      if(Math.abs(delta)<=tolerance&&(!best||Math.abs(delta)<Math.abs(best.delta)))best={delta,guide};
    }
    return best;
  };
  const x=nearest(movingX,targetX),y=nearest(movingY,targetY);
  return {position:{x:desired.x+(x?.delta??0),y:desired.y+(y?.delta??0)},guides:{x:x?.guide,y:y?.guide}};
}
