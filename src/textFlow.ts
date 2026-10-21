import {layoutNextLine, prepareWithSegments} from '@chenglou/pretext';
import type {LayoutCursor, PreparedTextWithSegments} from '@chenglou/pretext';
import type {Project,StaticTextFlowSnapshot,StoryElement,TextAnimation} from './model';
import {evaluateProject} from './engine';
import {editablePathForElement, pathPointToWorld, shapePathCommands, worldToPathPoint} from './shapePath';
import type {TextUnit} from './textUnits';

export interface FlowPoint {x:number;y:number}
export interface FlowSlot {x:number;width:number}
export interface FlowLine {text:string;width:number;x:number;y:number;start:LayoutCursor;end:LayoutCursor}

/** The target and text must share a scene container; convert its actual contour
 * to text-local pixels before any line breaks are computed. */
export function flowShapeOutline(text:StoryElement,shape:StoryElement):FlowPoint[]|null{
  if(text.sceneId!==shape.sceneId||text.id===shape.id||
    !['rectangle','ellipse','polygon','image','video'].includes(shape.kind)||
    !text.width||!text.height||!text.scaleX||!text.scaleY||!shape.width||!shape.height)return null;
  const path=shape.shapePath??(shape.mediaPin?{points:shape.mediaPin.map(point=>({...point}))}:editablePathForElement(shape));
  const outline:FlowPoint[]=[];
  let previous={x:0,y:0};
  try{
    for(const command of shapePathCommands(path,shape.width,shape.height)){
      const localPoints:FlowPoint[]=[];
      if(command.type==='move'||command.type==='line')localPoints.push({x:command.x,y:command.y});
      else if(command.type==='cubic'){
        const from=previous;
        for(let step=1;step<=16;step++){
          const t=step/16,u=1-t;
          localPoints.push({
            x:u*u*u*from.x+3*u*u*t*command.x1+3*u*t*t*command.x2+t*t*t*command.x,
            y:u*u*u*from.y+3*u*u*t*command.y1+3*u*t*t*command.y2+t*t*t*command.y,
          });
        }
      }
      for(const point of localPoints){
        const world=pathPointToWorld(shape,{x:point.x/shape.width,y:point.y/shape.height});
        const normalized=worldToPathPoint(text,world);
        outline.push({x:normalized.x*text.width,y:normalized.y*text.height});
      }
      if(command.type==='move'||command.type==='line'||command.type==='cubic')previous={x:command.x,y:command.y};
    }
  }catch{return null;}
  return outline.length>=3&&outline.every(point=>Number.isFinite(point.x)&&Number.isFinite(point.y))?outline:null;
}

/** Conservative shape exclusion across the whole line band, so glyph ascenders
 * and descenders cannot intrude even when a curved edge crosses the row. */
export function flowSlots(width:number,top:number,lineHeight:number,outline:readonly FlowPoint[],gap=8):FlowSlot[]{
  const available=Math.max(1,width),bottom=top+Math.max(1,lineHeight),xs:number[]=[];
  for(let index=0;index<outline.length;index++){
    const a=outline[index],b=outline[(index+1)%outline.length];
    if(a.y>=top&&a.y<=bottom)xs.push(a.x);
    for(const y of [top,bottom]){
      if((a.y<y&&b.y>y)||(a.y>y&&b.y<y))xs.push(a.x+(b.x-a.x)*(y-a.y)/(b.y-a.y));
    }
  }
  if(!xs.length)return [{x:0,width:available}];
  const left=Math.max(0,Math.min(...xs)-Math.max(0,gap));
  const right=Math.min(available,Math.max(...xs)+Math.max(0,gap));
  if(right<=0||left>=available)return [{x:0,width:available}];
  const minimum=Math.min(available/3,Math.max(8,lineHeight*.65));
  const slots:FlowSlot[]=[];
  if(left>=minimum)slots.push({x:0,width:left});
  if(available-right>=minimum)slots.push({x:right,width:available-right});
  return slots;
}

/** Intersect the interior spans at every contour change through a glyph band.
 * A slot is offered only where the whole line height remains inside the shape. */
