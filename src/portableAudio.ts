import {audioPitchPlan,prepareAudioBuffer,preparedSourceTime} from './audioPitch';
import {elementWindow,uid,type Asset,type Project,type StoryElement} from './model';
import {materializeScenePlacements} from './scenePlacement';
import {animatedAssetElementIds,mediaAudioSegments} from './mediaAudioSegments';
import {clipEffectTail,renderExportAudio} from './mediaExportAudio';

function wavPcm16(buffer:AudioBuffer):Uint8Array {
  const channels=buffer.numberOfChannels,frames=buffer.length,bytes=new Uint8Array(44+frames*channels*2);
  const header=new DataView(bytes.buffer),rate=buffer.sampleRate;
  const write=(offset:number,value:string)=>{for(let index=0;index<value.length;index++)bytes[offset+index]=value.charCodeAt(index);};
  write(0,'RIFF');header.setUint32(4,bytes.length-8,true);write(8,'WAVE');write(12,'fmt ');
  header.setUint32(16,16,true);header.setUint16(20,1,true);header.setUint16(22,channels,true);
  header.setUint32(24,rate,true);header.setUint32(28,rate*channels*2,true);
  header.setUint16(32,channels*2,true);header.setUint16(34,16,true);
  write(36,'data');header.setUint32(40,frames*channels*2,true);
  const pcm=Array.from({length:channels},(_,channel)=>buffer.getChannelData(channel));
  let at=44;
  for(let frame=0;frame<frames;frame++)for(let channel=0;channel<channels;channel++){
    const sample=Math.max(-1,Math.min(1,pcm[channel][frame]));
    header.setInt16(at,sample<0?Math.round(sample*32768):Math.round(sample*32767),true);at+=2;
  }
  return bytes;
}

function asDataUrl(bytes:Uint8Array):Promise<string> {
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error??new Error('Processed audio could not be packaged.'));reader.readAsDataURL(new Blob([bytes as Uint8Array<ArrayBuffer>],{type:'audio/wav'}));});
}

/** File pages have an opaque origin and cannot load the stretch worklet's blob
 * module in Chrome. Bake clips needing pitch/time DSP while exporting, then
 * the isolated player can use ordinary Web Audio without a server. */
