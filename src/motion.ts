import { uid, type EasingDirection, type EasingFamily, type FollowPathMotion, type MotionBehavior, type MotionPathPoint, type OscillationMotion, type ShakeMotion, type StoryElement } from './model';

export const MOTION_LIMITS = {
  count: 16, pathPoints: 64, pathCoordinate: 10000, duration: 86400,
  frequency: 1000, positionAmplitude: 5000, rotationAmplitude: 360,
  scaleAmplitude: 4, opacityAmplitude: 1, shakePosition: 1000, shakeRotation: 90,
} as const;

const clamp = (value:number,min:number,max:number) => Math.min(max,Math.max(min,value));
type Ease = (family:EasingFamily,direction:EasingDirection,progress:number)=>number;

/** The duration initially follows the owning clip. All values can be edited
 * without introducing an expression language or dependent UI-only state. */
export function createMotionBehavior(type:'followPath',duration:number):FollowPathMotion;
export function createMotionBehavior(type:'oscillation',duration:number):OscillationMotion;
export function createMotionBehavior(type:'shake',duration:number):ShakeMotion;
export function createMotionBehavior(type:MotionBehavior['type'],duration:number):MotionBehavior;
export function createMotionBehavior(type:MotionBehavior['type'], duration:number):MotionBehavior {
  const span=clamp(Number.isFinite(duration)?duration:1,1/120,MOTION_LIMITS.duration);
  const base={id:uid(),enabled:true,start:0,duration:span};
  if(type==='followPath') return {...base,type,points:[{x:0,y:0},{x:160,y:0}],loop:false,orient:false,easing:'linear',direction:'inOut'};
  if(type==='oscillation') return {...base,type,property:'y',amplitude:24,frequency:1,phase:0,fadeIn:0,fadeOut:0};
  return {...base,type,seed:1,frequency:12,amplitudeX:12,amplitudeY:12,amplitudeRotation:3,smooth:false,fadeIn:.1,fadeOut:.1};
}

/** Stretch authored local seconds while preserving the number of waves or
 * shake samples over the retimed interval. Geometry and seeds stay unchanged. */
export function scaleMotionTime(behaviors:readonly MotionBehavior[]|undefined,factor:number):MotionBehavior[]|undefined {
  if(!behaviors)return undefined;
  if(!Number.isFinite(factor)||factor<=0)throw new Error('Motion time scale must be positive.');
  return behaviors.map(behavior=>{
    const next=structuredClone(behavior);
    next.start*=factor;next.duration*=factor;
    if(next.type!=='followPath'){
      next.frequency/=factor;
      next.fadeIn*=factor;next.fadeOut*=factor;
    }
    return next;
  });
}

export function rekeyMotionBehaviors(behaviors:readonly MotionBehavior[]|undefined):void {
  for(const behavior of behaviors??[])behavior.id=uid();
}

interface PathSample { x:number;y:number;angle:number }
interface ArcSample { segment:number;t:number;length:number }
function cubic(a:number,b:number,c:number,d:number,t:number):number {
  const u=1-t;return u*u*u*a+3*u*u*t*b+3*u*t*t*c+t*t*t*d;
}
function cubicSlope(a:number,b:number,c:number,d:number,t:number):number {
  const u=1-t;return 3*u*u*(b-a)+6*u*t*(c-b)+3*t*t*(d-c);
}
function segmentPoint(points:readonly MotionPathPoint[],segment:number,t:number):{x:number;y:number}{
  const a=points[segment],b=points[segment+1],c1=a.out??a,c2=b.in??b;
  if(!a.out&&!b.in)return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};
  const x=cubic(a.x,c1.x,c2.x,b.x,t),y=cubic(a.y,c1.y,c2.y,b.y,t);
  return {x,y};
}
function atSegment(points:readonly MotionPathPoint[],segment:number,t:number):PathSample {
  const a=points[segment],b=points[segment+1],c1=a.out??a,c2=b.in??b;
  const {x,y}=segmentPoint(points,segment,t);
  if(!a.out&&!b.in)return {x,y,angle:Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI};
  let dx=cubicSlope(a.x,c1.x,c2.x,b.x,t),dy=cubicSlope(a.y,c1.y,c2.y,b.y,t);
  if(Math.hypot(dx,dy)<1e-7){dx=b.x-a.x;dy=b.y-a.y;}
  return {x,y,angle:Math.atan2(dy,dx)*180/Math.PI};
}

/** Approximate arc length gives near-constant spatial speed through curved
 * segments. The fixed table makes seeking and exported frames deterministic. */
