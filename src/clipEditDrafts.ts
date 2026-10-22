import {openDB,type DBSchema} from 'idb';
import type {Project,StoryElement} from './model';

export type ClipEditKind='assembly'|'structure'|'media';
export interface SavedClipDraft {
  projectId:string;
  baseUpdatedAt:string;
  kind:ClipEditKind;
  targetId:string;
  elements:StoryElement[];
  duration:number;
  savedAt:number;
}

export class ClipDraftConflictError extends Error {
  constructor(){super('An unfinished clip edit from another project revision is already in browser recovery. Recover or discard it before starting a new edit.');}
}

interface DraftDatabase extends DBSchema {
  drafts:{key:string;value:SavedClipDraft};
}
const tombstone=(projectId:string)=>`hyde:discarded-clip-draft:${projectId}`;
function ignored(projectId:string){try{return localStorage.getItem(tombstone(projectId))==='yes';}catch{return false;}}
function markIgnored(projectId:string,value:boolean){try{if(value)localStorage.setItem(tombstone(projectId),'yes');else localStorage.removeItem(tombstone(projectId));}catch{/* Browser storage may be disabled. */}}

async function database(){
  return openDB<DraftDatabase>('hyde-edit-drafts',1,{upgrade(db){db.createObjectStore('drafts');}});
}

// Serialize writes so a slower edit cannot replace a newer draft or revive a
// draft after Apply/Discard has removed it.
let pending:Promise<unknown>=Promise.resolve();
let operation=0;
const latestOperation=new Map<string,number>();
function enqueue(work:()=>Promise<void>):Promise<void>{
  const result=pending.catch(()=>undefined).then(work);
  pending=result;
  return result;
}

export function saveClipDraft(base:Project,draft:Project,kind:ClipEditKind,targetId:string):Promise<void>{
  const snapshot:SavedClipDraft={projectId:base.id,baseUpdatedAt:base.updatedAt,kind,targetId,elements:structuredClone(draft.elements),duration:draft.duration,savedAt:Date.now()};
  const number=++operation;latestOperation.set(base.id,number);
  return enqueue(async()=>{const db=await database();try{
    const existing=await db.get('drafts',base.id);
    if(existing&&existing.baseUpdatedAt!==base.updatedAt)throw new ClipDraftConflictError();
    await db.put('drafts',snapshot,base.id);
    if(latestOperation.get(base.id)===number)markIgnored(base.id,false);
  }finally{db.close();}});
}

export async function loadClipDraft(projectId:string):Promise<SavedClipDraft|undefined>{
  await pending.catch(()=>undefined);
  if(ignored(projectId))return undefined;
  const db=await database();
  try{return await db.get('drafts',projectId);}finally{db.close();}
}

export function deleteClipDraft(projectId:string):Promise<void>{
  const number=++operation;latestOperation.set(projectId,number);
  markIgnored(projectId,true);
  return enqueue(async()=>{const db=await database();try{await db.delete('drafts',projectId);if(latestOperation.get(projectId)===number)markIgnored(projectId,false);}finally{db.close();}});
}

export function restoreClipDraft(base:Project,saved:SavedClipDraft):Project{
  if(saved.projectId!==base.id||saved.baseUpdatedAt!==base.updatedAt)throw new Error('The unfinished clip edit belongs to a different project revision.');
  return clipDraftProject(base,saved);
}

function clipDraftProject(base:Project,saved:SavedClipDraft):Project{
  if(!saved.elements.some(element=>element.id===saved.targetId))throw new Error('The unfinished clip target is missing.');
  if(!Number.isFinite(saved.duration)||saved.duration<=0)throw new Error('The unfinished clip duration is invalid.');
  return {...structuredClone(base),elements:structuredClone(saved.elements),duration:saved.duration};
}

/** A stale draft is opened as an unapplied session on a separate project copy. */
export function recoverClipDraftCopy(current:Project,saved:SavedClipDraft,newId:string):{base:Project;draft:Project}{
  if(saved.projectId!==current.id)throw new Error('The unfinished clip edit belongs to a different project.');
  const base={...structuredClone(current),id:newId,name:`${current.name} (recovered clip edit)`,updatedAt:new Date().toISOString()};
  return {base,draft:clipDraftProject(base,saved)};
}
