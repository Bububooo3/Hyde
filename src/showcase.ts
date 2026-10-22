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
  const root=createElement('group',{id:`${prefix}-assembly`,name:'Paper lantern · assembly',sceneId,x,y,width:160,height:200,start:at,duration:length,section:'Lantern assembly'});
  const body=createElement('rectangle',{id:`${prefix}-body`,name:'Textured paper shell',sceneId,parentId:root.id,x:0,y:0,width:128,height:154,fill:'#f5b96b',assetId:'lantern-paper',stroke:'#a46148',strokeWidth:2,start:at,duration:length,section:'Lantern assembly'});
  const lid=createElement('polygon',{id:`${prefix}-lid`,name:'Hinged roof',sceneId,attachment:{type:'hinge',parentId:body.id,min:-24,max:24},x:0,y:-82,width:150,height:34,pivotY:1,fill:'#df8d65',stroke:'#a46148',strokeWidth:2,points:[{x:0,y:30},{x:75,y:0},{x:150,y:30}],start:at,duration:length,section:'Lantern assembly'});
  const window=createElement('ellipse',{id:`${prefix}-window`,name:'Warm window',sceneId,parentId:body.id,x:0,y:-4,width:66,height:104,fill:'#ffebbd',opacity:.94,stroke:'#cb8060',strokeWidth:2,start:at,duration:length,section:'Lantern assembly'});
  const ribbon=createElement('rectangle',{id:`${prefix}-ribbon`,name:'Sliding tassel',sceneId,attachment:{type:'slider',parentId:body.id,min:-18,max:18},x:0,y:88,width:8,height:47,fill:'#e9a969',start:at,duration:length,section:'Lantern assembly'});
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
  project.width=960;project.height=540;project.fps=30;project.duration=12;project.background='#102e3a';
  const opening=project.sequences[0];opening.id='showcase-workshop';opening.name='01 · A small beginning';opening.start=0;opening.duration=6;opening.color='#ffbd65';
  opening.camera={x:480,y:270,zoom:1,rotation:0,tracks:[{property:'zoom',keyframes:[key('desk-camera-0',0,1),key('desk-camera-1',6,1.1)]}]};
  const flight={id:'showcase-flight',name:'02 · Across the night',start:6,duration:6,color:'#5a9e9e',camera:{x:480,y:270,zoom:1,rotation:0,tracks:[
    {property:'x' as const,keyframes:[key('sky-camera-x0',0,480),key('sky-camera-x1',6,575)]},
    {property:'zoom' as const,keyframes:[key('sky-camera-z0',0,1),key('sky-camera-z1',6,1.16)]},
  ]}};
  project.sequences.push(flight);
  project.sequences.push({id:'showcase-memory',name:'The beginning · inset',start:8,duration:1.5,color:'#f4d49a',sourceSceneId:opening.id,sourceIn:1,sourceOut:2.5,frame:{x:655,y:48,width:260,height:146},frameFit:'fill',opacity:1,muted:true});
  project.assets.push(svgAsset('map-paper','Star chart paper.svg','<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="#d9bc88"/><g fill="none" stroke="#92765d" stroke-width="2" opacity=".65"><path d="M20 112Q85 15 160 76T288 31"/><path d="M10 160Q90 108 155 143T285 84"/><circle cx="161" cy="76" r="17"/><circle cx="244" cy="53" r="9"/></g><g fill="#765e55"><circle cx="26" cy="113" r="4"/><circle cx="161" cy="76" r="4"/><circle cx="244" cy="53" r="4"/></g></svg>'));
  project.assets.push(svgAsset('lantern-paper','Ribbed lantern paper.svg','<svg xmlns="http://www.w3.org/2000/svg" width="128" height="154"><rect width="128" height="154" fill="#f6bd74"/><path d="M18 0V154M45 0V154M83 0V154M110 0V154" stroke="#d88759" stroke-opacity=".3" stroke-width="3"/><path d="M0 16H128M0 137H128" stroke="#fff1cd" stroke-opacity=".58" stroke-width="5"/></svg>'));
  project.assets.push({id:'keeper-chime',name:'Lantern chimes.wav',kind:'audio',mime:'audio/wav',dataUrl:chimeWav(),duration:3.6});
  const art=(kind:StoryElement['kind'],values:Partial<StoryElement>)=>createElement(kind,values);
  project.elements.push(
    art('rectangle',{id:'desk-sky',name:'Deep teal dusk',sceneId:opening.id,x:480,y:270,width:960,height:540,fill:'#123440',start:0,duration:6,optimize:'static',section:'Workshop'}),
    art('ellipse',{id:'desk-moon',name:'Distant evening moon',sceneId:opening.id,x:780,y:106,width:92,height:92,fill:'#e3cfa9',opacity:.74,start:0,duration:6,optimize:'static',section:'Workshop'}),
    art('rectangle',{id:'desk-far-hill',name:'Distant hillside',sceneId:opening.id,x:480,y:447,width:960,height:186,fill:'#1c4850',shapePath:{points:[{x:0,y:.48,out:{x:.27,y:.2}},{x:.55,y:.43,out:{x:.8,y:.66}},{x:1,y:.28},{x:1,y:1},{x:0,y:1}]},start:0,duration:6,optimize:'static',section:'Workshop'}),
    art('rectangle',{id:'desk-table',name:'Worktable silhouette',sceneId:opening.id,x:480,y:493,width:960,height:94,fill:'#203e43',start:0,duration:6,optimize:'static',section:'Workshop'}),
    art('rectangle',{id:'desk-map',name:'Curved star chart',sceneId:opening.id,x:266,y:430,width:292,height:122,fill:'#d9bc88',assetId:'map-paper',stroke:'#f2ddb0',strokeWidth:2,shapePath:{points:[{x:.04,y:.04,out:{x:.38,y:-.03}},{x:.95,y:.04,out:{x:1.02,y:.35}},{x:.95,y:.93,out:{x:.55,y:1.03}},{x:.04,y:.91,out:{x:-.02,y:.55}}]},start:0,duration:6,section:'Workshop'}),
    ...lantern(opening.id,0,700,307,'desk'),
    art('text',{id:'desk-eyebrow',name:'Opening eyebrow',sceneId:opening.id,x:84,y:76,width:400,height:25,pivotX:0,pivotY:0,text:'A STORY IN TWO SCENES',fontFamily:'Inter',fontSize:15,fill:'#9bc3b7',start:0,duration:6,section:'Story text'}),
    art('text',{id:'desk-heading',name:'Opening title',sceneId:opening.id,x:79,y:118,width:520,height:128,pivotX:0,pivotY:0,text:'The Lantern\nKeeper',fontFamily:'Playfair Display',fontSize:55,fill:'#f9e8c5',start:0,duration:6,section:'Story text'}),
    art('text',{id:'desk-subtitle',name:'Opening line',sceneId:opening.id,x:84,y:282,width:420,height:44,pivotX:0,pivotY:0,text:'A little light finds its way home.',fontFamily:'Inter',fontSize:21,fill:'#e7c995',start:0,duration:6,section:'Story text'}),
    art('audio',{id:'desk-chime',name:'First chimes',sceneId:opening.id,assetId:'keeper-chime',start:1.2,duration:3.6,volume:.5,audioEffects:[{id:'desk-reverb',type:'reverb',enabled:true,seconds:.6,decay:.45,mix:.18}],section:'Sound'}),
    art('rectangle',{id:'flight-sky',name:'Midnight sky',sceneId:flight.id,x:480,y:270,width:960,height:540,fill:'#0e2e3c',start:6,duration:6,optimize:'static',section:'Night sky'}),
    art('ellipse',{id:'flight-moon',name:'Pale moon',sceneId:flight.id,x:778,y:127,width:114,height:114,fill:'#e8dcb8',opacity:.88,start:6,duration:6,optimize:'static',section:'Night sky'}),
    ...Array.from({length:9},(_,index)=>art('ellipse',{id:`flight-star-${index}`,name:`Star ${index+1}`,sceneId:flight.id,x:70+(index*179)%790,y:70+(index*83)%200,width:5+index%3*3,height:5+index%3*3,fill:'#e6e5c8',opacity:.65,start:6,duration:6,tracks:[{property:'opacity',keyframes:[key(`star-${index}-0`,0,.4),key(`star-${index}-1`,3,.9),key(`star-${index}-2`,6,.4)]}],section:'Night sky'})),
    art('rectangle',{id:'flight-horizon',name:'Distant rooftops',sceneId:flight.id,x:480,y:480,width:960,height:120,fill:'#1d4652',shapePath:{points:[{x:0,y:.65},{x:.12,y:.52},{x:.18,y:.7},{x:.31,y:.4},{x:.42,y:.66},{x:.55,y:.48},{x:.67,y:.72},{x:.78,y:.42},{x:.9,y:.63},{x:1,y:.48},{x:1,y:1},{x:0,y:1}]},start:6,duration:6,optimize:'static',section:'Night sky'}),
    ...lantern(flight.id,6,250,444,'sky',true),
    art('text',{id:'flight-line',name:'Closing line',sceneId:flight.id,x:150,y:428,width:600,height:60,pivotX:0,pivotY:0,text:'Carry the light home.',fontFamily:'Playfair Display',fontSize:33,fill:'#fff1d2',textAnimation:{unit:'word',effect:'slide',direction:'in',start:.2,duration:.45,stagger:.16,easing:'sine',easingDirection:'out',distance:28,seed:8,amplitude:8,frequency:1},start:6,duration:6,section:'Story text'}),
    art('audio',{id:'flight-chime',name:'Returning chimes',sceneId:flight.id,assetId:'keeper-chime',start:7,duration:3.6,volume:.35,section:'Sound'}),
  );
  project.captions=[
    {id:'caption-beginning',sceneId:opening.id,start:1.2,end:4.6,text:'A little light finds its way home.'},
    {id:'caption-flight',sceneId:flight.id,start:7,end:10.8,text:'Carry the light home.'},
  ];
  project.webPlayer={posterTime:1.3,loop:false,controlsVisible:true,showSeek:true,showVolume:true,showFullscreen:true,showCaptions:true,showLoop:true};
  return project;
}