export function sampleMotionPath(points:readonly MotionPathPoint[],progress:number):PathSample {
  if(points.length<2)return {x:0,y:0,angle:0};
  const p=clamp(progress,0,1);
  const first=points[0];
  const table:ArcSample[]=[{segment:0,t:0,length:0}];
  let previous=segmentPoint(points,0,0),length=0;
  for(let segment=0;segment<points.length-1;segment++){
    for(let step=1;step<=24;step++){
      const t=step/24,point=segmentPoint(points,segment,t);
      length+=Math.hypot(point.x-previous.x,point.y-previous.y);
      table.push({segment,t,length});previous=point;
    }
  }
  if(length<1e-8)return {x:first.x,y:first.y,angle:0};
  const target=p*length;
  let lo=0,hi=table.length-1;
  while(lo<hi){const mid=(lo+hi)>>1;if(table[mid].length<target)lo=mid+1;else hi=mid;}
  const right=table[lo],left=table[Math.max(0,lo-1)];
  const fraction=right.length===left.length?0:(target-left.length)/(right.length-left.length);
  const segment=fraction>0?right.segment:left.segment;
  const t=left.segment===right.segment?left.t+(right.t-left.t)*fraction:fraction>0?right.t:left.t;
  const point=atSegment(points,segment,t);
  return {x:point.x,y:point.y,angle:point.angle};
}

function envelope(elapsed:number,duration:number,fadeIn:number,fadeOut:number):number {
  let value=1;
  if(fadeIn>0)value=Math.min(value,clamp(elapsed/fadeIn,0,1));
  if(fadeOut>0)value=Math.min(value,clamp((duration-elapsed)/fadeOut,0,1));
  return value;
}
function hash(seed:number,index:number,channel:number):number {
  let value=(seed^Math.imul(index+1,0x9e3779b1)^Math.imul(channel+1,0x85ebca6b))|0;
  value=Math.imul(value^(value>>>16),0x7feb352d);
  value=Math.imul(value^(value>>>15),0x846ca68b);
  return (((value^(value>>>16))>>>0)/0xffffffff)*2-1;
}
function noise(seed:number,position:number,channel:number,smooth:boolean):number {
  const index=Math.floor(position),fraction=position-index;
  const a=hash(seed,index,channel);
  if(!smooth)return a;
  const t=fraction*fraction*(3-2*fraction);
  return a+(hash(seed,index+1,channel)-a)*t;
}

/** The path uses the position sampled when it starts. Keyed or assembly-clip
 * movement after that instant must not drag the authored path along with the
 * object. Oscillation and shake remain additive to the resolved pose. */
export function applyMotionBehaviors(pose:StoryElement,source:StoryElement,time:number,ease:Ease,pathAnchor?:{x:number;y:number}):StoryElement {
  if(!source.motionBehaviors?.length||!Number.isFinite(time))return pose;
  const local=time-source.start;
  let result:StoryElement|undefined;
  let pathStarted=false;
  for(const behavior of source.motionBehaviors){
    if(!behavior.enabled||local<behavior.start)continue;
    const elapsed=local-behavior.start;
    if(behavior.type==='followPath'){
      const raw=behavior.loop ? (elapsed%behavior.duration)/behavior.duration : clamp(elapsed/behavior.duration,0,1);
      const point=sampleMotionPath(behavior.points,clamp(ease(behavior.easing,behavior.direction,raw),0,1));
      result??={...pose};
      if(!pathStarted){result.x=pathAnchor?.x??source.x;result.y=pathAnchor?.y??source.y;pathStarted=true;}
      result.x+=point.x;result.y+=point.y;
      if(behavior.orient)result.rotation+=point.angle;
    }else if(elapsed<=behavior.duration){
      const strength=envelope(elapsed,behavior.duration,behavior.fadeIn,behavior.fadeOut);
      if(behavior.type==='oscillation'){
        const amount=Math.sin(2*Math.PI*behavior.frequency*elapsed+behavior.phase*Math.PI/180)*behavior.amplitude*strength;
        result??={...pose};result[behavior.property]+=amount;
      }else{
        const position=behavior.frequency*elapsed,seed=behavior.seed;
        result??={...pose};
        result.x+=noise(seed,position,0,behavior.smooth)*behavior.amplitudeX*strength;
        result.y+=noise(seed,position,1,behavior.smooth)*behavior.amplitudeY*strength;
        result.rotation+=noise(seed,position,2,behavior.smooth)*behavior.amplitudeRotation*strength;
      }
    }
  }
  if(!result)return pose;
  result.opacity=clamp(result.opacity,0,1);
  return result;
}
