import type {PlacementFrame,Project,Sequence} from './model';

export interface FramePoint {x:number;y:number}
/** SVG/Pixi-compatible affine matrix: x' = ax + cy + e, y' = bx + dy + f. */
export interface FrameAffine {a:number;b:number;c:number;d:number;e:number;f:number}
const identity:FrameAffine={a:1,b:0,c:0,d:1,e:0,f:0};

function compose(outer:FrameAffine,inner:FrameAffine):FrameAffine{
  return {
    a:outer.a*inner.a+outer.c*inner.b,
    b:outer.b*inner.a+outer.d*inner.b,
    c:outer.a*inner.c+outer.c*inner.d,
    d:outer.b*inner.c+outer.d*inner.d,
    e:outer.a*inner.e+outer.c*inner.f+outer.e,
    f:outer.b*inner.e+outer.d*inner.f+outer.f,
  };
}

/** Map source-stage coordinates into a placement viewport without accidental stretching. */
export function sceneFrameTransform(project:Pick<Project,'width'|'height'>,scene:Pick<PlacementFrame,'frame'|'frameFit'>){
  const frame=scene.frame;
  if(!frame)return {x:0,y:0,scaleX:1,scaleY:1};
  const horizontal=frame.width/project.width,vertical=frame.height/project.height;
  const scale=scene.frameFit==='fill'?Math.max(horizontal,vertical):Math.min(horizontal,vertical);
  const scaleX=scene.frameFit==='stretch'?horizontal:scale;
  const scaleY=scene.frameFit==='stretch'?vertical:scale;
  return {
    x:frame.x+(frame.width-project.width*scaleX)/2,
    y:frame.y+(frame.height-project.height*scaleY)/2,
    scaleX,scaleY,
  };
}

/** Fit/fill/stretch first, then rotate the complete viewport around its center.
 * The same transform is used for hit testing, SVG guides, and renderer layers. */
export function sceneFrameAffine(project:Pick<Project,'width'|'height'>,scene:PlacementFrame):FrameAffine{
  if(!scene.frame)return {...identity};
  const base=sceneFrameTransform(project,scene),frame=scene.frame;
  const angle=(scene.frameRotation??0)*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
  const centerX=frame.x+frame.width/2,centerY=frame.y+frame.height/2;
  return {
    a:cos*base.scaleX,b:sin*base.scaleX,c:-sin*base.scaleY,d:cos*base.scaleY,
    e:centerX+cos*(base.x-centerX)-sin*(base.y-centerY),
    f:centerY+sin*(base.x-centerX)+cos*(base.y-centerY),
  };
}

/** Frames from outermost to innermost. Linked originals contribute content and
 * camera, while linked placements contribute their own visible viewport. */
export function sceneVisualFrames(project:Pick<Project,'sequences'>,scene:Sequence):PlacementFrame[]{
  const frames:PlacementFrame[]=[scene,...(scene.frameStack??[])];
  const visited=new Set<string>([scene.id]);
  let current=scene;
  while(current.sourceSceneId){
    const source=project.sequences.find(item=>item.id===current.sourceSceneId);
    if(!source||visited.has(source.id)||!source.sourceSceneId)break;
    visited.add(source.id);
    frames.push(source,...(source.frameStack??[]));
    current=source;
  }
  return frames;
}

/** Stage-space transform for a placed scene, including the frames of linked sources. */
export function composedSceneFrameTransform(project:Project,scene:Sequence){
  let result={x:0,y:0,scaleX:1,scaleY:1};
  for(const viewport of sceneVisualFrames(project,scene)){
    const frame=sceneFrameTransform(project,viewport);
    result={x:result.x+frame.x*result.scaleX,y:result.y+frame.y*result.scaleY,
      scaleX:result.scaleX*frame.scaleX,scaleY:result.scaleY*frame.scaleY};
  }
  return result;
}

export function composedSceneFrameAffine(project:Project,scene:Sequence):FrameAffine{
  return sceneVisualFrames(project,scene).reduce((result,viewport)=>compose(result,sceneFrameAffine(project,viewport)),identity);
}

/** Keep editor hit targets usable even when nested nonuniform frames shear. */
export function sceneFrameMinimumScale(project:Project,scene:Sequence):number{
  const {a,b,c,d}=composedSceneFrameAffine(project,scene);
  const trace=a*a+b*b+c*c+d*d,det=(a*d-b*c)**2;
  return Math.max(1e-6,Math.sqrt(Math.max(0,(trace-Math.sqrt(Math.max(0,trace*trace-4*det)))/2)));
}

/** Source-stage point -> positioned scene-stage point. Camera mapping is separate. */
export function mapSceneFramePoint(project:Project,scene:Sequence,point:FramePoint):FramePoint{
  const matrix=composedSceneFrameAffine(project,scene);
  return {x:matrix.a*point.x+matrix.c*point.y+matrix.e,y:matrix.b*point.x+matrix.d*point.y+matrix.f};
}

/** Inverse used by pointer gestures and frame-aware stage selection. */
export function unmapSceneFramePoint(project:Project,scene:Sequence,point:FramePoint):FramePoint{
  const matrix=composedSceneFrameAffine(project,scene),det=matrix.a*matrix.d-matrix.b*matrix.c;
  if(Math.abs(det)<1e-12)throw new RangeError('A scene frame cannot have zero scale.');
  const x=point.x-matrix.e,y=point.y-matrix.f;
  return {x:(matrix.d*x-matrix.c*y)/det,y:(-matrix.b*x+matrix.a*y)/det};
}

export function sceneFrameSvgTransform(project:Project,scene:Sequence):string{
  const {a,b,c,d,e,f}=composedSceneFrameAffine(project,scene);
  return `matrix(${a} ${b} ${c} ${d} ${e} ${f})`;
}
