import { useEffect, useRef, useState } from 'react';
import type { CameraState, Project, StoryElement } from './model';
import { evaluateProject } from './engine';
import { StageRenderer } from './render';
import {sceneFrameMinimumScale,sceneFrameSvgTransform} from './sceneFrame';

export function Stage({project,time,onError,onWarning,onFramePending,onFrameReady,prepareAheadSeconds=0,editorOverscan=0}: {project:Project;time:number;onError?:(message:string)=>void;onWarning?:(message:string)=>void;onFramePending?:(time:number)=>void;onFrameReady?:(time:number)=>void;prepareAheadSeconds?:number;editorOverscan?:number}) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<StageRenderer|null>(null);
  const latest = useRef({project,time}); latest.current={project,time};
  const last = useRef<{project:Project;time:number}|null>(null);
  const reportedWarnings=useRef('');
  const prepared=useRef<{project:Project;bucket:number}|null>(null);
  useEffect(()=>{
    let stopped=false, raf=0,pendingTimer=0;
    async function loop() {
      if(stopped) return;
      const next=latest.current;
      const stage=renderer.current;
      if(stage && (last.current?.project!==next.project || last.current.time!==next.time)) {
        pendingTimer=onFramePending?window.setTimeout(()=>onFramePending(next.time),200):0;
        try {
          await stage.render(next.project,evaluateProject(next.project,next.time),next.time);
          if(stopped)return;
          last.current=next;
          const warnings=stage.warnings;
          const signature=warnings.length?`${next.project.id}:${warnings.join('|')}`:'';
          if(signature!==reportedWarnings.current&&latest.current.project===next.project){
            if(onWarning)onWarning(warnings.join(' '));
            else if(signature)onError?.(warnings.join(' '));
          }
          reportedWarnings.current=signature;
          onFrameReady?.(next.time);
          if(prepareAheadSeconds>0){
            const bucket=Math.floor(next.time*2);
            if(prepared.current?.project!==next.project||prepared.current.bucket!==bucket){
              prepared.current={project:next.project,bucket};
              const samples=[.5,1,2].filter(offset=>offset<=prepareAheadSeconds&&next.time+offset<next.project.duration);
              const upcoming=samples.flatMap(offset=>evaluateProject(next.project,next.time+offset));
              void stage.prepareMedia(next.project,upcoming).catch(error=>onError?.(error instanceof Error?error.message:String(error)));
            }
          }
        }
        catch(e) {onError?.(e instanceof Error?e.message:'Stage render failed');}
        finally{if(pendingTimer)window.clearTimeout(pendingTimer);pendingTimer=0;}
      }
      if(!stopped) raf=requestAnimationFrame(()=>{void loop();});
    }
    void document.fonts.load('400 40px "JetBrains Mono"').then(()=>stopped?null:StageRenderer.create(host.current!,editorOverscan)).then(r=>{if(!r)return;if(stopped){r.destroy();return;}renderer.current=r;last.current=null;void loop();}).catch(e=>onError?.(String(e)));
    return()=>{stopped=true;cancelAnimationFrame(raf);if(pendingTimer)window.clearTimeout(pendingTimer);renderer.current?.destroy();renderer.current=null;};
  },[]);
  return <div ref={host} className={`render-host ${editorOverscan?'editor-overscan':''}`} style={editorOverscan?{'--editor-canvas-width':`${(project.width+editorOverscan*2)/project.width*100}%`,'--editor-canvas-height':`${(project.height+editorOverscan*2)/project.height*100}%`,'--editor-canvas-left':`${-editorOverscan/project.width*100}%`,'--editor-canvas-top':`${-editorOverscan/project.height*100}%`} as React.CSSProperties:undefined} />;
}