export function insideFlowSlots(width:number,top:number,lineHeight:number,outline:readonly FlowPoint[],gap=8):FlowSlot[]{
  if(outline.length<3||width<=0||lineHeight<=0)return [];
  const bottom=top+lineHeight,epsilon=Math.min(.01,lineHeight/1000);
  const samples=[top+epsilon,(top+bottom)/2,bottom-epsilon];
  for(const point of outline)if(point.y>top&&point.y<bottom){
    samples.push(Math.max(top+epsilon,point.y-epsilon),Math.min(bottom-epsilon,point.y+epsilon));
  }
  let common:FlowSlot[]=[{x:0,width}];
  for(const y of samples){
    const crossings:number[]=[];
    for(let index=0;index<outline.length;index++){
      const a=outline[index],b=outline[(index+1)%outline.length];
      if((a.y<=y&&b.y>y)||(b.y<=y&&a.y>y))crossings.push(a.x+(b.x-a.x)*(y-a.y)/(b.y-a.y));
    }
    crossings.sort((a,b)=>a-b);
    const spans:FlowSlot[]=[];
    for(let index=0;index+1<crossings.length;index+=2){
      const left=Math.max(0,crossings[index]),right=Math.min(width,crossings[index+1]);
      if(right>left)spans.push({x:left,width:right-left});
    }
    const next:FlowSlot[]=[];
    for(const a of common)for(const b of spans){
      const left=Math.max(a.x,b.x),right=Math.min(a.x+a.width,b.x+b.width);
      if(right>left)next.push({x:left,width:right-left});
    }
    common=next;
    if(!common.length)return [];
  }
  const inset=Math.max(0,gap),minimum=Math.min(width/3,Math.max(8,lineHeight*.65));
  return common.map(slot=>({x:slot.x+inset,width:slot.width-inset*2}))
    .filter(slot=>slot.width>=minimum);
}

/** Pretext streams one line at a time into the available left/right fragments.
 * Its cursor carries source identity across changes in the shape contour. */
export function layoutFlowLines(prepared:PreparedTextWithSegments,width:number,lineHeight:number,outline:readonly FlowPoint[],gap=8):FlowLine[]{
  const result:FlowLine[]=[],maxY=Math.max(0,...outline.map(point=>point.y));
  const maxRows=Math.min(10000,Math.max(100,Math.ceil(maxY/Math.max(1,lineHeight))+prepared.segments.length*4+10));
  let cursor:LayoutCursor={segmentIndex:0,graphemeIndex:0};
  for(let row=0;row<maxRows;row++){
    for(const slot of flowSlots(width,row*lineHeight,lineHeight,outline,gap)){
      const line=layoutNextLine(prepared,slot.width,cursor);
      if(!line)return result;
      result.push({...line,x:slot.x,y:row*lineHeight});
      if(line.end.segmentIndex===cursor.segmentIndex&&line.end.graphemeIndex===cursor.graphemeIndex)return result;
      cursor=line.end;
    }
  }
  return result;
}

/** Unlike outside flow, lines cannot continue below the text box or shape. */
export function layoutInsideShapeLines(prepared:PreparedTextWithSegments,width:number,height:number,lineHeight:number,outline:readonly FlowPoint[],gap=8):FlowLine[]{
  const result:FlowLine[]=[];
  const maxRows=Math.min(10000,Math.max(0,Math.floor(height/Math.max(1,lineHeight))));
  let cursor:LayoutCursor={segmentIndex:0,graphemeIndex:0};
  for(let row=0;row<maxRows;row++){
    for(const slot of insideFlowSlots(width,row*lineHeight,lineHeight,outline,gap)){
      const line=layoutNextLine(prepared,slot.width,cursor);
      if(!line)return result;
      result.push({...line,x:slot.x,y:row*lineHeight});
      if(line.end.segmentIndex===cursor.segmentIndex&&line.end.graphemeIndex===cursor.graphemeIndex)return result;
      cursor=line.end;
    }
  }
  return result;
}

/** Capture a shape-aware arrangement at one project-clock position. The snapshot
 * is project data, so playback, reopening, and standalone export need no DOM
 * history or renderer cache to reproduce its line positions. */