export async function preparePortableAudio(project:Project):Promise<Project> {
  // Flatten each placement's audible *source* audio into local clips, while
  // retaining its linked visuals and camera. Muting the inherited audio as a
  // whole matters for nested links: an override authored in an inner placement
  // would otherwise be inherited alongside the outer placement's override.
  // Derive all overrides from the original project, never from earlier export
  // overrides, so each clip receives its own effective speed and pitch once.
  const originalIds=new Set(project.elements.map(element=>element.id));
  const composed=materializeScenePlacements(project);
  const animated=animatedAssetElementIds(project);
  const virtualAudio=composed.elements.filter(element=>{
    if(animated.has(element.id))return false;
    if(originalIds.has(element.id)||element.muted||element.hidden||!element.assetId||!elementWindow(project,element))return false;
    const asset=project.assets.find(item=>item.id===element.assetId);
    return !!asset&&(asset.kind==='audio'||asset.kind==='video');
  });
  const next=structuredClone(project);
  for(const scene of next.sequences)if(scene.sourceSceneId)scene.muted=true;
  for(const virtual of virtualAudio){
    const replacement:StoryElement={...structuredClone(virtual),id:uid(),kind:'audio',muted:false,
      parentId:undefined,attachment:undefined,
      tracks:virtual.tracks.filter(track=>track.property==='volume').map(track=>({property:track.property,keyframes:track.keyframes.map(key=>({...key,id:uid()}))}))};
    next.elements.push(replacement);
  }
  // A texture may switch between image and video, or between two videos. Bake
  // each animated element's complete audible result with the same offline mixer
  // as MP4/WebM export. This also removes the stretch-worklet dependency from
  // file:// playback and preserves fades/effects across every asset switch.
  const dynamicAudible=new Set(mediaAudioSegments(project).map(segment=>segment.element.id));
  const flattened={...project,
    sequences:project.sequences.map(scene=>({...scene,sourceSceneId:undefined})),
    elements:composed.elements,
  };
  for(const element of composed.elements.filter(item=>animated.has(item.id)&&dynamicAudible.has(item.id))){
    const window=elementWindow(project,element);
    if(!window)continue;
    const isolated:Project={...flattened,elements:flattened.elements.map(item=>({...item,muted:item.id!==element.id}))};
    const tail=clipEffectTail(element.audioEffects);
    const buffer=await renderExportAudio(isolated,window.start,window.end,tail);
    if(!buffer)continue;
    const baked:Asset={id:uid(),name:`${element.name} animated audio.wav`,kind:'audio',mime:'audio/wav',
      dataUrl:await asDataUrl(wavPcm16(buffer)),duration:buffer.duration};
    next.assets.push(baked);
    const companion:StoryElement={...structuredClone(element),id:uid(),kind:'audio',assetId:baked.id,
      sceneId:undefined,start:window.start,duration:buffer.duration,sourceOffset:0,speed:1,
      pitchSemitones:0,linkSpeedPitch:true,volume:1,fadeIn:0,fadeOut:0,audioEffects:[],
      muted:false,hidden:false,loop:false,parentId:undefined,attachment:undefined,
      tracks:[],assemblyClips:undefined,clipInstances:undefined,motionBehaviors:undefined};
    next.elements.push(companion);
    // Muting the authored source also mutes its derived linked-scene copies;
    // each audible copy above receives its own baked companion instead.
    const sourceId=element.id.split('::').at(-1)!;
    const original=next.elements.find(item=>item.id===sourceId);
    if(original)original.muted=true;
  }
  const affected=next.elements.filter(element=>{
    if(element.muted||element.hidden||!element.assetId)return false;
    const asset=next.assets.find(item=>item.id===element.assetId);
    return !!asset&&(asset.kind==='audio'||asset.kind==='video')&&audioPitchPlan(element).processed;
  });
  if(!affected.length)return next;
  const decodeContext=new AudioContext();
  const decoded=new Map<string,AudioBuffer>(),prepared=new Map<string,Asset>();
  try {
    for(const original of affected){
      const asset=next.assets.find(item=>item.id===original.assetId)!;
      const plan=audioPitchPlan(original),key=`${asset.id}:${plan.processSpeed}:${plan.pitchSemitones}`;
      let baked=prepared.get(key);
      if(!baked){
        let source=decoded.get(asset.id);
        if(!source){
          try{const response=await fetch(asset.dataUrl);if(!response.ok)throw new Error(`HTTP ${response.status}`);source=await decodeContext.decodeAudioData(await response.arrayBuffer());}
          catch{throw new Error(`Cannot process audio in ${asset.name} for a standalone web package.`);}
          decoded.set(asset.id,source);
        }
        const processed=await prepareAudioBuffer(decodeContext,source,plan);
        baked={id:uid(),name:`${asset.name.replace(/\.[^.]+$/,'')} processed.wav`,kind:'audio',mime:'audio/wav',dataUrl:await asDataUrl(wavPcm16(processed)),duration:processed.duration};
        prepared.set(key,baked);next.assets.push(baked);
      }
      const element=next.elements.find(item=>item.id===original.id)!;
      const replacement:StoryElement={...structuredClone(element),id:uid(),kind:'audio',assetId:baked.id,
        sourceOffset:preparedSourceTime(element.sourceOffset??0,plan),speed:plan.playbackRate,
        pitchSemitones:0,linkSpeedPitch:true,muted:false,hidden:false,parentId:undefined,attachment:undefined,
        tracks:element.tracks.filter(track=>track.property==='volume').map(track=>({property:track.property,keyframes:track.keyframes.map(frame=>({...frame,id:uid()}))})),
      };
      // A video may be the texture of a shape, so preserve the visible object
      // and move only its processed audio to a companion clip.
      if(asset.kind==='video'){
        element.muted=true;
        next.elements.push(replacement);
      }else{
        element.assetId=replacement.assetId;
        element.sourceOffset=replacement.sourceOffset;
        element.speed=replacement.speed;
        element.pitchSemitones=0;
        element.linkSpeedPitch=true;
      }
    }
    return next;
  }finally{await decodeContext.close();}
}
