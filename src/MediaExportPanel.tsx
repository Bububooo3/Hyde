import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Film, Image as ImageIcon, LoaderCircle, X } from 'lucide-react';
import type { Project } from './model';
import { downloadBlob } from './storage';
import { hasProjectAudio } from './mediaExportAudio';
import type { ExportProgress, MediaExportFormat, MediaExportSettings, VideoCapability } from './mediaExport';
import './media-export.css';

const round = (value: number) => Math.round(value * 100) / 100;
const projectColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value) ? value : '#d9dde3';

/** Drop this into the existing Export dialog; it owns no project or editor state. */
export function MediaExportPanel({ project }: { project: Project }) {
  const [kind, setKind] = useState<'video' | 'gif'>('video');
  const [format, setFormat] = useState<'mp4' | 'webm'>('mp4');
  const [range, setRange] = useState<'whole' | 'selected'>('whole');
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(project.duration);
  const [width, setWidth] = useState(() => Math.min(1280, project.width));
  const [fps, setFps] = useState(() => Math.min(30, Math.max(1, project.fps)));
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('medium');
  const [loop, setLoop] = useState(true);
  const [background, setBackground] = useState(projectColor(project.background));
  const [includeAudio, setIncludeAudio] = useState(true);
  const [capabilities, setCapabilities] = useState<VideoCapability[]>([]);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null);
  const height = Math.max(16, Math.round(width * project.height / project.width));
  const projectHasAudio = useMemo(() => hasProjectAudio(project, range === 'whole' ? 0 : start, range === 'whole' ? project.duration : end), [project, range, start, end]);
  const needAudio = includeAudio && projectHasAudio;
  const currentStart = range === 'whole' ? 0 : start;
  const currentEnd = range === 'whole' ? project.duration : end;
  const selectedCapability = capabilities.find(capability => capability.format === format);

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    setChecking(true);
    const timer = setTimeout(() => {
      void import('./mediaExport').then(module => module.getVideoCapabilities(width, height, fps, needAudio, abort.signal)).then(next => {
        if (!active) return;
        setCapabilities(next);
        setFormat(previous => next.find(item => item.format === previous && item.supported) ? previous : next.find(item => item.recommended)?.format ?? previous);
        setChecking(false);
      }).catch(() => { if (active) { setCapabilities([]); setChecking(false); } });
    }, 250);
    return () => { active = false; abort.abort(); clearTimeout(timer); };
  }, [width, height, fps, needAudio]);

  const settings: MediaExportSettings = {
    format: kind === 'gif' ? 'gif' : format,
    start: currentStart,
    end: currentEnd,
    width, height, fps, quality, loop, background, includeAudio,
  };

  async function begin() {
    if (busy) return;
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    setMessage('');
    setProgress(null);
    try {
      const { exportMedia } = await import('./mediaExport');
      const result = await exportMedia(project, settings, { signal: next.signal, onProgress: setProgress });
      if (next.signal.aborted) return;
      downloadBlob(result.blob, result.fileName);
      setMessage(`Downloaded ${result.fileName} · ${result.frameCount} frames${result.includesAudio ? ' + audio' : ''}.`);
    } catch (error) {
      setMessage((error as Error)?.name === 'AbortError' ? 'Export canceled.' : error instanceof Error ? error.message : 'Export failed.');
    } finally {
      if (controller.current === next) controller.current = null;
      setBusy(false);
      setProgress(null);
    }
  }

  return <section className="media-export-panel" aria-label="Video and GIF export">
    <div className="media-export-heading"><strong>Video or GIF</strong><span>Render the stage to a local file.</span></div>
    <div className="media-export-kind" role="group" aria-label="Export type">
      <button type="button" className={kind === 'video' ? 'selected' : ''} aria-pressed={kind === 'video'} onClick={() => setKind('video')} disabled={busy}><Film size={16}/>Video</button>
      <button type="button" className={kind === 'gif' ? 'selected' : ''} aria-pressed={kind === 'gif'} onClick={() => setKind('gif')} disabled={busy}><ImageIcon size={16}/>GIF</button>
    </div>
    <div className="media-export-fields">
      <label>Range<select aria-label="Export range" value={range} onChange={event => setRange(event.target.value as 'whole' | 'selected')} disabled={busy}><option value="whole">Whole project</option><option value="selected">Selected times</option></select></label>
      {range === 'selected' && <div className="media-export-range">
        <label>From (s)<input aria-label="Export from seconds" type="number" min="0" max={Math.max(0, end - 1 / fps)} step={1 / fps} value={round(start)} onChange={event => setStart(Math.max(0, Math.min(+event.target.value, end - 1 / fps)))} disabled={busy}/></label>
        <label>To (s)<input aria-label="Export to seconds" type="number" min={Math.min(project.duration, start + 1 / fps)} max={project.duration} step={1 / fps} value={round(end)} onChange={event => setEnd(Math.min(project.duration, Math.max(+event.target.value, start + 1 / fps)))} disabled={busy}/></label>
      </div>}
      <div className="media-export-range">
        <label>Width (px)<input aria-label="Export width" type="number" min="16" max="4096" step="2" value={width} onChange={event => setWidth(Math.max(16, Math.min(4096, Math.round(+event.target.value) || 16)))} disabled={busy}/></label>
        <label>Frame rate<select aria-label="Export frame rate" value={fps} onChange={event => setFps(+event.target.value)} disabled={busy}>{(kind === 'gif' ? [6, 10, 15, 20, 24, 30, 50] : [12, 15, 24, 30, 48, 60]).map(value => <option key={value} value={value}>{value} fps</option>)}</select></label>
      </div>
      <span className="media-export-detail">Output: {width} × {height} px · {round(currentEnd - currentStart)} s</span>
      {kind === 'video' ? <>
        <label>Format<select aria-label="Video format" value={format} onChange={event => setFormat(event.target.value as 'mp4' | 'webm')} disabled={busy || checking}>{capabilities.length ? capabilities.map(capability => <option key={capability.format} value={capability.format} disabled={!capability.supported}>{capability.label}{capability.recommended ? ' · Recommended' : ''}{!capability.supported ? ' · unavailable' : ''}</option>) : <><option value="mp4">MP4</option><option value="webm">WebM</option></>}</select></label>
        {selectedCapability?.recommended && <span className="media-export-recommended">Recommended for this browser</span>}
        {selectedCapability?.reason && <span className="media-export-detail">{selectedCapability.reason}</span>}
        <label>Quality<select aria-label="Video quality" value={quality} onChange={event => setQuality(event.target.value as 'low' | 'medium' | 'high')} disabled={busy}><option value="low">Small file</option><option value="medium">Balanced</option><option value="high">High</option></select></label>
        {projectHasAudio && <label className="media-export-check"><input type="checkbox" checked={includeAudio} onChange={event => setIncludeAudio(event.target.checked)} disabled={busy}/>Include project audio</label>}
      </> : <>
        <label>Background<input aria-label="GIF background" type="color" value={background} onChange={event => setBackground(event.target.value)} disabled={busy}/></label>
        <label className="media-export-check"><input type="checkbox" checked={loop} onChange={event => setLoop(event.target.checked)} disabled={busy}/>Loop GIF</label>
        <span className="media-export-detail">GIF is silent. Colors are reduced to 256 per frame.</span>
      </>}
    </div>
    {progress && <div className="media-export-progress"><progress aria-label="Export progress" value={progress.completed} max={Math.max(1, progress.total)}/><span>{progress.phase === 'audio' ? 'Mixing audio' : progress.phase === 'finalizing' ? 'Finishing file' : 'Rendering frames'} · {Math.round(progress.completed / Math.max(1, progress.total) * 100)}%</span></div>}
    {message && <p className="media-export-message" role="status">{message}</p>}
    <div className="media-export-actions">
      {busy && <button type="button" className="secondary" onClick={() => controller.current?.abort()}><X size={15}/>Cancel</button>}
      <button type="button" className="primary" onClick={() => void begin()} disabled={busy || kind === 'video' && (checking || !selectedCapability?.supported)}>{busy ? <LoaderCircle size={15} className="media-export-spin"/> : <Download size={15}/>}Export {kind === 'gif' ? 'GIF' : format.toUpperCase()}</button>
    </div>
  </section>;
}
