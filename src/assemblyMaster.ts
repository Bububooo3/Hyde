import {evaluateProject} from './engine';
import type {AnimProperty,Project} from './model';

export interface AssemblyMasterKey {
  id:string;instanceId:string;elementId:string;property:AnimProperty;keyIndex:number;
  scope:'shared'|'instance';time:number;value:number|string;
}
export interface AssemblyMasterRow {
  id:string;elementId:string;property:AnimProperty;partName:string;
  keys:AssemblyMasterKey[];curve:{x:number;y:number}[];
}

/** A derived timeline view: every dot points back to one real source or placed
 * key, while the read-only curve samples the actual composed evaluator. */
export function selectAssemblyMasterRows(project:Project,rootId:string,sampleCount=64):AssemblyMasterRow[]{
  const root=project.elements.find(item=>item.id===rootId);
  if(!root?.clipInstances?.length)return [];
  const rows=new Map<string,AssemblyMasterRow>();
  for(const instance of root.clipInstances){
    const clip=root.assemblyClips?.find(item=>item.id===instance.clipId);
    if(!clip)continue;
    for(const sourceTrack of clip.tracks){
      const override=instance.trackOverrides?.find(item=>item.elementId===sourceTrack.elementId&&item.property===sourceTrack.property);
      const track=override??sourceTrack;
      const id=JSON.stringify([sourceTrack.elementId,sourceTrack.property]);
      let row=rows.get(id);
      if(!row){row={id,elementId:sourceTrack.elementId,property:sourceTrack.property,
        partName:project.elements.find(item=>item.id===sourceTrack.elementId)?.name??'Part',keys:[],curve:[]};rows.set(id,row);}
      const cycles=instance.loop?Math.min(100,Math.ceil(instance.duration/clip.duration)):1;
      for(let cycle=0;cycle<cycles;cycle++)for(let index=0;index<track.keyframes.length;index++){
        const key=track.keyframes[index];
        const offset=instance.loop?cycle*clip.duration+key.time:key.time/clip.duration*instance.duration;
        if(offset>instance.duration+1e-8)continue;
        row.keys.push({id:`${instance.id}:${cycle}:${key.id}`,instanceId:instance.id,elementId:track.elementId,
          property:track.property,keyIndex:index,scope:override?'instance':'shared',
          time:root.start+instance.start+offset,value:key.value});
      }
    }
  }
  const result=[...rows.values()];
  if(!result.length)return result;
  const start=Math.max(0,root.start),end=Math.min(project.duration,root.start+root.duration);
  if(!(end>start))return result;
  const count=Math.max(2,Math.min(128,Math.round(sampleCount)));
  const frames=Array.from({length:count},(_,index)=>{
    const time=start+(end-start-1e-7)*index/(count-1);
    return {time,poses:new Map(evaluateProject(project,time).map(item=>[item.id,item]))};
  });
  for(const row of result){
    if(row.property==='fill')continue;
    const values=frames.map(frame=>frame.poses.get(row.elementId)?.[row.property]);
    const numeric=values.filter((value):value is number=>typeof value==='number'&&Number.isFinite(value));
    if(!numeric.length)continue;
    const min=Math.min(...numeric),max=Math.max(...numeric),span=max-min;
    row.curve=frames.flatMap((frame,index)=>{
      const value=values[index];
      if(typeof value!=='number'||!Number.isFinite(value))return [];
      return [{x:frame.time/project.duration*100,y:span<1e-8?12:20-(value-min)/span*16}];
    });
    row.keys.sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));
  }
  return result.sort((a,b)=>a.partName.localeCompare(b.partName)||a.property.localeCompare(b.property));
}
