import {describe,expect,it,vi} from 'vitest';
import {createElement,createProject} from './model';
import {prepareWithSegments} from '@chenglou/pretext';
import {captureStaticTextShapeLayout,flowShapeOutline,flowSlots,insideFlowSlots,layoutInsideShapeLines,usableStaticTextFlow} from './textFlow';

// Pretext measures through a browser canvas; keep this geometry test independent
// of the DOM and verify real measurement in the browser renderer test.
vi.mock('@chenglou/pretext',()=>({
  prepareWithSegments:(content:string)=>({segments:[content],widths:[]}),
  layoutNextLine:(prepared:{segments:string[]},width:number,cursor:{segmentIndex:number;graphemeIndex:number})=>{
    const content=prepared.segments[0],start=cursor.graphemeIndex;
    if(start>=content.length)return null;
    const end=Math.min(content.length,start+Math.max(1,Math.floor(width/8)));
    return {text:content.slice(start,end),width:(end-start)*8,start:{...cursor},end:{segmentIndex:0,graphemeIndex:end}};
  },
}));

describe('text flow geometry',()=>{
  it('excludes the shape contour across a full line band and restores full width below it',()=>{
    const rectangle=[{x:60,y:10},{x:100,y:10},{x:100,y:50},{x:60,y:50}];
    expect(flowSlots(160,20,20,rectangle,8)).toEqual([{x:0,width:52},{x:108,width:52}]);
    expect(flowSlots(160,60,20,rectangle,8)).toEqual([{x:0,width:160}]);
    expect(flowSlots(160,20,20,[{x:-10,y:0},{x:170,y:0},{x:170,y:60},{x:-10,y:60}],8)).toEqual([]);
  });

  it('maps an editable curved shape into the text element’s local coordinates',()=>{
    const text=createElement('text',{id:'text',sceneId:'scene',x:0,y:0,width:200,height:100,pivotX:0,pivotY:0});
    const ellipse=createElement('ellipse',{id:'ellipse',sceneId:'scene',x:80,y:10,width:40,height:40,pivotX:0,pivotY:0});
    const outline=flowShapeOutline(text,ellipse)!;
    expect(outline.length).toBeGreaterThan(16);
    expect(Math.min(...outline.map(point=>point.x))).toBeCloseTo(80);
    expect(Math.max(...outline.map(point=>point.x))).toBeCloseTo(120);
    expect(Math.min(...outline.map(point=>point.y))).toBeCloseTo(10);
    expect(Math.max(...outline.map(point=>point.y))).toBeCloseTo(50);
    expect(flowSlots(200,20,20,outline,0)).toHaveLength(2);
  });

  it('requires a visual target in the same scene and accepts rotated shapes',()=>{
    const text=createElement('text',{id:'text',sceneId:'one',x:0,y:0,width:200,height:100,pivotX:0,pivotY:0});
    const rectangle=createElement('rectangle',{id:'shape',sceneId:'two',x:80,y:20,width:40,height:20,pivotX:0,pivotY:0,rotation:90});
    expect(flowShapeOutline(text,rectangle)).toBeNull();
    rectangle.sceneId='one';
    const outline=flowShapeOutline(text,rectangle)!;
    expect(Math.min(...outline.map(point=>point.x))).toBeCloseTo(60);
    expect(Math.max(...outline.map(point=>point.x))).toBeCloseTo(80);
    expect(Math.min(...outline.map(point=>point.y))).toBeCloseTo(20);
    expect(Math.max(...outline.map(point=>point.y))).toBeCloseTo(60);
  });

  it('offers only the contour interior throughout each complete line band',()=>{
    const rectangle=[{x:20,y:0},{x:180,y:0},{x:180,y:72},{x:20,y:72}];
    expect(insideFlowSlots(200,0,24,rectangle,8)).toEqual([{x:28,width:144}]);
    expect(insideFlowSlots(200,72,24,rectangle,8)).toEqual([]);
    const diamond=[{x:100,y:0},{x:180,y:50},{x:100,y:100},{x:20,y:50}];
    const upper=insideFlowSlots(200,20,20,diamond,0);
    expect(upper).toHaveLength(1);
    expect(upper[0].x).toBeGreaterThan(50);
    expect(upper[0].x+upper[0].width).toBeLessThan(150);
    const notched=[{x:0,y:0},{x:40,y:0},{x:40,y:40},{x:120,y:40},{x:120,y:0},{x:160,y:0},{x:160,y:100},{x:0,y:100}];
    expect(insideFlowSlots(160,10,20,notched,4)).toEqual([{x:4,width:32},{x:124,width:32}]);
  });

  it('places Pretext lines inside a shape and stops at the text box height',()=>{
    const rectangle=[{x:20,y:0},{x:180,y:0},{x:180,y:72},{x:20,y:72}];
    const prepared=prepareWithSegments('One two three four five six seven eight nine ten eleven twelve','16px sans-serif',{whiteSpace:'pre-wrap'});
    const lines=layoutInsideShapeLines(prepared,200,72,24,rectangle,8);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.every(line=>line.x>=28&&line.x+line.width<=172&&line.y<72)).toBe(true);
    expect(layoutInsideShapeLines(prepared,200,24,24,[{x:20,y:30},{x:180,y:30},{x:180,y:80},{x:20,y:80}],8)).toEqual([]);
  });

  it('captures static around-shape lines at a chosen playhead while live geometry keeps changing',()=>{
    const project=createProject(),sceneId=project.sequences[0].id;
    const shape=createElement('rectangle',{id:'shape',sceneId,x:70,y:0,width:80,height:120,pivotX:0,pivotY:0,
      tracks:[{property:'x',keyframes:[
        {id:'first',time:0,value:70,easing:'linear',direction:'in',mode:'smooth'},
        {id:'last',time:2,value:170,easing:'linear',direction:'in',mode:'smooth'},
      ]}]});
    const text=createElement('text',{id:'text',sceneId,x:0,y:0,width:320,height:180,pivotX:0,pivotY:0,
      text:'A long line of editable words follows the chosen arrangement rather than the moving outline.',
      fontSize:20,textLayout:'static',flowAroundId:'shape',textShapeMode:'around',staticLayoutWidth:320});
    project.elements.push(shape,text);
    const first=captureStaticTextShapeLayout(project,'text',0)!;
    const later=captureStaticTextShapeLayout(project,'text',2)!;
    expect(first.lines.length).toBeGreaterThan(0);
    expect(first.lines).not.toEqual(later.lines);
    text.staticTextFlow=first;
    expect(usableStaticTextFlow(text)).toBe(first);
    shape.x=230;
    expect(usableStaticTextFlow(text)).toBe(first);
    text.text+=' Edit';
    expect(usableStaticTextFlow(text)).toBeUndefined();
  });

  it('freezes the interior contour for static text and leaves the source editable',()=>{
    const project=createProject(),sceneId=project.sequences[0].id;
    const shape=createElement('rectangle',{id:'shape',sceneId,x:20,y:0,width:180,height:160,pivotX:0,pivotY:0});
    const text=createElement('text',{id:'text',sceneId,x:0,y:0,width:220,height:160,pivotX:0,pivotY:0,
      text:'Interior words fit inside the original shape.',fontSize:16,textLayout:'static',flowAroundId:'shape',textShapeMode:'inside'});
    project.elements.push(shape,text);
    const snapshot=captureStaticTextShapeLayout(project,'text',0)!;
    expect(snapshot.outline?.length).toBeGreaterThanOrEqual(4);
    text.staticTextFlow=snapshot;
    shape.x+=90;shape.width=30;
    expect(usableStaticTextFlow(text)?.outline).toEqual(snapshot.outline);
    expect(text.text).toBe(snapshot.sourceText);
    text.fontSize=24;
    expect(usableStaticTextFlow(text)).toBeUndefined();
  });
});
