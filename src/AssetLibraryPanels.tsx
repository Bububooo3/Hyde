import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import { Box, ChevronRight, Download, Eye, Film, Folder, FolderOpen, ImagePlus, Library, Music2, Plus, Trash2, Type, Upload, X } from 'lucide-react';
import type { Asset, Project } from './model';
import { createElement,createProject,sceneIdAt, uid } from './model';
import { insertAssemblyAt } from './editing';
import { Stage } from './Stage';
import { buildLibraryTree, folderDepth, libraryPath, supportedLibraryFile } from './libraryTree';
import type { LibraryFile, LibraryFolder } from './libraryTree';
import { loadAssemblyFile } from './storage';
import {fontFamilyForAsset} from './projectFonts';

type Menu = { x: number; y: number; id: string };

function useOutsideMenu(close: () => void) {
  useEffect(() => {
    function dismiss(event: PointerEvent) { if (!(event.target instanceof Element) || !event.target.closest('.asset-context-menu')) close(); }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') close(); }
    document.addEventListener('pointerdown', dismiss, true); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', escape); };
  }, [close]);
}

function Preview({ title, onClose, children, wide=false }: { title: string; onClose: () => void; children: React.ReactNode; wide?:boolean }) {
  useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')onClose();};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[onClose]);
  return <div className="modal-backdrop" onPointerDown={onClose}><div className={`dialog asset-preview ${wide?'assembly-preview-dialog':''}`} role="dialog" aria-label={title} aria-modal="true" onPointerDown={event => event.stopPropagation()}><div className="dialog-title"><h2>{title}</h2><button className="icon-button" aria-label="Close preview" onClick={onClose}><X size={16}/></button></div>{children}</div></div>;
}

interface AssetProps {
  project: Project; time: number;
  onChangeProject: (project: Project) => void;
  onSelect: (ids: string[]) => void;
  onImportMedia: () => void;
}

export function ProjectAssets({ project, time, onChangeProject, onSelect, onImportMedia }: AssetProps) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useOutsideMenu(() => setMenu(null));
  function insert(asset: Asset) {
    const next = structuredClone(project);
    const source = next.elements.find(element => asset.kind==='font'?element.kind==='text'&&element.fontFamily===fontFamilyForAsset(asset):element.assetId === asset.id);
    const element = createElement(asset.kind === 'font' ? 'text' : asset.kind, { ...source, id: uid(), assetId:asset.kind==='font'?undefined:asset.id, fontFamily:asset.kind==='font'?fontFamilyForAsset(asset):source?.fontFamily, name: asset.name, start: time, duration: source?.duration ?? Math.max(1 / next.fps, next.duration - time), tracks: [], x: next.width / 2, y: next.height / 2,sceneId:sceneIdAt(next,time) });
    delete element.parentId; delete element.attachment; delete element.folderId;
    next.elements.push(element); next.duration = Math.max(next.duration, element.start + element.duration);
    onChangeProject(next); onSelect([element.id]); setMenu(null);
  }
  function context(event: MouseEvent, id: string) { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, id }); }
  const current = project.assets.find(asset => asset.id === menu?.id);
  const previewAsset = project.assets.find(asset => asset.id === preview);
  const inUse = current && project.elements.some(element => current.kind==='font'?element.kind==='text'&&element.fontFamily===fontFamilyForAsset(current):element.assetId === current.id);
  return <>
    <div className="panel-subhead"><span>Project assets</span><button className="icon-button" aria-label="Import media" title="Import media" onClick={onImportMedia}><Plus size={16}/></button></div>
    <div className="assets-grid">{project.assets.map(asset => <button key={asset.id} className="asset-card" title="Insert another instance" onClick={() => insert(asset)} onContextMenu={event => context(event, asset.id)}>{asset.kind === 'image' ? <img src={asset.dataUrl} alt=""/> : asset.kind === 'video' ? <Film size={30}/> : asset.kind === 'audio' ? <Music2 size={30}/> : asset.kind==='font'?<Type size={30}/>:<ImagePlus size={30}/>}<span>{asset.name}</span></button>)}</div>
    <button className="import-area" onClick={onImportMedia}><Upload size={20}/><strong>Import media</strong><span>Images, video & audio</span></button>
    {menu && current && <div className="context-menu asset-context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 180) }} onPointerDown={event => event.stopPropagation()}>
      <button onClick={() => insert(current)}><Plus size={14}/>Insert in scene</button>
      <button onClick={() => { setPreview(current.id); setMenu(null); }}><ImagePlus size={14}/>Preview</button>
      <hr/><button className="danger" disabled={!!inUse} title={inUse ? 'Remove every scene instance before removing this asset.' : 'Remove unused asset'} onClick={() => { const next = structuredClone(project); next.assets = next.assets.filter(asset => asset.id !== current.id); onChangeProject(next); setMenu(null); }}><Trash2 size={14}/>Remove unused asset</button>
    </div>}
    {previewAsset && <Preview title={previewAsset.name} onClose={() => setPreview(null)}>{previewAsset.kind === 'image' ? <img className="asset-preview-media" src={previewAsset.dataUrl} alt={previewAsset.name}/> : previewAsset.kind === 'video' ? <video className="asset-preview-media" src={previewAsset.dataUrl} controls/> : previewAsset.kind === 'audio' ? <audio className="asset-preview-audio" src={previewAsset.dataUrl} controls/> : <p style={{fontFamily:fontFamilyForAsset(previewAsset),fontSize:28}}>The quick brown fox jumps over the lazy dog.</p>}</Preview>}
  </>;
}