export function captureStaticTextShapeLayout(project:Project,textId:string,time:number):StaticTextFlowSnapshot|undefined{
  const source=project.elements.find(element=>element.id===textId&&element.kind==='text');
  if(!source||source.textLayout!=='static'||!source.flowAroundId)return undefined;
  const mode=source.textShapeMode??'around';
  if(mode==='clip')return undefined;
  const target=project.elements.find(element=>element.id===source.flowAroundId);
  if(!target)return undefined;
  const at=Number.isFinite(time)?Math.max(0,Math.min(project.duration,time)):0;
  const poses=evaluateProject(project,at),activeText=poses.find(element=>element.id===textId),activeTarget=poses.find(element=>element.id===target.id);
  // If either item is outside its active interval, use the authored pair rather
  // than mixing two different coordinate frames.
  const outline=flowShapeOutline(activeText&&activeTarget?activeText:source,activeText&&activeTarget?activeTarget:target);
  if(!outline)return undefined;
  const sourceText=source.text??'',fontFamily=source.fontFamily||'Georgia',fontSize=Math.max(1,source.fontSize??40);
  const layoutWidth=Math.max(1,Number.isFinite(source.staticLayoutWidth)?source.staticLayoutWidth!:source.width);
  const prepared=prepareWithSegments(sourceText,`${fontSize}px ${fontFamily}`,{whiteSpace:'pre-wrap'});
  const lines=mode==='inside'
    ?layoutInsideShapeLines(prepared,layoutWidth,source.height,fontSize*1.2,outline,Math.max(6,fontSize*.2))
    :layoutFlowLines(prepared,layoutWidth,fontSize*1.2,outline,Math.max(6,fontSize*.2));
  return {mode,sourceText,fontFamily,fontSize,layoutWidth,capturedAt:at,
    lines:lines.map(line=>({...line,start:{...line.start},end:{...line.end}})),
    ...(mode==='inside'?{outline:outline.map(point=>({...point}))}:{}),
  };
}

export function usableStaticTextFlow(element:StoryElement):StaticTextFlowSnapshot|undefined{
  const snapshot=element.staticTextFlow,mode=element.textShapeMode??'around';
  if(element.kind!=='text'||element.textLayout!=='static'||!element.flowAroundId||!snapshot||mode==='clip'||snapshot.mode!==mode)return undefined;
  const width=Math.max(1,Number.isFinite(element.staticLayoutWidth)?element.staticLayoutWidth!:element.width);
  if(mode==='inside'&&!snapshot.outline?.length)return undefined;
  if(snapshot.sourceText!==(element.text??'')||snapshot.fontFamily!==(element.fontFamily||'Georgia')||
    snapshot.fontSize!==Math.max(1,element.fontSize??40)||snapshot.layoutWidth!==width)return undefined;
  return snapshot;
}

function cursorOffset(prepared:PreparedTextWithSegments,cursor:LayoutCursor):number{
  let offset=0;
  for(let index=0;index<cursor.segmentIndex;index++)offset+=prepared.segments[index]?.length??0;
  if(cursor.graphemeIndex>0&&cursor.segmentIndex<prepared.segments.length){
    let index=0;
    for(const item of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(prepared.segments[cursor.segmentIndex])){
      if(index++>=cursor.graphemeIndex)break;
      offset+=item.segment.length;
    }
  }
  return offset;
}

function measuredWidth(text:string,font:string):number{
  if(!text)return 0;
  const prepared=prepareWithSegments(text,font,{whiteSpace:'pre-wrap'});
  let width=0;
  for(let index=0;index<prepared.widths.length;index++)width+=prepared.widths[index];
  return width;
}

export function flowTextUnits(prepared:PreparedTextWithSegments,lines:readonly FlowLine[],font:string,lineHeight:number,unit:TextAnimation['unit']):TextUnit[]{
  if(unit==='line')return lines.map(line=>({id:`line:${cursorOffset(prepared,line.start)}`,text:line.text,x:line.x,y:line.y,width:line.width,height:lineHeight}));
  const units:TextUnit[]=[];
  for(const line of lines){
    const sourceStart=cursorOffset(prepared,line.start);
    for(const match of line.text.matchAll(/\S+/gu)){
      const text=match[0],index=match.index;
      units.push({id:`word:${sourceStart+index}`,text,x:line.x+measuredWidth(line.text.slice(0,index),font),y:line.y,width:measuredWidth(text,font),height:lineHeight});
    }
  }
  return units;
}
