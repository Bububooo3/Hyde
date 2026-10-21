import type {Asset,Project} from './model';

/** Apply a visual asset to an existing shape without replacing its geometry,
 * animation, scene ownership, or assembly attachment. */
export function applyMediaFill(project:Project,elementId:string,asset:Asset):Project{
  if(asset.kind!=='image'&&asset.kind!=='video')throw new Error('A shape fill needs an image or video.');
  if(project.assets.some(item=>item.id===asset.id))throw new Error('The media asset already exists in this project.');
  const next=structuredClone(project),element=next.elements.find(item=>item.id===elementId);
  if(!element||!['rectangle','ellipse','polygon','image','video'].includes(element.kind))throw new Error('Select a visual shape to fill.');
  next.assets.push(asset);
  element.assetId=asset.id;
  element.mediaFit='fill';
  element.mediaOpacity=1;
  return next;
}