function LibraryAudio({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  useEffect(() => { const next = URL.createObjectURL(file); setUrl(next); return () => URL.revokeObjectURL(next); }, [file]);
  return <audio controls preload="none" src={url || undefined}/>;
}

function AssemblyVisualPreview({project,onNotice}:{project:Project;onNotice:(message:string)=>void}){
  const [time,setTime]=useState(0);
  const lastFrame=Math.max(0,project.duration-1/project.fps);
  return <div className="assembly-visual-preview">
    <div className="assembly-preview-frame"><Stage project={project} time={time} onError={onNotice}/></div>
    <label className="assembly-preview-scrub">Preview position <input type="range" aria-label="Assembly preview position" min={0} max={lastFrame} step={1/project.fps} value={time} onChange={event=>setTime(Number(event.target.value))}/><span>{time.toFixed(2)} s</span></label>
  </div>;
}

interface LibraryProps {
  files: File[]; depth: number; onDepthChange: (depth: number) => void;
  source: 'handle' | 'snapshot' | null; folderName: string; onRefresh: () => void;
  onOpenFolder: () => void; onInsertAssembly: (file: File) => void;
  onImportMedia: (files: File[]) => void; onNotice: (message: string) => void;
}

export function SessionLibrary({ files, depth, source, folderName, onRefresh, onDepthChange, onOpenFolder, onInsertAssembly, onImportMedia, onNotice }: LibraryProps) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [preview, setPreview] = useState<{ file: File; summary?: string; project?: Project } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useOutsideMenu(() => setMenu(null));
  useEffect(() => { setCollapsed(new Set()); setPreview(null); setMenu(null); }, [files]);
  const eligible = files.filter(supportedLibraryFile);
  const tree = buildLibraryTree(eligible);
  const hiddenCount = eligible.filter(file => folderDepth(file) > depth).length;
  function insert(file: File) { if (/\.hyproj$/i.test(file.name)) onInsertAssembly(file); else onImportMedia([file]); setMenu(null); }
  async function showPreview(file: File) {
    try {
      if (/\.hyproj$/i.test(file.name)) {
        const assembly = await loadAssemblyFile(file);
        const base=createProject(assembly.name);base.width=960;base.height=540;
        const project=insertAssemblyAt(base,assembly,0);
        setPreview({ file, project, summary: `${assembly.elements.length} object${assembly.elements.length === 1 ? '' : 's'} · ${assembly.assets.length} asset${assembly.assets.length === 1 ? '' : 's'}` });
      }
      else setPreview({ file });
    } catch (error) { onNotice(String(error)); }
    setMenu(null);
  }
  function toggleFolder(path: string) {
    setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  function renderFile(entry: LibraryFile) {
    const { file, name, path } = entry;
    return <div className="library-file" key={path} onContextMenu={event => { event.preventDefault(); setMenu({ id: path, x: event.clientX, y: event.clientY }); }}>
      {/\.hyproj$/i.test(name) ? <Box size={14} className="library-file-icon" aria-hidden="true"/> : <Music2 size={14} className="library-file-icon" aria-hidden="true"/>}
      <span className="library-file-name" title={path}>{name}</span>
      <button className="library-file-action" aria-label={`Preview ${name}`} onClick={() => void showPreview(file)}><Eye size={14}/></button>
      <button className="library-file-action library-insert" aria-label={`Insert ${name}`} onClick={() => insert(file)}><Plus size={14}/></button>
    </div>;
  }
  function renderFolder(folder: LibraryFolder, level: number) {
    const isCollapsed = collapsed.has(folder.path);
    return <div className="library-folder" key={folder.path}>
      <button className="library-folder-row" aria-expanded={!isCollapsed} onClick={() => toggleFolder(folder.path)}>
        <ChevronRight size={14} className={isCollapsed ? '' : 'expanded'} aria-hidden="true"/>
        <Folder size={14} aria-hidden="true"/>
        <span title={folder.path}>{folder.name}</span>
        <small>{folder.fileCount}</small>
      </button>
      {!isCollapsed && <div className="library-folder-children">
        {level < depth && folder.folders.map(child => renderFolder(child, level + 1))}
        {folder.files.map(renderFile)}
      </div>}
    </div>;
  }
  const current = menu && eligible.find(file => libraryPath(file) === menu.id && folderDepth(file) <= depth);
  return <>
    <div className="panel-subhead"><span>Session library</span><button className="icon-button" aria-label="Open component library folder" title="Open component library folder" onClick={onOpenFolder}><FolderOpen size={16}/></button></div>
    <div className="library-info"><p>Assemblies and audio from this session's folder.</p>{source&&<div className="library-connection"><span title={folderName}>{folderName} · {source==='handle'?'Connected':'Snapshot'}</span><button type="button" onClick={onRefresh}>{source==='handle'?'Refresh':'Reselect'}</button></div>}{source==='snapshot'&&<p>Reselect the folder to see files added or changed since opening it.</p>}<label className="number-field"><span>Folder depth</span><input type="number" aria-label="Folder depth" min={1} max={30} value={depth} onChange={event => onDepthChange(Math.max(1, Math.min(30, Number(event.target.value) || 1)))}/></label></div>
    {!!eligible.length && <div className="library-files" aria-label="Component library">{tree.folders.map(folder => renderFolder(folder, 1))}{tree.files.map(renderFile)}</div>}
    {!files.length && <button className="import-area" onClick={onOpenFolder}><Library size={25}/><strong>Open a component library</strong><span>Select a folder on your computer</span></button>}
    {!!files.length && !eligible.length && <p className="library-empty">No .hyproj or audio files in this folder.</p>}
    {hiddenCount > 0 && <p className="muted-note library-depth-note">{hiddenCount} file{hiddenCount === 1 ? '' : 's'} in deeper folders. Increase folder depth to show {hiddenCount === 1 ? 'it' : 'them'}.</p>}
    {menu && current && <div className="context-menu asset-context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 160) }} onPointerDown={event => event.stopPropagation()}><button onClick={() => insert(current)}><Plus size={14}/>Insert</button><button onClick={() => void showPreview(current)}><Eye size={14}/>Preview</button><button onClick={() => { void navigator.clipboard.writeText(libraryPath(current)).then(() => onNotice('Path copied')).catch(error => onNotice(String(error))); setMenu(null); }}><Download size={14}/>Copy relative path</button></div>}
    {preview && <Preview title={preview.file.name} onClose={() => setPreview(null)} wide={!!preview.project}>{preview.project ? <><AssemblyVisualPreview project={preview.project} onNotice={onNotice}/><p className="assembly-preview-summary">{preview.summary}</p><button className="primary assembly-preview-insert" onClick={()=>{insert(preview.file);setPreview(null);}}>Insert this assembly</button></> : <LibraryAudio file={preview.file}/>}</Preview>}
  </>;
}
