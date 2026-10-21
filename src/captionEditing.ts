import {sceneIdAt,uid,type Caption,type Project} from './model';

const frameTime=(seconds:number,fps:number)=>Math.round(seconds*fps)/fps;

/** Caption edits are project operations shared by the editor and future tooling. */
export function addCaption(project:Project,at:number):{project:Project;caption:Caption}{
  const sceneId=sceneIdAt(project,Math.max(0,Math.min(at,project.duration-1/project.fps)));
  const scene=project.sequences.find(item=>item.id===sceneId);
  if(!scene)throw new Error('Move the playhead into a scene before adding a caption.');
  const frame=1/project.fps,end=scene.start+scene.duration;
  const start=Math.min(Math.max(scene.start,frameTime(at,project.fps)),end-frame);
  const caption:Caption={id:uid(),sceneId:scene.id,start,end:Math.min(end,start+Math.max(frame,frameTime(2,project.fps))),text:'Caption'};
  return {project:{...project,captions:[...project.captions,caption]},caption};
}

export function editCaption(project:Project,id:string,patch:Partial<Pick<Caption,'text'|'start'|'end'|'sceneId'>>):Project{
  const current=project.captions.find(item=>item.id===id);
  if(!current)throw new Error('Caption no longer exists.');
  const scene=project.sequences.find(item=>item.id===(patch.sceneId??current.sceneId));
  if(!scene)throw new Error('Choose an existing scene for this caption.');
  const frame=1/project.fps,sceneEnd=scene.start+scene.duration;
  let start=patch.start===undefined?current.start:frameTime(patch.start,project.fps);
  let end=patch.end===undefined?current.end:frameTime(patch.end,project.fps);
  if(patch.sceneId!==undefined&&patch.sceneId!==current.sceneId){
    const previous=project.sequences.find(item=>item.id===current.sceneId);
    const offset=current.start-(previous?.start??0),length=current.end-current.start;
    start=frameTime(scene.start+offset,project.fps);end=frameTime(start+length,project.fps);
  }
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<scene.start-1e-7||end>sceneEnd+1e-7||end-start<frame-1e-7)
    throw new Error('Caption timing must stay inside its scene and last at least one frame.');
  const next={...current,...patch,sceneId:scene.id,start,end};
  return {...project,captions:project.captions.map(item=>item.id===id?next:item)};
}

export function deleteCaption(project:Project,id:string):Project{
  return {...project,captions:project.captions.filter(item=>item.id!==id)};
}
