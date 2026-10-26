import {useEffect,useRef,useState} from 'react';
import type {CameraState,Project,StoryElement} from './model';
import {sceneFrameMinimumScale,sceneFrameSvgTransform} from './sceneFrame';
import {pathPointToWorld,shapePathContourEntries,shapePathSvg} from './shapePath';

type Handle='anchor'|'in'|'out';

/** The guide and Pixi fill use the same local path commands. Handles are
 * projected through the element, scene frame and camera transforms. */
export function PathOverlay({element,project,camera,zoom,activePoint,activeContour,onStart,onMove,onEnd}:{element:StoryElement|null;project:Project;camera:CameraState;zoom:number;activePoint:number;activeContour:number;onStart:(event:React.PointerEvent,index:number,handle:Handle,contourIndex:number)=>void;onMove:(event:React.PointerEvent)=>void;onEnd:()=>void}){
  const overlay=useRef<SVGSVGElement>(null);
  const [pixelsPerUnit,setPixelsPerUnit]=useState(1);
  useEffect(()=>{if(!overlay.current)return;const node=overlay.current;const update=()=>setPixelsPerUnit(Math.max(.001,node.clientWidth*zoom/project.width));update();const observer=new ResizeObserver(update);observer.observe(node);return()=>observer.disconnect();},[element,project.width,zoom]);
  if(!element?.shapePath||element.locked)return null;
  const e=element,shape=element.shapePath,scene=project.sequences.find(item=>item.id===e.sceneId);
  const frameScale=scene?sceneFrameMinimumScale(project,scene):1;
  const unit=1/(pixelsPerUnit*camera.zoom*frameScale);
  const point=(x:number,y:number)=>pathPointToWorld(e,{x,y});
  const shapeTransform=`translate(${e.x} ${e.y}) rotate(${e.rotation}) scale(${e.scaleX} ${e.scaleY}) translate(${-e.width*e.pivotX} ${-e.height*e.pivotY})`;
  return <svg ref={overlay} className="path-overlay" viewBox={`0 0 ${project.width} ${project.height}`} onPointerMove={onMove} onPointerUp={onEnd} onPointerCancel={onEnd}><g transform={scene?sceneFrameSvgTransform(project,scene):undefined}><g transform={`translate(${project.width/2} ${project.height/2}) rotate(${-camera.rotation}) scale(${camera.zoom}) translate(${-camera.x} ${-camera.y})`}>
    <path d={shapePathSvg(shape,e.width,e.height)} transform={shapeTransform} fill="none" stroke="#ff8a00" strokeWidth={1.5} vectorEffect="non-scaling-stroke"/>
    {shapePathContourEntries(shape).flatMap(({contour,label:contourLabel},contourIndex)=>contour.points.map((anchor,index)=>{const origin=point(anchor.x,anchor.y),label=contourIndex?`${contourLabel.toLowerCase()} point ${index+1}`:`point ${index+1}`;return <g key={`${contourIndex}:${index}`}>
      {(['in','out'] as const).map(side=>{const handle=anchor[side];if(!handle)return null;const at=point(handle.x,handle.y);return <g key={side}><line x1={origin.x} y1={origin.y} x2={at.x} y2={at.y} stroke="#ffc857" strokeWidth={1} vectorEffect="non-scaling-stroke"/><circle cx={at.x} cy={at.y} r={4*unit} fill="#d9dde3" stroke="#1f2933" strokeWidth={1} vectorEffect="non-scaling-stroke"/><circle className="path-handle-hit" aria-label={`Move ${label} ${side} handle`} cx={at.x} cy={at.y} r={12*unit} onPointerDown={event=>onStart(event,index,side,contourIndex)}/></g>;})}
      <circle cx={origin.x} cy={origin.y} r={index===activePoint&&contourIndex===activeContour?6*unit:5*unit} fill={index===activePoint&&contourIndex===activeContour?'#ff8a00':'#ffc857'} stroke="#1f2933" strokeWidth={1.5} vectorEffect="non-scaling-stroke"/>
      <circle className="path-handle-hit" aria-label={`Move path ${label}`} cx={origin.x} cy={origin.y} r={12*unit} onPointerDown={event=>onStart(event,index,'anchor',contourIndex)}/>
    </g>;}))}
  </g></g></svg>;
}