export function SelectionOverlay({element,project,camera,pivotMode,rotationPoint,onStart,zoom=1,primary=true,interactive=true}: {element:StoryElement|null;project:Project;camera:CameraState;pivotMode:boolean;rotationPoint?:{x:number;y:number};zoom?:number;primary?:boolean;interactive?:boolean;onStart:(event:React.PointerEvent,mode:'move'|'resize'|'rotate'|'pivot')=>void}) {
  const overlay=useRef<SVGSVGElement>(null);
  const [pixelsPerUnit,setPixelsPerUnit]=useState(1);
  const visible=!!element&&element.kind!=='audio'&&element.kind!=='group';
  useEffect(()=>{if(!overlay.current)return;const node=overlay.current;const update=()=>setPixelsPerUnit(Math.max(.001,node.clientWidth*zoom/project.width));update();const observer=new ResizeObserver(update);observer.observe(node);return()=>observer.disconnect();},[visible,project.width,zoom]);
  if(!element || element.kind==='audio' || element.kind==='group') return null;
  const e=element;
  const scene=project.sequences.find(item=>item.id===e.sceneId);
  const frameScale=scene?sceneFrameMinimumScale(project,scene):1;
  const a=e.rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a),unit=1/(pixelsPerUnit*camera.zoom*frameScale);
  const point=(x:number,y:number)=>{const dx=(x-e.width*e.pivotX)*e.scaleX,dy=(y-e.height*e.pivotY)*e.scaleY;return {x:e.x+dx*c-dy*s,y:e.y+dx*s+dy*c};};
  const corners=[point(0,0),point(e.width,0),point(e.width,e.height),point(0,e.height)];
  const top=point(e.width/2,0),rotate={x:top.x+s*24*unit*Math.sign(e.scaleY||1),y:top.y-c*24*unit*Math.sign(e.scaleY||1)},resize=corners[2];
  const rotationLocked=!!e.attachment&&e.attachment.type!=='hinge';
  return <svg ref={overlay} className={`selection-overlay ${primary?'primary':'secondary'}`} data-selection-id={e.id} aria-hidden="true" viewBox={`0 0 ${project.width} ${project.height}`}><g transform={scene?sceneFrameSvgTransform(project,scene):undefined}><g transform={`translate(${project.width/2} ${project.height/2}) rotate(${-camera.rotation}) scale(${camera.zoom}) translate(${-camera.x} ${-camera.y})`}>
    {rotationPoint&&<g className="world-rotation-point" aria-label="World rotation point" pointerEvents="none"><circle cx={rotationPoint.x} cy={rotationPoint.y} r={7*unit}/><path d={`M ${rotationPoint.x-13*unit} ${rotationPoint.y} H ${rotationPoint.x+13*unit} M ${rotationPoint.x} ${rotationPoint.y-13*unit} V ${rotationPoint.y+13*unit}`}/></g>}
    <polygon points={corners.map(p=>`${p.x},${p.y}`).join(' ')} fill="none" stroke={primary?'#ffc857':'#8bd4ee'} strokeWidth={primary?1.5:1.25} strokeDasharray={primary?undefined:'5 4'} vectorEffect="non-scaling-stroke"/>
    {primary&&interactive&&!e.locked&&!pivotMode&&<>
      <path d={`M ${top.x} ${top.y} L ${rotate.x} ${rotate.y}`} stroke="#ffc857" vectorEffect="non-scaling-stroke"/>
      <circle className="handle rotate" cx={rotate.x} cy={rotate.y} r={5*unit} style={{pointerEvents:'none',fill:rotationLocked?'#5c6670':undefined}}/>
      <circle className={`handle-hit rotate ${rotationLocked?'locked':''}`} aria-label={rotationLocked?'Rotation locked by attachment':'Rotate selection'} cx={rotate.x} cy={rotate.y} r={12*unit} onPointerDown={ev=>onStart(ev,'rotate')}><title>{rotationLocked?'Rotation locked by attachment':'Drag to rotate · Alt bypasses snapping'}</title></circle>
      {!e.parentId&&!e.attachment&&<><rect className="handle resize" x={resize.x-4*unit} y={resize.y-4*unit} width={8*unit} height={8*unit} style={{pointerEvents:'none'}}/><circle className="handle-hit resize" aria-label="Resize selection" cx={resize.x} cy={resize.y} r={12*unit} onPointerDown={ev=>onStart(ev,'resize')}/></>}
    </>}
    {primary&&interactive&&<circle className={`pivot ${pivotMode&&!e.attachment?'editable':''}`} cx={e.x} cy={e.y} r={5*unit} style={{pointerEvents:'none',fill:e.attachment?'#5c6670':undefined}}/>}
    {primary&&interactive&&pivotMode&&!e.locked&&<circle className={`handle-hit pivot-hit ${e.attachment?'locked':''}`} aria-label={e.attachment?'Pivot locked by attachment':'Move pivot'} cx={e.x} cy={e.y} r={12*unit} onPointerDown={ev=>onStart(ev,'pivot')}><title>{e.attachment?'Pivot locked by attachment':'Drag to move pivot'}</title></circle>}
  </g></g></svg>;
}
