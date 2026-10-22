import { useEffect, useState } from 'react';
import { Copy, Link2, Link2Off, Scissors, Volume2, VolumeX } from 'lucide-react';
import type { Project, StoryElement } from './model';
import { getDefaultLinkSpeedPitch, setDefaultLinkSpeedPitch } from './model';
import { duplicateMediaClip, loadWaveform, setMediaFades, setMediaSourceWindow, setRecordingOffset, sourceWindow, splitMediaClip } from './audioClipEditing';
import './audio-clip.css';

interface Props {
  project: Project;
  element: StoryElement;
  time: number;
  onCommit: (project: Project) => void;
  onSelect: (id: string) => void;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function Waveform({ peaks, playhead, start, duration, sourceIn, sourceOut, assetDuration }: {
  peaks: number[]; playhead: number; start: number; duration: number; sourceIn: number; sourceOut: number; assetDuration: number;
}) {
  const bars = Array.from({ length: 88 }, (_, index) => {
    const from = Math.floor((sourceIn + (sourceOut - sourceIn) * index / 88) / assetDuration * peaks.length);
    const to = Math.max(from + 1, Math.ceil((sourceIn + (sourceOut - sourceIn) * (index + 1) / 88) / assetDuration * peaks.length));
    const peak = Math.max(0, ...peaks.slice(from, to));
    return <rect key={index} x={index * 1.136} y={20 - Math.max(1, peak * 18)} width=".77" height={Math.max(2, peak * 36)} />;
  });
  const marker = clamp((playhead - start) / duration * 100, 0, 100);
  return <svg className="audio-waveform" viewBox="0 0 100 40" role="img" aria-label="Audio waveform for the selected source range" preserveAspectRatio="none">
    <line x1="0" x2="100" y1="20" y2="20" className="audio-waveform-mid" />
    <g className="audio-waveform-bars">{bars}</g>
    {playhead >= start && playhead <= start + duration && <line x1={marker} x2={marker} y1="0" y2="40" className="audio-waveform-playhead" />}
  </svg>;
}

/** Clip-local controls shared by audio recordings and a video's embedded sound. */
export function AudioClipPanel({ project, element, time, onCommit, onSelect }: Props) {
  const asset = project.assets.find(item => item.id === element.assetId);
  const [waveform, setWaveform] = useState<{ peaks: number[]; duration: number } | null>(null);
  const [waveformError, setWaveformError] = useState(false);
  const [error, setError] = useState('');
  const [pitchDraft, setPitchDraft] = useState(String(element.pitchSemitones ?? 0));
  const [offsetDraft,setOffsetDraft]=useState(String(element.recordingOffset??0));
  const [defaultLinked, setDefaultLinked] = useState(getDefaultLinkSpeedPitch);
  const sourceDuration = asset?.duration || waveform?.duration || 0;
  const range = sourceDuration > 0 ? sourceWindow(element, sourceDuration) : { inTime: element.sourceOffset ?? 0, outTime: (element.sourceOffset ?? 0) + element.duration * (element.speed ?? 1) };
  const [draft, setDraft] = useState({ inTime: String(range.inTime), outTime: String(range.outTime), fadeIn: String(element.fadeIn ?? 0), fadeOut: String(element.fadeOut ?? 0) });

  useEffect(() => {
    setDraft({ inTime: String(range.inTime), outTime: String(range.outTime), fadeIn: String(element.fadeIn ?? 0), fadeOut: String(element.fadeOut ?? 0) });
  }, [element.id, element.sourceOffset, element.duration, element.speed, element.fadeIn, element.fadeOut, sourceDuration]);
  useEffect(() => { setPitchDraft(String(element.pitchSemitones ?? 0)); }, [element.id, element.pitchSemitones]);
  useEffect(() => { setOffsetDraft(String(element.recordingOffset ?? 0)); }, [element.id, element.recordingOffset]);
  useEffect(() => {
    if (!asset) return;
    let cancelled = false;
    setWaveform(null); setWaveformError(false);
    void loadWaveform(asset).then(value => { if (!cancelled) setWaveform(value); }).catch(() => { if (!cancelled) setWaveformError(true); });
    return () => { cancelled = true; };
  }, [asset?.id, asset?.dataUrl]);

  function attempt(work: () => void) {
    try { setError(''); work(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  function patchElement(patch: Partial<StoryElement>) {
    const next = structuredClone(project);
    Object.assign(next.elements.find(item => item.id === element.id)!, patch);
    onCommit(next);
  }
  function applyRange() {
    const inTime = draft.inTime.trim() === '' ? NaN : Number(draft.inTime);
    const outTime = draft.outTime.trim() === '' ? NaN : Number(draft.outTime);
    if (inTime === range.inTime && outTime === range.outTime) return;
    attempt(() => onCommit(setMediaSourceWindow(project, element.id, inTime, outTime)));
  }
  function applyFades() {
    const fadeIn = draft.fadeIn.trim() === '' ? NaN : Number(draft.fadeIn);
    const fadeOut = draft.fadeOut.trim() === '' ? NaN : Number(draft.fadeOut);
    if (fadeIn === (element.fadeIn ?? 0) && fadeOut === (element.fadeOut ?? 0)) return;
    attempt(() => onCommit(setMediaFades(project, element.id, fadeIn, fadeOut)));
  }
  function applyPitch() {
    const pitch = pitchDraft.trim() === '' ? NaN : Number(pitchDraft);
    if (pitch === (element.pitchSemitones ?? 0)) return;
    attempt(() => {
      if (!Number.isFinite(pitch) || pitch < -24 || pitch > 24) throw new Error('Pitch offset must be between −24 and +24 semitones.');
      patchElement({ pitchSemitones: pitch });
    });
  }
  function applyRecordingOffset(){
    const offset=offsetDraft.trim()===''?NaN:Number(offsetDraft);
    if(offset===(element.recordingOffset??0))return;
    attempt(()=>onCommit(setRecordingOffset(project,element.id,offset)));
  }
  function keyCommit(event: React.KeyboardEvent<HTMLInputElement>) { if (event.key === 'Enter') event.currentTarget.blur(); }
  const availableSplit = time > element.start + 1 / project.fps && time < element.start + element.duration - 1 / project.fps;

  return <section className="inspector-section audio-clip-panel">
    <h3>{asset?.kind === 'video' ? 'Video sound' : 'Audio clip'}</h3>
    {waveform && sourceDuration > 0 ? <Waveform peaks={waveform.peaks} playhead={time} start={element.start} duration={element.duration} sourceIn={range.inTime} sourceOut={range.outTime} assetDuration={sourceDuration} /> :
      <div className="audio-waveform-placeholder">{waveformError ? 'Waveform unavailable for this format' : 'Preparing waveform…'}</div>}
    <div className="audio-clip-actions">
      <button type="button" onClick={() => attempt(() => { const result = splitMediaClip(project, element.id, time); onCommit(result.project); onSelect(result.rightId); })} disabled={!availableSplit || !!element.loop}><Scissors size={13}/> Split at playhead</button>
      <button type="button" onClick={() => attempt(() => { const result = duplicateMediaClip(project, element.id); onCommit(result.project); onSelect(result.clipId); })}><Copy size={13}/> Duplicate</button>
    </div>
    <div className="audio-clip-fields">
      <label><span>Source in · s</span><input aria-label="Source in seconds" type="number" min="0" max={sourceDuration || undefined} step={1 / project.fps} value={draft.inTime} disabled={!sourceDuration || !!element.loop} onChange={event => setDraft(value => ({ ...value, inTime: event.target.value }))} onBlur={applyRange} onKeyDown={keyCommit}/></label>
      <label><span>Source out · s</span><input aria-label="Source out seconds" type="number" min="0" max={sourceDuration || undefined} step={1 / project.fps} value={draft.outTime} disabled={!sourceDuration || !!element.loop} onChange={event => setDraft(value => ({ ...value, outTime: event.target.value }))} onBlur={applyRange} onKeyDown={keyCommit}/></label>
      <label><span>Fade in · s</span><input aria-label="Fade in seconds" type="number" min="0" max={element.duration} step="0.05" value={draft.fadeIn} onChange={event => setDraft(value => ({ ...value, fadeIn: event.target.value }))} onBlur={applyFades} onKeyDown={keyCommit}/></label>
      <label><span>Fade out · s</span><input aria-label="Fade out seconds" type="number" min="0" max={element.duration} step="0.05" value={draft.fadeOut} onChange={event => setDraft(value => ({ ...value, fadeOut: event.target.value }))} onBlur={applyFades} onKeyDown={keyCommit}/></label>
      <label><span>Pitch offset · semitones</span><input aria-label="Pitch offset in semitones" type="number" min="-24" max="24" step="0.1" value={pitchDraft} onChange={event => setPitchDraft(event.target.value)} onBlur={applyPitch} onKeyDown={keyCommit}/></label>
      {element.recorded&&<label><span>Recording alignment · s</span><input aria-label="Recording alignment seconds" type="number" min="-5" max="5" step="0.01" value={offsetDraft} onChange={event=>setOffsetDraft(event.target.value)} onBlur={applyRecordingOffset} onKeyDown={keyCommit}/></label>}
      <label className="audio-pitch-link"><span>Speed and pitch</span><button type="button" aria-label={(element.linkSpeedPitch ?? true) ? 'Unlink pitch from speed' : 'Link pitch to speed'} aria-pressed={element.linkSpeedPitch ?? true} onClick={() => patchElement({ linkSpeedPitch: !(element.linkSpeedPitch ?? true) })}>{(element.linkSpeedPitch ?? true) ? <Link2 size={14}/> : <Link2Off size={14}/>} {(element.linkSpeedPitch ?? true) ? 'Linked' : 'Independent'}</button></label>
      <label><span>Volume · %</span><input aria-label="Clip volume percent" type="number" min="0" max="200" step="1" value={Math.round((element.volume ?? 1) * 100)} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) patchElement({ volume: clamp(value / 100, 0, 2) }); }}/></label>
      <label className="audio-clip-mute"><span>Playback</span><button type="button" aria-label={element.muted ? 'Unmute clip' : 'Mute clip'} aria-pressed={!!element.muted} onClick={() => patchElement({ muted: !element.muted })}>{element.muted ? <VolumeX size={14}/> : <Volume2 size={14}/>} {element.muted ? 'Muted' : 'Audible'}</button></label>
    </div>
    <label className="audio-pitch-default"><input type="checkbox" checked={defaultLinked} onChange={event => { setDefaultLinkSpeedPitch(event.target.checked); setDefaultLinked(event.target.checked); }}/> Link pitch to speed for new audio and video clips</label>
    <p className="muted-note">Large independent speed or pitch changes can alter transients and vocal tone. Preview the clip before exporting; longer sources may take time to process.</p>
    {element.loop && <p className="muted-note">Turn off Loop to trim or split this clip.</p>}
    {element.recorded&&<p className="muted-note">Positive values move the take later; negative values move it earlier. This does not change the recorded sound.</p>}
    {error && <p className="audio-clip-error" role="alert">{error}</p>}
  </section>;
}
