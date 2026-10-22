import {afterEach,describe,expect,it,vi} from 'vitest';
import {AudioTransport} from './audio';
import {createElement,createProject} from './model';
import {createAudioEffect} from './audioEffects';
import * as seekTail from './audioSeekTail';
class FakeAudioContext {
  static last:FakeAudioContext;
  currentTime=10;state='running';destination={};sources:any[]=[];gains:any[]=[];
  constructor(){FakeAudioContext.last=this;}
  resume=vi.fn(async()=>{});close=vi.fn(async()=>{});
  decodeAudioData=vi.fn(async()=>({duration:10} as AudioBuffer));
  createBufferSource(){const source={buffer:null,playbackRate:{value:1},loop:false,loopStart:0,loopEnd:0,connect:vi.fn(),disconnect:vi.fn(),start:vi.fn(),stop:vi.fn()};this.sources.push(source);return source;}
  createGain(){const gain={gain:{value:1},connect:vi.fn(),disconnect:vi.fn()};this.gains.push(gain);return gain;}
  createDelay(){return {delayTime:{value:0},connect:vi.fn(),disconnect:vi.fn()};}
}
describe('audio scheduling',()=>{
 afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
 function setup(){vi.stubGlobal('AudioContext',FakeAudioContext);vi.stubGlobal('fetch',vi.fn(async()=>({arrayBuffer:async()=>new ArrayBuffer(1)})));const project=createProject();project.duration=30;project.assets=[{id:'sound',name:'sound.wav',kind:'audio',mime:'audio/wav',dataUrl:'data:audio/wav;base64,AA==',duration:10}];return project;}
 it('loops only within the trimmed source range and follows the shared source mapping',async()=>{const p=setup();p.elements=[createElement('audio',{assetId:'sound',start:0,duration:30,sourceOffset:2,speed:2,loop:true})];const t=new AudioTransport();await t.play(p,5);const s=FakeAudioContext.last.sources[0];expect(s.loopStart).toBe(2);expect(s.loopEnd).toBe(10);expect(s.start).toHaveBeenCalledWith(10.025,4);expect(s.playbackRate.value).toBe(2);t.destroy();});
 it('changes viewer output gain during playback without changing clip automation',async()=>{
   const p=setup();p.elements=[createElement('audio',{assetId:'sound',duration:3,volume:.6})];
   const transport=new AudioTransport();transport.setOutputVolume(.4);await transport.play(p,0);
   const context=FakeAudioContext.last;
   expect(context.gains[0].gain.value).toBe(.4);
   expect(context.gains[2].connect).toHaveBeenCalledWith(context.gains[0]);
   expect(context.gains[2].gain.value).toBe(.6);
   transport.setOutputVolume(0);
   expect(context.gains[0].gain.value).toBe(0);
   expect(context.gains[2].gain.value).toBe(.6);
   transport.destroy();
   expect(context.gains[0].disconnect).toHaveBeenCalled();
 });
 it('schedules future clips from the same anchor and excludes hidden/muted sources',async()=>{const p=setup();p.elements=[createElement('audio',{assetId:'sound',start:4,duration:3}),createElement('audio',{assetId:'sound',muted:true}),createElement('audio',{assetId:'sound',hidden:true})];const t=new AudioTransport();await t.play(p,1);const s=FakeAudioContext.last.sources;expect(s).toHaveLength(1);expect(s[0].start).toHaveBeenCalledWith(13.025,0);expect(s[0].stop).toHaveBeenCalledWith(16.025);t.destroy();});
 it('includes video used as a shape fill, sharing its source timing',async()=>{const p=setup();p.assets[0].kind='video';p.elements=[createElement('ellipse',{assetId:'sound',sourceOffset:1,speed:2,duration:6})];const t=new AudioTransport();await t.play(p,2);expect(FakeAudioContext.last.sources[0].start).toHaveBeenCalledWith(10.025,5);t.destroy();});
 it('switches embedded video sound with an animated shape texture and preserves the project source clock',async()=>{
   const p=setup();p.duration=4;p.sequences[0].duration=4;
   p.assets=[{...p.assets[0],id:'first',kind:'video'},{...p.assets[0],id:'second',kind:'video'}];
   p.elements=[createElement('rectangle',{assetId:'first',duration:4,speed:2,sourceOffset:1,tracks:[{property:'assetId',keyframes:[
     {id:'a',time:0,value:'first',easing:'linear',direction:'inOut',mode:'smooth',switchPoint:.25},
     {id:'b',time:4,value:'second',easing:'linear',direction:'inOut',mode:'smooth'},
   ]}]})];
   const transport=new AudioTransport();await transport.play(p,0);
   const sources=FakeAudioContext.last.sources;
   expect(sources).toHaveLength(2);
   expect(sources[0].start).toHaveBeenCalledWith(10.025,1);
   expect(sources[0].stop.mock.calls[0][0]).toBeCloseTo(11.025,5);
   expect(sources[1].start.mock.calls[0][0]).toBeCloseTo(11.025,5);
   expect(sources[1].start.mock.calls[0][1]).toBeCloseTo(3,5);
   transport.destroy();
 });
 it('does not end an isolated animated-media preview when its first video texture finishes',async()=>{
   const p=setup();p.duration=4;p.sequences[0].duration=4;
   p.assets=[{...p.assets[0],id:'first',kind:'video'},{...p.assets[0],id:'second',kind:'video'}];
   const item=createElement('video',{assetId:'first',duration:4,tracks:[{property:'assetId',keyframes:[
     {id:'a',time:0,value:'first',easing:'linear',direction:'inOut',mode:'smooth'},
     {id:'b',time:4,value:'second',easing:'linear',direction:'inOut',mode:'smooth'},
   ]}]});p.elements=[item];
   const ended=vi.fn(),transport=new AudioTransport();await transport.preview(p,item.id,0,ended);
   const sources=FakeAudioContext.last.sources;
   expect(sources).toHaveLength(2);
   vi.useFakeTimers();sources[0].onended();vi.runAllTimers();
   expect(transport.previewingId).toBe(item.id);
   expect(ended).not.toHaveBeenCalled();
   sources[1].onended();vi.runAllTimers();
   expect(transport.previewingId).toBeNull();
   expect(ended).toHaveBeenCalledTimes(1);
   transport.destroy();
 });
 it('cancels a pending play without starting stale sources',async()=>{const p=setup();p.elements=[createElement('audio',{assetId:'sound'})];let resolve!:()=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise(r=>{resolve=()=>r({arrayBuffer:async()=>new ArrayBuffer(1)});})));const t=new AudioTransport();const pending=t.play(p,0);await Promise.resolve();t.stop();resolve();await pending;expect(FakeAudioContext.last.sources).toHaveLength(0);t.destroy();});
 it('routes each clip through its effects and keeps echo audible at the clip boundary',async()=>{
   const p=setup();p.elements=[createElement('audio',{assetId:'sound',duration:2,volume:.6,audioEffects:[createAudioEffect('echo')]})];
   const t=new AudioTransport();await t.play(p,0);
   const ctx=FakeAudioContext.last;
   expect(ctx.sources[0].connect).toHaveBeenCalledWith(ctx.gains[1]);
   expect(ctx.gains[1].connect).not.toHaveBeenCalledWith(ctx.gains[2]);
   expect(ctx.gains[2].connect).toHaveBeenCalledWith(ctx.gains[0]);
   expect(ctx.gains.length).toBeGreaterThan(2);
   t.update(p,2.05);
   expect(ctx.gains[2].gain.value).toBe(.6);
   t.update(p,7);
   expect(ctx.gains[2].gain.value).toBe(0);
   t.destroy();
 });
 it('does not schedule an effect-tail cleanup after a seek stops the old source',async()=>{
   const p=setup();p.elements=[createElement('audio',{assetId:'sound',audioEffects:[createAudioEffect('echo')]})];
   const t=new AudioTransport();await t.play(p,0);
   const oldSource=FakeAudioContext.last.sources[0];
   vi.useFakeTimers();
   t.stop();oldSource.onended();
   expect(vi.getTimerCount()).toBe(0);
   t.destroy();
 });
 it('applies fades before effects so an echo tail keeps its final volume',async()=>{
   const p=setup();p.elements=[createElement('audio',{assetId:'sound',start:0,duration:2,fadeIn:1,fadeOut:1,volume:.7,audioEffects:[createAudioEffect('echo')]})];
   const t=new AudioTransport();await t.play(p,0);
   const ctx=FakeAudioContext.last;
   expect(ctx.gains[1].gain.value).toBe(0);
   t.update(p,.5);expect(ctx.gains[1].gain.value).toBe(.5);
   t.update(p,1.5);expect(ctx.gains[1].gain.value).toBe(.5);
   t.update(p,2.05);expect(ctx.gains[1].gain.value).toBe(0);
   expect(ctx.gains[2].gain.value).toBe(.7);
   t.destroy();
 });
 it('previews one muted audio object through its normal fades, speed, volume, and effects without changing the project',async()=>{
   const p=setup();
   const selected=createElement('audio',{assetId:'sound',start:1,duration:3,muted:true,speed:1.5,volume:.3,fadeIn:1,audioEffects:[createAudioEffect('echo')],tracks:[{property:'volume',keyframes:[
     {id:'low',time:0,value:.2,easing:'linear',direction:'inOut',mode:'smooth'},
     {id:'high',time:1,value:1.2,easing:'linear',direction:'inOut',mode:'smooth'},
   ]}]});
   const other=createElement('audio',{assetId:'sound',start:0,duration:8});
   p.elements=[other,selected];
   const before=structuredClone(p);
   const t=new AudioTransport();
   await t.preview(p,selected.id,1.5);
   const ctx=FakeAudioContext.last;
   expect(t.previewingId).toBe(selected.id);
   expect(ctx.sources).toHaveLength(1);
   expect(ctx.sources[0].playbackRate.value).toBe(1.5);
   expect(ctx.sources[0].start).toHaveBeenCalledWith(10.025,.75);
   expect(ctx.gains[1].gain.value).toBe(.5);
   expect(ctx.gains[2].gain.value).toBe(.7);
   expect(ctx.gains.length).toBeGreaterThan(3);
   expect(p).toEqual(before);
   t.stop();
   expect(t.previewingId).toBeNull();
   await t.play(p,0);
   expect(ctx.sources).toHaveLength(2);
   expect(ctx.sources[1].start).toHaveBeenCalled();
   t.destroy();
 });
 it('ends previews once after effect tails and restores normal playback on interruption or replacement',async()=>{
   const p=setup();
   const one=createElement('audio',{assetId:'sound',duration:2,audioEffects:[createAudioEffect('echo')]});
   const two=createElement('audio',{assetId:'sound',duration:2});
   p.elements=[one,two];
   const t=new AudioTransport();
   const first=vi.fn(),second=vi.fn(),third=vi.fn();
   await t.preview(p,one.id,undefined,first);
   await t.preview(p,two.id,undefined,second);
   expect(first).toHaveBeenCalledTimes(1);
   expect(second).not.toHaveBeenCalled();
   t.stop();
   expect(second).toHaveBeenCalledTimes(1);
   await t.preview(p,one.id,undefined,third);
   vi.useFakeTimers();
   FakeAudioContext.last.sources.at(-1).onended();
   expect(third).not.toHaveBeenCalled();
   vi.runAllTimers();
   expect(third).toHaveBeenCalledTimes(1);
   expect(t.previewingId).toBeNull();
   await t.play(p,0);
   expect(FakeAudioContext.last.sources.slice(-2)).toHaveLength(2);
   expect(third).toHaveBeenCalledTimes(1);
   t.destroy();
 });
 it('cancels an in-flight preview on seek without leaking a source or a pending UI state',async()=>{
   const p=setup();p.elements=[createElement('audio',{assetId:'sound'})];
   let resolve!:()=>void;
   vi.stubGlobal('fetch',vi.fn(()=>new Promise(r=>{resolve=()=>r({arrayBuffer:async()=>new ArrayBuffer(1)});}))); 
   const ended=vi.fn(),t=new AudioTransport();
   const pending=t.preview(p,p.elements[0].id,0,ended);
   await Promise.resolve();
   expect(t.previewingId).toBe(p.elements[0].id);
   t.stop();
   expect(ended).toHaveBeenCalledTimes(1);
   resolve();await pending;
   expect(FakeAudioContext.last.sources).toHaveLength(0);
   expect(t.previewingId).toBeNull();
   t.destroy();
 });
 it('plays an ended clip\'s reconstructed tail after seeking past its source',async()=>{
   const p=setup();p.elements=[createElement('audio',{assetId:'sound',start:0,duration:2,audioEffects:[createAudioEffect('echo')]})];
   const tail={duration:1.5} as AudioBuffer;
   const render=vi.spyOn(seekTail,'renderSeekEffectTail').mockResolvedValue(tail);
   const t=new AudioTransport();await t.play(p,2.2);
   const sources=FakeAudioContext.last.sources;
   expect(render).toHaveBeenCalledTimes(1);
   expect(sources).toHaveLength(1);
   expect(sources[0].buffer).toBe(tail);
   expect(sources[0].start).toHaveBeenCalledWith(10.025);
   expect(sources[0].stop).toHaveBeenCalledWith(11.525);
   t.stop();expect(sources[0].disconnect).toHaveBeenCalled();
   t.destroy();render.mockRestore();
 });
 it('discards a seek tail rendered after transport cancellation',async()=>{
   const p=setup();p.elements=[createElement('audio',{assetId:'sound',start:0,duration:2,audioEffects:[createAudioEffect('echo')]})];
   let complete!: (buffer:AudioBuffer)=>void;
   const render=vi.spyOn(seekTail,'renderSeekEffectTail').mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
   const t=new AudioTransport(),pending=t.play(p,1);
   await vi.waitFor(()=>expect(render).toHaveBeenCalledTimes(1));
   t.stop();complete({duration:2} as AudioBuffer);await pending;
   expect(FakeAudioContext.last.sources).toHaveLength(0);
   t.destroy();render.mockRestore();
 });
});
