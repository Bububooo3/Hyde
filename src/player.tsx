import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import { useEffect,useRef,useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Captions, LoaderCircle, Maximize, Minimize, Pause, Play, Repeat2, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import {captionWindow,type Project} from './model';
import { Stage } from './Stage';
import { AudioTransport } from './audio';
import {materializeScenePlacements} from './scenePlacement';
import {finalPlayerFrameTime,webPlayerSettings} from './webPlayerSettings';
import './player.css';
function loadStory(): Promise<Project> {
  const embedded = document.getElementById('hyde-story')?.textContent;
  if (embedded) return Promise.resolve(JSON.parse(embedded) as Project);
  return fetch('./story.json').then(response => {
    if (!response.ok) throw new Error('This player needs an exported story.json beside it.');
    return response.json() as Promise<Project>;
  });
}

function Player(){
  const [project,setProject]=useState<Project|null>(null),[error,setError]=useState(''),[warning,setWarning]=useState(''),[audioWarning,setAudioWarning]=useState(''),[time,setTime]=useState(0),[playing,setPlaying]=useState(false),[captions,setCaptions]=useState(true),[loading,setLoading]=useState(false),[buffering,setBuffering]=useState(false),[fullscreen,setFullscreen]=useState(false),[started,setStarted]=useState(false),[loop,setLoop]=useState(false),[volume,setVolume]=useState(1);
  const audio=useRef(new AudioTransport()),frame=useRef<HTMLDivElement>(null),operation=useRef(0),lastAudibleVolume=useRef(1);
  const projectRef=useRef<Project|null>(null),playingRef=useRef(false),wantsPlayback=useRef(false),renderedTime=useRef<number|null>(null);
  const frameWaiters=useRef<{time:number;resolve:()=>void}[]>([]),stalled=useRef<{time:number;token:number}|null>(null);
  projectRef.current=project;
  function markPlaying(value:boolean){playingRef.current=value;setPlaying(value);}
  function releaseFrameWaiters(){for(const waiter of frameWaiters.current.splice(0))waiter.resolve();}
  function waitForFrame(at:number):Promise<void>{
    if(renderedTime.current!==null&&Math.abs(renderedTime.current-at)<.0001)return Promise.resolve();
    return new Promise(resolve=>frameWaiters.current.push({time:at,resolve}));
  }
  function stageFailure(message:string){operation.current++;wantsPlayback.current=false;stalled.current=null;releaseFrameWaiters();markPlaying(false);setLoading(false);setBuffering(false);setError(message);}
  function framePending(_time:number){
    if(!wantsPlayback.current)return;
    if(!playingRef.current){setBuffering(true);return;}
    if(stalled.current)return;
    const current=projectRef.current;if(!current)return;
    const at=Math.min(current.duration,audio.current.pause());
    if(at>=current.duration){wantsPlayback.current=false;markPlaying(false);setTime(current.duration);return;}
    const token=++operation.current;
    stalled.current={time:at,token};
    markPlaying(false);setTime(at);setLoading(true);setBuffering(true);
  }
  function frameReady(at:number){
    renderedTime.current=at;
    const waiting=frameWaiters.current.filter(waiter=>Math.abs(waiter.time-at)<.0001);
    frameWaiters.current=frameWaiters.current.filter(waiter=>Math.abs(waiter.time-at)>=.0001);
    for(const waiter of waiting)waiter.resolve();
    const pause=stalled.current,current=projectRef.current;
    if(!pause||!current||Math.abs(at-pause.time)>=.0001)return;
    stalled.current=null;
    void audio.current.play(current,pause.time).then(()=>{
      if(pause.token!==operation.current||!wantsPlayback.current)return;
      setLoading(false);setBuffering(false);markPlaying(true);
    }).catch(error=>{if(pause.token===operation.current)stageFailure(String(error));});
  }
  useEffect(()=>{loadStory().then(story=>{setProject(story);setLoop(webPlayerSettings(story).loop);}).catch(e=>setError(String(e)));return()=>{operation.current++;wantsPlayback.current=false;releaseFrameWaiters();audio.current.destroy();};},[]);
  useEffect(()=>{audio.current.setOutputVolume(volume);},[volume]);
  useEffect(()=>{const update=()=>setFullscreen(document.fullscreenElement===frame.current);document.addEventListener('fullscreenchange',update);return()=>document.removeEventListener('fullscreenchange',update);},[]);
  async function startAt(story:Project,at:number,token:number){
    try{
      await waitForFrame(at);
      if(token!==operation.current||!wantsPlayback.current)return;
      await audio.current.play(story,at);
      if(!audio.current.audioSupported)setAudioWarning('Audio playback is unavailable in this browser; the story is playing without sound.');
      if(token===operation.current&&wantsPlayback.current)markPlaying(true);
    }catch(error){if(token===operation.current)stageFailure(String(error));}
    finally{if(token===operation.current){setLoading(false);setBuffering(false);}}
  }
  useEffect(()=>{
    if(!playing||!project)return;
    let raf=0;
    const tick=()=>{
      const t=Math.min(project.duration,audio.current.time);
      setTime(t);audio.current.update(project,t);
      if(t>=project.duration){
        audio.current.pause();markPlaying(false);
        if(!loop){wantsPlayback.current=false;return;}
        const token=++operation.current;
        setLoading(true);setTime(0);setBuffering(false);
        void startAt(project,0,token);
        return;
      }
      raf=requestAnimationFrame(tick);
    };
    raf=requestAnimationFrame(tick);
    return()=>{cancelAnimationFrame(raf);};
  },[playing,project,loop]);
  async function play(){
    if(!project)return;
    if(playingRef.current){operation.current++;wantsPlayback.current=false;stalled.current=null;const at=audio.current.pause();markPlaying(false);setTime(Math.min(project.duration,at));setLoading(false);setBuffering(false);return;}
    if(loading)return;
    const token=++operation.current,t=time>=project.duration?0:time;
    wantsPlayback.current=true;
    setStarted(true);setTime(t);setLoading(true);
    audio.current.setOutputVolume(volume);
    await startAt(project,t,token);
  }
  function seek(t:number){operation.current++;wantsPlayback.current=false;stalled.current=null;releaseFrameWaiters();audio.current.pause();markPlaying(false);setLoading(false);setBuffering(false);setStarted(true);setTime(t);}
  function toggleMute(){if(volume>0){lastAudibleVolume.current=volume;setVolume(0);}else setVolume(lastAudibleVolume.current||1);}
  async function toggleFullscreen(){try{if(document.fullscreenElement===frame.current)await document.exitFullscreen();else await frame.current?.requestFullscreen();}catch(e){setError(`Fullscreen is unavailable: ${String(e)}`);}}
  if(!project)return <main className="player-empty">{error||'Loading story…'}</main>;
  const settings=webPlayerSettings(project),displayTime=started?Math.min(time,finalPlayerFrameTime(project)):settings.posterTime;
  const caption=materializeScenePlacements(project).captions.find(c=>{const window=captionWindow(project,c);return !!window&&displayTime>=window.start&&displayTime<window.end;});
  const playbackLabel=loading?buffering?'Buffering media':'Preparing playback':playing?'Pause':time>=project.duration?'Replay':'Play';
  const PlaybackIcon=loading?LoaderCircle:playing?Pause:time>=project.duration?RotateCcw:Play;
  return <main className="player">
    <div className="player-heading"><strong>{project.name}</strong></div>
    <div ref={frame} className="player-frame" style={{'--stage-aspect':String(project.width/project.height)} as React.CSSProperties}>
      <div className="player-screen" style={{aspectRatio:`${project.width}/${project.height}`}}><Stage project={project} time={displayTime} onError={stageFailure} onWarning={setWarning} onFramePending={framePending} onFrameReady={frameReady} prepareAheadSeconds={2}/>{captions&&caption&&<div className="captions">{caption.text}</div>}
        {(!started||!settings.controlsVisible)&&<button className={`player-stage-toggle ${started?'player-stage-toggle-subtle':''}`} aria-label={!started?'Start story':playing?'Pause story':time>=project.duration?'Replay story':'Play story'} title={!started?'Start story':playing?'Pause story':'Play story'} onClick={()=>void play()} disabled={loading}><PlaybackIcon size={30} fill={playing||loading?'none':'currentColor'}/></button>}
      </div>
      {settings.showFullscreen&&<button className="player-icon-button player-fullscreen-exit" aria-label="Exit fullscreen" title="Exit fullscreen" onClick={()=>void toggleFullscreen()}><Minimize size={20}/></button>}
    </div>
    {settings.controlsVisible&&<div className="player-controls" aria-label="Playback controls">
      <button className="player-icon-button" aria-label={playbackLabel} title={playbackLabel} onClick={()=>void play()} disabled={loading}><PlaybackIcon size={20} className={loading?'spin':undefined} fill={playing||loading?'none':'currentColor'}/></button>
      {settings.showSeek&&<input aria-label="Playback position" type="range" min={0} max={project.duration} step={1/project.fps} value={time} onChange={e=>seek(+e.target.value)}/>}
      <span className="player-time">{time.toFixed(1)} / {project.duration.toFixed(1)}</span>
      {settings.showVolume&&<div className="player-volume"><button className="player-icon-button" aria-label={volume===0?'Unmute':'Mute'} title={volume===0?'Unmute':'Mute'} aria-pressed={volume===0} onClick={toggleMute}>{volume===0?<VolumeX size={20}/>:<Volume2 size={20}/>}</button><input aria-label="Volume" type="range" min="0" max="100" step="1" value={Math.round(volume*100)} onChange={e=>{const next=Number(e.target.value)/100;if(next>0)lastAudibleVolume.current=next;setVolume(next);}}/></div>}
      {settings.showLoop&&<button className="player-icon-button" aria-label="Loop story" title="Loop story" aria-pressed={loop} onClick={()=>setLoop(!loop)}><Repeat2 size={20}/></button>}
      {settings.showCaptions&&<button className="player-icon-button" aria-label="Captions" title="Captions" aria-pressed={captions} onClick={()=>setCaptions(!captions)}><Captions size={20}/></button>}
      {settings.showFullscreen&&<button className="player-icon-button" aria-label={fullscreen?'Exit fullscreen':'Fullscreen'} title={fullscreen?'Exit fullscreen':'Fullscreen'} onClick={()=>void toggleFullscreen()}>{fullscreen?<Minimize size={20}/>:<Maximize size={20}/>}</button>}
    </div>}
    {loading&&<p role="status" className="player-status">{buffering?'Buffering media…':'Preparing playback…'}</p>}
    {warning&&<p role="alert">{warning}</p>}
    {audioWarning&&<p role="alert">{audioWarning}</p>}
    {error&&<p role="alert">{error}</p>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Player/>);
