import {useEffect,useRef,useState} from 'react';
import type {CameraState,Project,StoryElement} from './model';
import {sceneFrameMinimumScale,sceneFrameSvgTransform} from './sceneFrame';
import {pathPointToWorld} from './shapePath';

export function PinOverlay({element,project,camera,zoom,onStart,onMove,onEnd}:{element:StoryElement|null;project:Project;camera:CameraState;zoom:number;onStart:(event:React.PointerEvent,index:number)=>void;onMove:(event:React.PointerEvent)=>void;onEnd:()=>void}){
  const overlay=useRef<SVGSVGElement>(null);
  const [pixelsPerUnit,setPixelsPerUnit]=useState(1);
  useEffect(()=>{if(!overlay.current)return;const node=overlay.current;const update=()=>setPixelsPerUnit(Math.max(.001,node.clientWidth*zoom/project.width));update();const observer=new ResizeObserver(update);observer.observe(node);return()=>observer.disconnect();},[element,project.width,zoom]);
  if(!element?.mediaPin||element.locked)return null;
  const scene=project.sequences.find(item=>item.id===element.sceneId);
  const frameScale=scene?sceneFrameMinimumScale(project,scene):1;
  const unit=1/(pixelsPerUnit*camera.zoom*frameScale);
  const points=element.mediaPin.map(point=>pathPointToWorld(element,point));
  const outline=points.map((point,index)=>`${index?'L':'M'} ${point.x} ${point.y}`).join(' ')+' Z';
  return <svg ref={overlay} className="pin-overlay" viewBox={`0 0 ${project.width} ${project.height}`} onPointerMove={onMove} onPointerUp={onEnd} onPointerCancel={onEnd}><g transform={scene?sceneFrameSvgTransform(project,scene):undefined}><g transform={`translate(${project.width/2} ${project.height/2}) rotate(${-camera.rotation}) scale(${camera.zoom}) translate(${-camera.x} ${-camera.y})`}>
    <path d={outline} fill="none" stroke="#ff8a00" strokeWidth={1.5} strokeDasharray="5 3" vectorEffect="non-scaling-stroke"/>
    {points.map((point,index)=><g key={index}><circle cx={point.x} cy={point.y} r={5*unit} fill="#ffc857" stroke="#1f2933" strokeWidth={1.5} vectorEffect="non-scaling-stroke"/><circle className="pin-corner-hit" aria-label={`Move media corner ${index+1}`} cx={point.x} cy={point.y} r={13*unit} onPointerDown={event=>onStart(event,index)}/></g>)}
  </g></g></svg>;
}
