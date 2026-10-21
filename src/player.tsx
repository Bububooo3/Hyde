import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import { useEffect,useRef,useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Captions, LoaderCircle, Maximize, Minimize, Pause, Play, RotateCcw } from 'lucide-react';
import {captionWindow,type Project} from './model';
import { Stage } from './Stage';
import { AudioTransport } from './audio';
import {materializeScenePlacements} from './scenePlacement';
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
  const [project,setProject]=useState<Project|null>(null),[error,setError]=useState(''),[time,setTime]=useState(0),[playing,setPlaying]=useState(false),[captions,setCaptions]=useState(true),[loading,setLoading]=useState(false),[fullscreen,setFullscreen]=useState(false);
  const audio=useRef(new AudioTransport());const frame=useRef<HTMLDivElement>(null);
  useEffect(()=>{loadStory().then(setProject).catch(e=>setError(String(e)));return()=>audio.current.destroy();},[]);
  useEffect(()=>{const update=()=>setFullscreen(document.fullscreenElement===frame.current);document.addEventListener('fullscreenchange',update);return()=>document.removeEventListener('fullscreenchange',update);},[]);
  useEffect(()=>{if(!playing||!project)return;let raf=0;const tick=()=>{const t=Math.min(project.duration,audio.current.time);setTime(t);audio.current.update(project,t);if(t>=project.duration){setPlaying(false);audio.current.stop();}else raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf);},[playing,project]);
  async function play(){if(!project||loading)return;if(playing){audio.current.stop();setPlaying(false);return;}const t=time>=project.duration?0:time;setTime(t);setLoading(true);try{await audio.current.play(project,t);setPlaying(true);}catch(e){setError(String(e));}finally{setLoading(false);}}
  function seek(t:number){audio.current.stop();setPlaying(false);setTime(t);}
  async function toggleFullscreen(){try{if(document.fullscreenElement===frame.current)await document.exitFullscreen();else await frame.current?.requestFullscreen();}catch(e){setError(`Fullscreen is unavailable: ${String(e)}`);}}
  if(!project)return <main className="player-empty">{error||'Loading story…'}</main>;
  const caption=materializeScenePlacements(project).captions.find(c=>{const window=captionWindow(project,c);return !!window&&time>=window.start&&time<window.end;});
  const playbackLabel=loading?'Preparing playback':playing?'Pause':time>=project.duration?'Replay':'Play';
  const PlaybackIcon=loading?LoaderCircle:playing?Pause:time>=project.duration?RotateCcw:Play;
  return <main className="player">
    <div className="player-heading"><strong>{project.name}</strong></div>
    <div ref={frame} className="player-frame" style={{'--stage-aspect':String(project.width/project.height)} as React.CSSProperties}>
      <div className="player-screen" style={{aspectRatio:`${project.width}/${project.height}`}}><Stage project={project} time={time} onError={setError}/>{captions&&caption&&<div className="captions">{caption.text}</div>}</div>
      <button className="player-icon-button player-fullscreen-exit" aria-label="Exit fullscreen" title="Exit fullscreen" onClick={()=>void toggleFullscreen()}><Minimize size={20}/></button>
    </div>
    <div className="player-controls">
      <button className="player-icon-button" aria-label={playbackLabel} title={playbackLabel} onClick={()=>void play()} disabled={loading}><PlaybackIcon size={20} className={loading?'spin':undefined} fill={playing||loading?'none':'currentColor'}/></button>
      <input aria-label="Playback position" type="range" min={0} max={project.duration} step={1/project.fps} value={time} onChange={e=>seek(+e.target.value)}/>
      <span className="player-time">{time.toFixed(1)} / {project.duration.toFixed(1)}</span>
      <button className="player-icon-button" aria-label="Captions" title="Captions" aria-pressed={captions} onClick={()=>setCaptions(!captions)}><Captions size={20}/></button>
      <button className="player-icon-button" aria-label={fullscreen?'Exit fullscreen':'Fullscreen'} title={fullscreen?'Exit fullscreen':'Fullscreen'} onClick={()=>void toggleFullscreen()}>{fullscreen?<Minimize size={20}/>:<Maximize size={20}/>}</button>
    </div>
    {error&&<p role="alert">{error}</p>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Player/>);
