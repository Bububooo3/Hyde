import {useEffect,useRef,useState} from 'react';
import type {CameraState,FollowPathMotion,MotionPathPoint,Project,StoryElement} from './model';
import {sceneFrameMinimumScale,sceneFrameSvgTransform} from './sceneFrame';

export function motionPointToWorld(base:StoryElement,parent:StoryElement|null,point:{x:number;y:number}){
  if(!parent)return {x:base.x+point.x,y:base.y+point.y};
  const radians=parent.rotation*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
  const x=point.x*parent.scaleX,y=point.y*parent.scaleY;
  return {x:base.x+x*c-y*s,y:base.y+x*s+y*c};
}

export function worldToMotionPoint(base:StoryElement,parent:StoryElement|null,point:{x:number;y:number}){
  const x=point.x-base.x,y=point.y-base.y;
  if(!parent)return {x,y};
  const radians=parent.rotation*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
  return {x:(x*c+y*s)/parent.scaleX,y:(-x*s+y*c)/parent.scaleY};
}

/** Direct manipulation of an additive path, projected through the same scene
 * frame and camera used for regular stage handles. */
export function MotionPathOverlay({behavior,base,parent,project,camera,zoom,activePoint,onStart,onMove,onEnd}:{behavior:FollowPathMotion;base:StoryElement;parent:StoryElement|null;project:Project;camera:CameraState;zoom:number;activePoint:number;onStart:(event:React.PointerEvent,index:number,handle:'anchor'|'in'|'out')=>void;onMove:(event:React.PointerEvent)=>void;onEnd:()=>void}){
  const overlay=useRef<SVGSVGElement>(null),[pixelsPerUnit,setPixelsPerUnit]=useState(1);
  useEffect(()=>{if(!overlay.current)return;const node=overlay.current;const update=()=>setPixelsPerUnit(Math.max(.001,node.clientWidth*zoom/project.width));update();const observer=new ResizeObserver(update);observer.observe(node);return()=>observer.disconnect();},[project.width,zoom]);
  const scene=project.sequences.find(item=>item.id===base.sceneId);
  const frameScale=scene?sceneFrameMinimumScale(project,scene):1,unit=1/(pixelsPerUnit*camera.zoom*frameScale);
  const world=(point:MotionPathPoint|{x:number;y:number})=>motionPointToWorld(base,parent,point);
  const path=behavior.points.map((point,index)=>{
    const at=world(point);
    if(index===0)return `M ${at.x} ${at.y}`;
    const previous=behavior.points[index-1],out=world(previous.out??previous),incoming=world(point.in??point);
    return `C ${out.x} ${out.y} ${incoming.x} ${incoming.y} ${at.x} ${at.y}`;
  }).join(' ');
  return <svg ref={overlay} className="motion-path-overlay" viewBox={`0 0 ${project.width} ${project.height}`} onPointerMove={onMove} onPointerUp={onEnd} onPointerCancel={onEnd}><g transform={scene?sceneFrameSvgTransform(project,scene):undefined}><g transform={`translate(${project.width/2} ${project.height/2}) rotate(${-camera.rotation}) scale(${camera.zoom}) translate(${-camera.x} ${-camera.y})`}>
    <path d={path} fill="none" stroke="#ffc857" strokeWidth={2} vectorEffect="non-scaling-stroke"/>
    {behavior.points.map((point,index)=>{const at=world(point);return <g key={index}>{(['in','out'] as const).map(side=>point[side]&&<g key={side}>{(()=>{const handle=world(point[side]!);return <><line x1={at.x} y1={at.y} x2={handle.x} y2={handle.y} stroke="#d9dde3" strokeWidth={1} vectorEffect="non-scaling-stroke"/><circle cx={handle.x} cy={handle.y} r={4*unit} fill="#d9dde3" stroke="#1f2933" strokeWidth={1} vectorEffect="non-scaling-stroke"/><circle className="motion-path-hit" aria-label={`Move motion point ${index+1} ${side} handle`} cx={handle.x} cy={handle.y} r={12*unit} onPointerDown={event=>onStart(event,index,side)}/></>;})()}</g>)}<circle cx={at.x} cy={at.y} r={(activePoint===index?6:5)*unit} fill={activePoint===index?'#ff8a00':'#ffc857'} stroke="#1f2933" strokeWidth={1.5} vectorEffect="non-scaling-stroke"/><circle className="motion-path-hit" aria-label={`Move motion point ${index+1}`} cx={at.x} cy={at.y} r={13*unit} onPointerDown={event=>onStart(event,index,'anchor')}/></g>;})}
  </g></g></svg>;
}
