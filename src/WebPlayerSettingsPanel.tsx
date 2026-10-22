import type {Project, WebPlayerSettings} from './model';
import {finalPlayerFrameTime,webPlayerSettings} from './webPlayerSettings';
import './web-player-settings.css';

export function WebPlayerSettingsPanel({project,onChange}:{project:Project;onChange:(settings:WebPlayerSettings)=>void}) {
  const settings=webPlayerSettings(project);
  const patch=(change:Partial<WebPlayerSettings>)=>onChange({...settings,...change});
  const check=(key:Exclude<keyof WebPlayerSettings,'posterTime'>,label:string)=><label className="check-row" key={key}><input type="checkbox" checked={settings[key]} onChange={event=>patch({[key]:event.target.checked})}/>{label}</label>;
  return <section className="web-player-settings" aria-label="Standalone player settings">
    <h3>Standalone player</h3>
    <p className="muted-note">The poster is shown before play. Playback starts at the beginning, and holds the final frame when looping is off.</p>
    <label className="number-field"><span>Poster frame · s</span><input aria-label="Poster frame time" type="number" min="0" max={finalPlayerFrameTime(project)} step={1/project.fps} value={settings.posterTime} onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value))patch({posterTime:Math.min(finalPlayerFrameTime(project),Math.max(0,Math.round(value*project.fps)/project.fps))});}}/></label>
    {check('loop','Loop story by default')}
    {check('controlsVisible','Show playback controls')}
    {settings.controlsVisible&&<div className="web-player-control-options" aria-label="Visible playback controls">
      {check('showSeek','Seek bar')}
      {check('showVolume','Volume')}
      {check('showFullscreen','Fullscreen')}
      {check('showCaptions','Captions')}
      {check('showLoop','Loop toggle')}
    </div>}
  </section>;
}
