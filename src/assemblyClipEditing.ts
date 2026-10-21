import {trackValue} from './engine';
import {uid,type AnimProperty,type AssemblyAnimationClip,type AssemblyClipTrack,type AssemblyClipInstance,type Keyframe,type Project,type StoryElement} from './model';

export type AssemblyKeyPatch=Partial<Pick<Keyframe,'time'|'value'|'easing'|'direction'|'mode'|'steps'|'switchPoint'>>;
export interface AssemblyTrackTarget {rootId:string;clipId:string;instanceId?:string;elementId:string;property:AnimProperty}

function findTarget(project:Project,target:AssemblyTrackTarget):{root:StoryElement;clip:AssemblyAnimationClip;instance?:AssemblyClipInstance;track:AssemblyClipTrack}{
  const root=project.elements.find(item=>item.id===target.rootId);
  const clip=root?.assemblyClips?.find(item=>item.id===target.clipId);
  const instance=target.instanceId?root?.clipInstances?.find(item=>item.id===target.instanceId):undefined;
  if(!root||!clip||(target.instanceId&&(!instance||instance.clipId!==clip.id)))throw new Error('The assembly clip no longer exists.');
  const track=clip.tracks.find(item=>item.elementId===target.elementId&&item.property===target.property);
  if(!track)throw new Error('The assembly clip does not animate this part and property.');
  return {root,clip,instance,track};
}

/** The effective keyed track for a placed clip, with source fallback. */
export function assemblyTrackView(project:Project,target:AssemblyTrackTarget):{track:AssemblyClipTrack;isOverride:boolean;duration:number}{
  const {clip,instance,track}=findTarget(project,target);
  const override=instance?.trackOverrides?.find(item=>item.elementId===target.elementId&&item.property===target.property);
  return {track:override??track,isOverride:!!override,duration:clip.duration};
}

function mutableTrack(project:Project,target:AssemblyTrackTarget):{next:Project;track:AssemblyClipTrack;duration:number}{
  findTarget(project,target);
  const next=structuredClone(project);
  const {clip,instance,track}=findTarget(next,target);
  if(!instance)return {next,track,duration:clip.duration};
  let override=instance.trackOverrides?.find(item=>item.elementId===target.elementId&&item.property===target.property);
  if(!override){
    override={...structuredClone(track),keyframes:track.keyframes.map(key=>({...key,id:uid()}))};
    instance.trackOverrides=[...(instance.trackOverrides??[]),override];
  }
  return {next,track:override,duration:clip.duration};
}

function validValue(project:Project,property:AnimProperty,value:number|string):void{
  if(property==='fill'){
    if(typeof value!=='string'||!(/^(?:transparent|#[0-9a-f]{3,4}|#[0-9a-f]{6}(?:[0-9a-f]{2})?|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*[\d.]+)?\s*\))$/i.test(value)))throw new Error('Choose a valid fill color.');
  }else if(property==='assetId'){
    if(typeof value!=='string'||(value!==''&&!project.assets.some(asset=>asset.id===value&&(asset.kind==='image'||asset.kind==='video'))))
      throw new Error('Choose an image or video asset in this project.');
  }else if(typeof value!=='number'||!Number.isFinite(value))throw new Error('Enter a finite keyframe value.');
}

function alignedTime(value:number,fps:number,duration:number):number{
  if(!Number.isFinite(value)||value<0||value>duration)throw new Error('Keyframe time must be inside the clip.');
  return Math.min(duration,Math.round(value*fps)/fps);
}

function checkDistinct(track:AssemblyClipTrack):void{
  const times=track.keyframes.map(key=>key.time).sort((a,b)=>a-b);
  if(times.some((time,index)=>index>0&&Math.abs(time-times[index-1])<1e-8))throw new Error('Only one keyframe is allowed at each clip time.');
  track.keyframes.sort((a,b)=>a.time-b.time);
}

export function editAssemblyClipKey(project:Project,target:AssemblyTrackTarget,keyIndex:number,patch:AssemblyKeyPatch):Project{
  const {next,track,duration}=mutableTrack(project,target);
  const key=track.keyframes[keyIndex];
  if(!key)throw new Error('The assembly keyframe no longer exists.');
  if(patch.time!==undefined)key.time=alignedTime(patch.time,project.fps,duration);
  if(patch.value!==undefined){validValue(project,target.property,patch.value);key.value=patch.value;}
  if(patch.easing!==undefined){if(!['linear','sine','quad','cubic','quart','quint','expo','circ','back','bounce','elastic'].includes(patch.easing))throw new Error('Choose a valid easing family.');key.easing=patch.easing;}
  if(patch.direction!==undefined){if(!['in','out','inOut'].includes(patch.direction))throw new Error('Choose a valid easing direction.');key.direction=patch.direction;}
  if(patch.mode!==undefined){if(!['smooth','hold','stepped'].includes(patch.mode))throw new Error('Choose a valid interpolation mode.');key.mode=patch.mode;}
  if(patch.steps!==undefined){if(!Number.isInteger(patch.steps)||patch.steps<1||patch.steps>120)throw new Error('Stepped cadence must be from 1 to 120.');key.steps=patch.steps;}
  if(patch.switchPoint!==undefined){
    if(target.property!=='assetId'||!Number.isFinite(patch.switchPoint)||patch.switchPoint<0||patch.switchPoint>1)
      throw new Error('Texture switch point must be between zero and one.');
    key.switchPoint=patch.switchPoint;
  }
  checkDistinct(track);next.updatedAt=new Date().toISOString();return next;
}

export function addAssemblyClipKey(project:Project,target:AssemblyTrackTarget,time:number):Project{
  const {next,track,duration}=mutableTrack(project,target);
  const at=alignedTime(time,project.fps,duration);
  if(track.keyframes.some(key=>Math.abs(key.time-at)<1e-8))throw new Error('A keyframe already exists at this clip time.');
  const value=trackValue(track,at);
  if(value===undefined)throw new Error('This clip track has no value to key.');
  validValue(project,target.property,value);
  track.keyframes.push({id:uid(),time:at,value,easing:'linear',direction:'inOut',mode:'smooth'});
  checkDistinct(track);next.updatedAt=new Date().toISOString();return next;
}

export function removeAssemblyClipKey(project:Project,target:AssemblyTrackTarget,keyIndex:number):Project{
  const {next,track}=mutableTrack(project,target);
  if(track.keyframes.length<=1)throw new Error('An assembly clip track needs at least one keyframe.');
  if(keyIndex<0||keyIndex>=track.keyframes.length)throw new Error('The assembly keyframe no longer exists.');
  track.keyframes.splice(keyIndex,1);next.updatedAt=new Date().toISOString();return next;
}

export function resetAssemblyClipTrackOverride(project:Project,target:AssemblyTrackTarget):Project{
  const {instance}=findTarget(project,target);
  if(!instance?.trackOverrides?.some(track=>track.elementId===target.elementId&&track.property===target.property))return project;
  const next=structuredClone(project);
  const nextInstance=next.elements.find(item=>item.id===target.rootId)!.clipInstances!.find(item=>item.id===target.instanceId)!;
  nextInstance.trackOverrides=nextInstance.trackOverrides!.filter(track=>track.elementId!==target.elementId||track.property!==target.property);
  if(!nextInstance.trackOverrides.length)delete nextInstance.trackOverrides;
  next.updatedAt=new Date().toISOString();return next;
}
