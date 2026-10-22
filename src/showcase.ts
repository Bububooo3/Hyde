import {createElement,createProject,type Keyframe,type Project,type StoryElement} from './model';

const svgAsset=(id:string,name:string,source:string)=>({id,name,kind:'image' as const,mime:'image/svg+xml',dataUrl:`data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`});
const key=(id:string,time:number,value:number|string):Keyframe=>({id,time,value,easing:'sine',direction:'inOut',mode:'smooth'});

function chimeWav():string {
  const rate=22050,seconds=3.6,count=Math.round(rate*seconds),bytes=new Uint8Array(44+count*2),view=new DataView(bytes.buffer);
  const word=(offset:number,value:string)=>{for(let index=0;index<value.length;index++)bytes[offset+index]=value.charCodeAt(index);};
  word(0,'RIFF');view.setUint32(4,bytes.length-8,true);word(8,'WAVE');word(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  word(36,'data');view.setUint32(40,count*2,true);
  const notes=[{at:0,f:392},{at:.8,f:493.88},{at:1.6,f:587.33},{at:2.4,f:784}];
  for(let index=0;index<count;index++){
    const time=index/rate;
    const sample=notes.reduce((sum,note)=>{
      const local=time-note.at;
      if(local<0||local>1.1)return sum;
      const envelope=Math.min(1,local/.025)*Math.exp(-local*4.4);
      return sum+envelope*(Math.sin(2*Math.PI*note.f*local)+.3*Math.sin(2*Math.PI*note.f*2*local));
    },0)*.17;
    view.setInt16(44+index*2,Math.round(Math.max(-1,Math.min(1,sample))*32767),true);
  }
  let binary='';for(let index=0;index<bytes.length;index+=8192)binary+=String.fromCharCode(...bytes.subarray(index,index+8192));
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function lantern(sceneId:string,at:number,x:number,y:number,prefix:string,flight=false):StoryElement[]{
  const length=flight?6:6;
  const root=createElement('group',{id:`${prefix}-assembly`,name:'Paper lantern · assembly',sceneId,x,y,width:180,height:210,start:at,duration:length,section:'Lantern assembly'});
  const body=createElement('rectangle',{id:`${prefix}-body`,name:'Glowing paper shell',sceneId,parentId:root.id,x:0,y:0,width:145,height:176,fill:'#ffbd65',assetId:'lantern-paper',stroke:'#874c39',strokeWidth:3,shadow:{enabled:true,color:'#ff9d4b',blur:22,x:0,y:5},start:at,duration:length,section:'Lantern assembly'});
  const lid=createElement('polygon',{id:`${prefix}-lid`,name:'Hinged roof',sceneId,attachment:{type:'hinge',parentId:body.id,min:-24,max:24},x:0,y:-92,width:170,height:42,pivotY:1,fill:'#f4d49a',stroke:'#874c39',strokeWidth:3,points:[{x:0,y:36},{x:85,y:0},{x:170,y:36}],start:at,duration:length,section:'Lantern assembly'});
  const window=createElement('ellipse',{id:`${prefix}-window`,name:'Warm window',sceneId,parentId:body.id,x:0,y:1,width:72,height:112,fill:'#fff1c7',opacity:.84,stroke:'#cc7853',strokeWidth:2,start:at,duration:length,section:'Lantern assembly'});
  const ribbon=createElement('rectangle',{id:`${prefix}-ribbon`,name:'Sliding ribbon',sceneId,attachment:{type:'slider',parentId:body.id,min:-18,max:18},x:0,y:94,width:12,height:62,fill:'#f7e7bd',start:at,duration:length,section:'Lantern assembly'});
  root.assemblyClips=[{id:`${prefix}-breathe`,name:'Lantern breath',duration:4,tracks:[
    {elementId:lid.id,property:'rotation',keyframes:[key(`${prefix}-roof-0`,0,-15),key(`${prefix}-roof-1`,2,18),key(`${prefix}-roof-2`,4,-15)]},
    {elementId:ribbon.id,property:'x',keyframes:[key(`${prefix}-ribbon-0`,0,-12),key(`${prefix}-ribbon-1`,2,15),key(`${prefix}-ribbon-2`,4,-12)]},
    {elementId:window.id,property:'opacity',keyframes:[key(`${prefix}-glow-0`,0,.65),key(`${prefix}-glow-1`,2,1),key(`${prefix}-glow-2`,4,.65)]},
  ]}];
  root.clipInstances=[{id:`${prefix}-breath-1`,clipId:`${prefix}-breathe`,start:flight?0:.8,duration:4,loop:flight}];
  if(flight)root.motionBehaviors=[{id:`${prefix}-flight-path`,enabled:true,type:'followPath',start:0,duration:5.5,points:[{x:0,y:0,out:{x:45,y:-15}},{x:170,y:-140,in:{x:90,y:-70},out:{x:215,y:-200}},{x:420,y:-250,in:{x:335,y:-240}}],loop:false,orient:false,easing:'sine',direction:'inOut'}];
  return [root,body,lid,window,ribbon];
}

/** A self-contained primary story. It exercises the same editable project
 * model, renderer, audio graph and export paths as an authored user project. */
export function createPrimaryShowcase():Project {
  const project=createProject('The lantern keeper');
  project.width=960;project.height=540;project.fps=30;project.duration=12;project.background='#102638';
  const opening=project.sequences[0];opening.id='showcase-workshop';opening.name='01 · A small beginning';opening.start=0;opening.duration=6;opening.color='#ffbd65';
  opening.camera={x:480,y:270,zoom:1,rotation:0,tracks:[{property:'zoom',keyframes:[key('desk-camera-0',0,1),key('desk-camera-1',6,1.1)]}]};
  const flight={id:'showcase-flight',name:'02 · Across the night',start:6,duration:6,color:'#5a9e9e',camera:{x:480,y:270,zoom:1,rotation:0,tracks:[
    {property:'x' as const,keyframes:[key('sky-camera-x0',0,480),key('sky-camera-x1',6,575)]},
    {property:'zoom' as const,keyframes:[key('sky-camera-z0',0,1),key('sky-camera-z1',6,1.16)]},
  ]}};
  project.sequences.push(flight);
  project.sequences.push({id:'showcase-memory',name:'The beginning · inset',start:8,duration:3,color:'#f4d49a',sourceSceneId:opening.id,sourceIn:.5,sourceOut:3.5,frame:{x:660,y:56,width:255,height:144},frameFit:'fill',opacity:.9,muted:true});
  project.assets.push(svgAsset('map-paper','Map paper.svg','<svg xmlns="http://www.w3.org/2000/svg" width="300" height="320"><rect width="300" height="320" fill="#dcc39a"/><path d="M20 40Q150 0 290 70M0 132Q150 96 300 171M20 250Q170 220 280 280" fill="none" stroke="#93775d" stroke-opacity=".4" stroke-width="10"/><path d="M0 0H300V320H0Z" fill="none" stroke="#fff1c7" stroke-opacity=".3" stroke-width="20"/></svg>'));
  project.assets.push(svgAsset('lantern-paper','Lantern paper.svg','<svg xmlns="http://www.w3.org/2000/svg" width="145" height="176"><rect width="145" height="176" fill="#ffbd65"/><path d="M20 0V176M48 0V176M76 0V176M104 0V176M132 0V176" stroke="#e18d55" stroke-opacity=".45" stroke-width="4"/><path d="M0 28H145M0 150H145" stroke="#fff1c7" stroke-opacity=".6" stroke-width="7"/></svg>'));
  project.assets.push({id:'keeper-chime',name:'Lantern chimes.wav',kind:'audio',mime:'audio/wav',dataUrl:chimeWav(),duration:3.6});
  const art=(kind:StoryElement['kind'],values:Partial<StoryElement>)=>createElement(kind,values);
  project.elements.push(
    art('rectangle',{id:'desk-sky',name:'Workshop dusk',sceneId:opening.id,x:480,y:270,width:960,height:540,fill:'#163146',start:0,duration:6,optimize:'static',section:'Workshop'}),
    art('ellipse',{id:'desk-halo',name:'Warm light halo',sceneId:opening.id,x:665,y:265,width:350,height:350,fill:'#9e765a',opacity:.5,start:0,duration:6,optimize:'static',section:'Workshop'}),
    art('rectangle',{id:'desk-table',name:'Wooden worktable',sceneId:opening.id,x:480,y:472,width:960,height:136,fill:'#52463f',start:0,duration:6,optimize:'static',section:'Workshop'}),
    art('rectangle',{id:'desk-map',name:'Curved paper map',sceneId:opening.id,x:258,y:340,width:300,height:236,fill:'#dcc39a',assetId:'map-paper',stroke:'#f5dfb0',strokeWidth:3,shapePath:{points:[{x:.08,y:.04,out:{x:.4,y:-.02}},{x:.94,y:.06,out:{x:1.06,y:.35}},{x:.9,y:.93,out:{x:.5,y:1.05}},{x:.07,y:.88,out:{x:-.02,y:.55}}]},start:0,duration:6,section:'Workshop'}),
    ...lantern(opening.id,0,657,303,'desk'),
    art('text',{id:'desk-heading',name:'Opening title',sceneId:opening.id,x:278,y:122,width:465,height:112,pivotX:0,pivotY:0,text:'THE LANTERN\nKEEPER',fontFamily:'Inter',fontSize:45,fill:'#fff1d2',textAnimation:{unit:'word',effect:'reveal',direction:'in',start:0,duration:.55,stagger:.22,easing:'sine',easingDirection:'out',distance:36,seed:7,amplitude:9,frequency:1},start:0,duration:6,section:'Story text'}),
    art('text',{id:'desk-subtitle',name:'Opening line',sceneId:opening.id,x:283,y:232,width:310,height:52,pivotX:0,pivotY:0,text:'One light begins a journey.',fontFamily:'Inter',fontSize:20,fill:'#f6ddad',start:0,duration:6,section:'Story text'}),
    art('audio',{id:'desk-chime',name:'First chimes',sceneId:opening.id,assetId:'keeper-chime',start:1.2,duration:3.6,volume:.5,audioEffects:[{id:'desk-reverb',type:'reverb',enabled:true,seconds:.6,decay:.45,mix:.18}],section:'Sound'}),
    art('rectangle',{id:'flight-sky',name:'Midnight sky',sceneId:flight.id,x:480,y:270,width:960,height:540,fill:'#102638',start:6,duration:6,optimize:'static',section:'Night sky'}),
    art('ellipse',{id:'flight-moon',name:'Pale moon',sceneId:flight.id,x:775,y:156,width:138,height:138,fill:'#f4e9c8',opacity:.93,start:6,duration:6,optimize:'static',section:'Night sky'}),
    ...Array.from({length:9},(_,index)=>art('ellipse',{id:`flight-star-${index}`,name:`Star ${index+1}`,sceneId:flight.id,x:70+(index*179)%790,y:70+(index*83)%200,width:5+index%3*3,height:5+index%3*3,fill:'#e6e5c8',opacity:.65,start:6,duration:6,tracks:[{property:'opacity',keyframes:[key(`star-${index}-0`,0,.4),key(`star-${index}-1`,3,.9),key(`star-${index}-2`,6,.4)]}],section:'Night sky'})),
    art('rectangle',{id:'flight-horizon',name:'Distant roofs',sceneId:flight.id,x:480,y:490,width:960,height:100,fill:'#244254',start:6,duration:6,optimize:'static',section:'Night sky'}),
    ...lantern(flight.id,6,250,444,'sky',true),
    art('rectangle',{id:'memory-border',name:'Memory inset frame',sceneId:flight.id,x:787,y:128,width:265,height:154,fill:'#f4d49a',stroke:'#fff1c7',strokeWidth:4,start:8,duration:3,section:'Composition'}),
    art('text',{id:'flight-line',name:'Closing line',sceneId:flight.id,x:64,y:438,width:560,height:55,pivotX:0,pivotY:0,text:'Every journey carries its first light.',fontFamily:'Inter',fontSize:24,fill:'#fff1d2',textAnimation:{unit:'word',effect:'slide',direction:'in',start:.2,duration:.45,stagger:.16,easing:'sine',easingDirection:'out',distance:28,seed:8,amplitude:8,frequency:1},start:6,duration:6,section:'Story text'}),
    art('audio',{id:'flight-chime',name:'Returning chimes',sceneId:flight.id,assetId:'keeper-chime',start:7,duration:3.6,volume:.35,section:'Sound'}),
  );
  project.captions=[
    {id:'caption-beginning',sceneId:opening.id,start:1.2,end:4.6,text:'One light begins a journey.'},
    {id:'caption-flight',sceneId:flight.id,start:7,end:10.8,text:'Every journey carries its first light.'},
  ];
  project.webPlayer={posterTime:1.3,loop:false,controlsVisible:true,showSeek:true,showVolume:true,showFullscreen:true,showCaptions:true,showLoop:true};
  return project;
}
