import {createElement,createProject,type Keyframe,type Project} from '../src/model';
import {editablePathForElement} from '../src/shapePath';
import {createAudioEffect} from '../src/audioEffects';

const key=(id:string,time:number,value:number,mode:Keyframe['mode']='smooth'):Keyframe=>
  ({id,time,value,mode,easing:'linear',direction:'inOut'});

function pulseWav():string {
  const rate=48000,seconds=.1,count=Math.round(rate*seconds),bytes=Buffer.alloc(44+count*2);
  bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(count*2,40);
  for(let index=0;index<count;index++){
    const t=index/rate,envelope=Math.min(1,t/.005,(seconds-t)/.01);
    bytes.writeInt16LE(Math.round(Math.sin(2*Math.PI*880*t)*Math.max(0,envelope)*24000),44+index*2);
  }
  return `data:audio/wav;base64,${bytes.toString('base64')}`;
}

/** Short, deterministic asset-and-scene fixture for cross-surface frame checks.
 * The light bar and tone both begin at project time 0.5 s. */
export function createFidelityProject():Project {
  const project=createProject('Fidelity fixture');
  project.width=320;project.height=180;project.fps=12;project.duration=4;project.background='#172638';
  const source=project.sequences[0];source.id='source';source.name='Source composition';source.duration=2;
  project.sequences.push(
    {id:'inset',name:'Linked inset',sourceSceneId:source.id,start:2,duration:1,sourceIn:0,sourceOut:1,color:'#efa94b',frame:{x:145,y:26,width:158,height:124},frameRotation:8},
    {id:'nested',name:'Nested linked inset',sourceSceneId:'inset',start:3,duration:1,color:'#efa94b',frame:{x:15,y:16,width:287,height:148}},
  );
  const texture='<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#e9a643"/><path d="M-20 15 80 115M0-20 115 95M-20 65 40 125" stroke="#814883" stroke-width="14"/><circle cx="72" cy="22" r="15" fill="#e8d99d"/></svg>';
  project.assets.push(
    {id:'woven',name:'woven.svg',kind:'image',mime:'image/svg+xml',dataUrl:`data:image/svg+xml;charset=utf-8,${encodeURIComponent(texture)}`},
    {id:'pulse',name:'pulse.wav',kind:'audio',mime:'audio/wav',dataUrl:pulseWav(),duration:.1},
  );
  const sourceVisual={sceneId:source.id,start:0,duration:2};
  const body=createElement('rectangle',{id:'body',name:'Articulated body',...sourceVisual,x:251,y:114,width:75,height:54,fill:'#c4675d',assetId:'woven',shadow:{enabled:true,color:'#000000',blur:8,x:3,y:5}});
  const lid=createElement('rectangle',{id:'lid',name:'Hinged lid',...sourceVisual,x:-39,y:-29,width:79,height:13,pivotX:0,attachment:{type:'hinge',parentId:body.id,min:-75,max:0},fill:'#f4dc9e',tracks:[{property:'rotation',keyframes:[key('lid-0',0,0),key('lid-1',1.6,-65)]}]});
  project.elements=[
    createElement('ellipse',{id:'curved-mask',name:'Curved textured mask',...sourceVisual,x:91,y:109,width:133,height:99,assetId:'woven',mediaFit:'fill',mediaTransform:{x:8,y:-4,scaleX:1.32,scaleY:1.14,rotation:22},shapePath:editablePathForElement({kind:'ellipse',width:133,height:99}),stroke:'#f4dc9e',strokeWidth:3,shadow:{enabled:true,color:'#000000',blur:6,x:2,y:3}}),
    createElement('text',{id:'animated-text',name:'Animated textured title',...sourceVisual,x:19,y:17,width:280,height:55,pivotX:0,pivotY:0,text:'A visual pulse',fontFamily:'JetBrains Mono',fontSize:23,fill:'#ffffff',assetId:'woven',textAnimation:{unit:'word',effect:'slide',direction:'in',start:0,duration:.45,stagger:.16,easing:'sine',easingDirection:'inOut',distance:23,seed:7,amplitude:0,frequency:1}}),
    body,lid,
    createElement('rectangle',{id:'flash',name:'Synchronized flash',...sourceVisual,x:160,y:171,width:320,height:18,fill:'#ffffff',opacity:0,tracks:[{property:'opacity',keyframes:[key('flash-0',0,0,'hold'),key('flash-1',.5,1,'hold'),key('flash-2',7/12,0,'hold')]}]}),
    createElement('audio',{id:'beep',name:'Synchronized beep',sceneId:source.id,start:.5,duration:.1,assetId:'pulse',volume:.85,audioEffects:[createAudioEffect('compressor')]}),
  ];
  project.captions=[{id:'caption',sceneId:source.id,start:.1,end:1.7,text:'A shape, an assembly, and a pulse.'}];
  return project;
}
