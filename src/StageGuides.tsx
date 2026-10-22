import type { CameraState, Project, StoryElement } from './model';
import { evaluateProject } from './engine';
import {sceneFrameSvgTransform} from './sceneFrame';
import {shapePathSvg} from './shapePath';
import type {StageAlignmentGuides} from './stageAlignment';

function outline(element: StoryElement, color: string, label: string) {
  const e=element;
  const transform=`translate(${e.x} ${e.y}) rotate(${e.rotation}) scale(${e.scaleX} ${e.scaleY}) translate(${-e.width*e.pivotX} ${-e.height*e.pivotY})`;
  const body=e.shapePath?<path d={shapePathSvg(e.shapePath,e.width,e.height)}/>:
    e.kind==='ellipse'?<ellipse cx={e.width/2} cy={e.height/2} rx={e.width/2} ry={e.height/2}/>:
    e.kind==='polygon'&&e.points?.length?<polygon points={e.points.map(p=>`${p.x},${p.y}`).join(' ')}/>:
    <rect width={e.width} height={e.height}/>;
  return <g key={label} transform={transform} fill={color} fillOpacity=".16" stroke={color} strokeOpacity=".75" strokeWidth={2} vectorEffect="non-scaling-stroke">{body}</g>;
}

export function StageGuides({project,time,camera,selectedId,gridCount,previous,next,alignment}:{project:Project;time:number;camera:CameraState;selectedId?:string;gridCount:number;previous:boolean;next:boolean;alignment?:StageAlignmentGuides|null}) {
  const target=selectedId?project.elements.find(e=>e.id===selectedId):undefined;
  const times=target?.tracks.flatMap(track=>track.keyframes.map(key=>target.start+key.time)).sort((a,b)=>a-b)??[];
  const previousTime=[...times].reverse().find(t=>t<time-.00001);
  const nextTime=times.find(t=>t>time+.00001);
  const previousPose=previous&&previousTime!==undefined?evaluateProject(project,previousTime).find(e=>e.id===selectedId):undefined;
  const nextPose=next&&nextTime!==undefined?evaluateProject(project,nextTime).find(e=>e.id===selectedId):undefined;
  const scene=project.sequences.find(item=>item.id===target?.sceneId);
  const n=Math.max(0,Math.min(64,Math.floor(gridCount)));
  return <svg className="stage-guides" viewBox={`0 0 ${project.width} ${project.height}`} aria-hidden="true">
    <g transform={scene?sceneFrameSvgTransform(project,scene):undefined}><g transform={`translate(${project.width/2} ${project.height/2}) rotate(${-camera.rotation}) scale(${camera.zoom}) translate(${-camera.x} ${-camera.y})`}>{previousPose&&outline(previousPose,'#5c6670','previous')}{nextPose&&outline(nextPose,'#ffc857','next')}{alignment?.x!==undefined&&<line className="stage-alignment-guide" x1={alignment.x} x2={alignment.x} y1={-project.height} y2={project.height*2}/>} {alignment?.y!==undefined&&<line className="stage-alignment-guide" x1={-project.width} x2={project.width*2} y1={alignment.y} y2={alignment.y}/>}</g></g>
    {n>0&&Array.from({length:n-1},(_,i)=>i+1).map(i=><g key={i} stroke="#5c6670" strokeOpacity=".45" strokeWidth={1} vectorEffect="non-scaling-stroke"><line x1={i*project.width/n} y1={0} x2={i*project.width/n} y2={project.height}/><line x1={0} y1={i*project.height/n} x2={project.width} y2={i*project.height/n}/></g>)}
  </svg>;
}
