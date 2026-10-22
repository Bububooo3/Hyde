import type {Project} from './model';
import {descendantIds} from './editing';

const SNAP_DISTANCE_PX=9;

export interface TimelineSnapOptions {
  duration:number;
  laneWidth:number;
  fps:number;
  targets:readonly number[];
  enabled:boolean;
}

/** Collect visible timing landmarks from a fixed drag snapshot. Moving clips and
 * their descendants are omitted so they cannot attract their own edges. */
export function timelineSnapTargets(project:Project,options:{
  playhead?:number;
  excludeElementIds?:Iterable<string>;
  excludeInstanceIds?:Iterable<string>;
}={}):number[]{
  const excluded=descendantIds(project,options.excludeElementIds??[]);
  const excludedInstances=new Set(options.excludeInstanceIds??[]);
  const targets:number[]=[0,project.duration];
  if(options.playhead!==undefined)targets.push(options.playhead);
  for(const scene of project.sequences)targets.push(scene.start,scene.start+scene.duration);
  for(const element of project.elements){
    if(excluded.has(element.id))continue;
    targets.push(element.start,element.start+element.duration);
    for(const instance of element.clipInstances??[]){
      if(excludedInstances.has(instance.id))continue;
      const start=element.start+instance.start;
      targets.push(start,start+instance.duration);
    }
  }
  return [...new Set(targets.filter(value=>Number.isFinite(value)&&value>=0&&value<=project.duration))];
}

/** Snap a rigid drag using any of its visible edges or key positions. Nearby
 * landmarks take precedence; otherwise the primary anchor lands on a frame. */
export function snapTimelineDelta(rawDelta:number,anchors:readonly number[],options:TimelineSnapOptions):number{
  if(!options.enabled||!Number.isFinite(rawDelta)||!anchors.length)return rawDelta;
  const threshold=SNAP_DISTANCE_PX*options.duration/Math.max(1,options.laneWidth);
  let correction:number|undefined;
  for(const anchor of anchors)for(const target of options.targets){
    const offset=target-(anchor+rawDelta);
    if(Math.abs(offset)<=threshold+1e-9&&(correction===undefined||Math.abs(offset)<Math.abs(correction)-1e-9))correction=offset;
  }
  if(correction!==undefined)return rawDelta+correction;
  return (Math.round((anchors[0]+rawDelta)*options.fps)/options.fps)-anchors[0];
}

export function snapTimelineTime(rawTime:number,options:TimelineSnapOptions):number{
  return snapTimelineDelta(rawTime,[0],options);
}
