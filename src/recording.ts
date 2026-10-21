import type {Project} from './model';

/** A monitor mix for recording; authored mute settings remain untouched. */
export function recordingPlaybackProject(project:Project,muteExisting:boolean):Project{
  if(!muteExisting)return project;
  return {...project,elements:project.elements.map(element=>element.kind==='audio'||element.kind==='video'?{...element,muted:true}:element)};
}
