import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, DragEvent } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Circle, Copy, Download, Eye, EyeOff, Film, Folder, FolderPlus, ImagePlus, Layers, Link2, LockKeyhole, Music2, Plus, Search, Square, Target, Trash2, Triangle, Type, Unlink, UnlockKeyhole, Upload, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ElementKind, Project, StoryElement } from './model';
import { uid } from './model';
import { moveSceneFolder, parentId, removeSceneFolder, reparentElement } from './editing';
import { sceneRows } from './sceneTree';

const icons: Record<ElementKind, LucideIcon> = { rectangle: Square, ellipse: Circle, polygon: Triangle, text: Type, image: ImagePlus, video: Film, audio: Music2, group: Layers };
type Target = { type: 'element' | 'folder' | 'blank'; id?: string; x: number; y: number };
type DragItem = { type: 'element' | 'folder'; id: string };
type RenameItem = { type: 'element' | 'folder'; id: string };

interface Props {
  project: Project;
  time: number;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onChangeProject: (project: Project) => void;
  onAdd: (kind: ElementKind) => void;
  onImportMedia: () => void;
  onGroup: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  onPaste: () => void;
  canPaste: boolean;
  onExportAssembly: () => void;
  onEditPivot: () => void;
  onMoveLayer: (direction: number) => void;
  canMoveLayer: (direction: number) => boolean;
  onMaskObject: () => void;
  canMaskObject: boolean;
  onRemove: () => void;
  deleteLabel?: string;
  onNotice: (message: string) => void;
}

function IconButton({ icon: Icon, label, onClick, disabled = false }: { icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="icon-button" aria-label={label} title={label} disabled={disabled} onClick={onClick}><Icon size={16}/></button>;
}

export function SceneContents({ project, time, selected, onSelect, onChangeProject, onAdd, onImportMedia, onGroup, onDuplicate, onCopy, onPaste, canPaste, onExportAssembly, onEditPivot, onMoveLayer, canMoveLayer, onMaskObject, canMaskObject, onRemove, deleteLabel = 'Delete selection', onNotice }: Props) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<Target | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [renaming, setRenaming] = useState<RenameItem | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragItem = useRef<DragItem | null>(null);
  const anchor = useRef<string | null>(null);
  const rows = sceneRows(project, closed, query, kind);
  const visibleIds = rows.filter(row => row.type === 'element').map(row => row.element.id);
  const selectedHidden = selected.length > 0 && !visibleIds.includes(selected[0]);

  useEffect(() => {
    setQuery(''); setKind('all'); setClosed(new Set()); setMenu(null); setAddOpen(false); anchor.current = null;
  }, [project.id]);
  useEffect(() => {
    function dismiss(event: PointerEvent) {
      if (!(event.target instanceof Element) || !event.target.closest('.scene-context-menu')) setMenu(null);
      if (!(event.target instanceof Element) || !event.target.closest('.add-object-wrap')) setAddOpen(false);
    }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') { setMenu(null); setAddOpen(false); setRenaming(null); } }
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', escape); };
  }, []);

  function mutate(fn: (next: Project) => void) { const next = structuredClone(project); fn(next); onChangeProject(next); }
  function toggle(key: string) { setClosed(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; }); }
  function selectElement(id: string, event: MouseEvent) {
    event.preventDefault();
    if (event.shiftKey && anchor.current && visibleIds.includes(anchor.current)) {
      const a = visibleIds.indexOf(anchor.current), b = visibleIds.indexOf(id);
      onSelect(visibleIds.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (event.ctrlKey || event.metaKey) {
      onSelect(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]);
      anchor.current = id;
    } else { onSelect([id]); anchor.current = id; }
  }
  function openMenu(event: MouseEvent, type: Target['type'], id?: string) {
    event.preventDefault(); event.stopPropagation();
    if (type === 'element' && id) { onSelect(selected.includes(id) ? selected : [id]); anchor.current = id; }
    setAddOpen(false); setMenu({ type, id, x: event.clientX, y: event.clientY });
  }
  function beginRename(type: RenameItem['type'], id: string, current: string) { setRenameValue(current); setRenaming({ type, id }); setMenu(null); }
  function finishRename(cancel = false) {
    if (!renaming) return;
    const name = renameValue.trim();
    if (!cancel && name) mutate(next => {
      if (renaming.type === 'folder') { const folder = next.folders?.find(item => item.id === renaming.id); if (folder) folder.name = name; }
      else { const element = next.elements.find(item => item.id === renaming.id); if (element) element.name = name; }
    });
    setRenaming(null);
  }
  function createFolder(parent?: string) {
    const id = uid();
    mutate(next => { next.folders = [...(next.folders ?? []), { id, name: 'New folder', ...(parent ? { parentId: parent } : {}) }]; });
    if (parent) setClosed(previous => { const next = new Set(previous); next.delete(`folder:${parent}`); return next; });
    setAddOpen(false); setMenu(null); beginRename('folder', id, 'New folder');
  }
  function detach(id: string) {
    try { onChangeProject(reparentElement(project, id, undefined, time)); setMenu(null); }
    catch (error) { onNotice(String(error)); }
  }
  function startDrag(event: DragEvent, item: DragItem) {
    dragItem.current = item; event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-hyde-scene', `${item.type}:${item.id}`);
    event.dataTransfer.setData('text/plain', `${item.type}:${item.id}`);
    setMenu(null);
  }
  function drop(event: DragEvent, target: DragItem | null) {
    event.preventDefault(); event.stopPropagation(); setDropTarget(null);
    const moving = dragItem.current; dragItem.current = null;
    if (!moving || moving.id === target?.id && moving.type === target.type) return;
    try {
      if (moving.type === 'folder') {
        if (target?.type === 'element') return;
        onChangeProject(moveSceneFolder(project, moving.id, target?.id));
      } else if (target?.type === 'element') {
        const next = reparentElement(project, moving.id, target.id, time);
        delete next.elements.find(element => element.id === moving.id)?.folderId;
        onChangeProject(next);
      } else {
        const next = parentId(project.elements.find(element => element.id === moving.id)!)
          ? reparentElement(project, moving.id, undefined, time) : structuredClone(project);
        const element = next.elements.find(candidate => candidate.id === moving.id)!;
        if (target?.id) element.folderId = target.id; else delete element.folderId;
        onChangeProject(next);
      }
    } catch (error) { onNotice(String(error)); }
  }
  function dropOver(event: DragEvent, target: DragItem | null) {
    if (!dragItem.current) return;
    if (target?.type === 'element' && project.elements.find(element => element.id === target.id)?.kind !== 'group') return;
    if (dragItem.current.type === 'folder' && target?.type === 'element') return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropTarget(target ? `${target.type}:${target.id}` : 'root');
  }
  function addOption(label: string, icon: LucideIcon, action: () => void) { const Icon = icon; return <button key={label} type="button" onClick={() => { setAddOpen(false); action(); }}><Icon size={15}/>{label}</button>; }
  const activeElement = menu?.type === 'element' ? project.elements.find(element => element.id === menu.id) : undefined;
  const activeFolder = menu?.type === 'folder' ? project.folders?.find(folder => folder.id === menu.id) : undefined;

  return <>
    <div className="panel-subhead contents-heading"><span>Scene contents</span><span>{visibleIds.length} / {project.elements.length}</span></div>
    <div className="contents-tools"><label className="contents-search"><Search size={13}/><input aria-label="Search scene contents" placeholder="Search contents" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button aria-label="Clear contents search" onClick={() => setQuery('')}><X size={13}/></button>}</label><select aria-label="Filter scene contents by type" value={kind} onChange={event => setKind(event.target.value)}>{[['all','All types'],['shapes','Shapes'],['text','Text'],['image','Images'],['video','Videos'],['audio','Audio'],['group','Assemblies']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    {selectedHidden && <div className="contents-notice">Selection is inside a closed folder or hidden by a filter.<button onClick={() => { setQuery(''); setKind('all'); setClosed(new Set()); }}>Reveal</button></div>}
    <div id="scene-contents-list" className={`layers-list scene-tree ${dropTarget === 'root' ? 'scene-drop-target' : ''}`} onContextMenu={event => { if (event.target === event.currentTarget) openMenu(event, 'blank'); }} onDragOver={event => dropOver(event, null)} onDrop={event => drop(event, null)} onDragLeave={event => { if (event.target === event.currentTarget) setDropTarget(null); }}>
      {rows.map(row => {
        if (row.type === 'folder') {
          const folder = row.folder, key = `folder:${folder.id}`;
          return <div key={key} className={`layer-row scene-folder-row ${dropTarget === key ? 'scene-drop-target' : ''}`} style={{ paddingLeft: row.depth * 16 + 8, userSelect: 'none' }} draggable onDragStart={event => startDrag(event, { type: 'folder', id: folder.id })} onDragEnd={() => { dragItem.current = null; setDropTarget(null); }} onDragOver={event => dropOver(event, { type: 'folder', id: folder.id })} onDrop={event => drop(event, { type: 'folder', id: folder.id })} onContextMenu={event => openMenu(event, 'folder', folder.id)}>
            <button className="scene-disclosure" aria-label={`${row.expanded ? 'Collapse' : 'Expand'} folder ${folder.name}`} aria-expanded={row.expanded} onClick={() => toggle(key)}>{row.hasChildren ? row.expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/> : <span className="scene-disclosure-spacer"/>}</button><Folder size={14}/>
            {renaming?.type === 'folder' && renaming.id === folder.id ? <input className="scene-rename" aria-label="Rename folder" autoFocus value={renameValue} onChange={event => setRenameValue(event.target.value)} onFocus={event => event.target.select()} onBlur={() => finishRename()} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.currentTarget.dataset.cancel = 'true'; setRenaming(null); } }}/> : <span className="layer-name" onDoubleClick={() => beginRename('folder', folder.id, folder.name)}>{folder.name}</span>}
            <span className="scene-folder-count">{project.elements.filter(element => element.folderId === folder.id).length}</span>
          </div>;
        }
        const element = row.element, Icon = icons[element.kind], key = `element:${element.id}`;
        return <div key={key} className={`layer-row scene-element-row ${selected.includes(element.id) ? 'selected' : ''} ${element.hidden ? 'dimmed' : ''} ${dropTarget === key ? 'scene-drop-target' : ''}`} style={{ paddingLeft: row.depth * 16 + 8, userSelect: 'none' }} draggable onDragStart={event => startDrag(event, { type: 'element', id: element.id })} onDragEnd={() => { dragItem.current = null; setDropTarget(null); }} onDragOver={event => dropOver(event, { type: 'element', id: element.id })} onDrop={event => drop(event, { type: 'element', id: element.id })} onClick={event => selectElement(element.id, event)} onContextMenu={event => openMenu(event, 'element', element.id)}>
          {row.hasChildren ? <button className="scene-disclosure" aria-label={`${row.expanded ? 'Collapse' : 'Expand'} assembly ${element.name}`} aria-expanded={row.expanded} onClick={event => { event.stopPropagation(); toggle(key); }}>{row.expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button> : <span className="scene-disclosure"><span className="scene-disclosure-spacer"/></span>}
          {parentId(element) ? <Link2 size={12}/> : <Icon size={14}/>}
          {renaming?.type === 'element' && renaming.id === element.id ? <input className="scene-rename" aria-label="Rename object" autoFocus value={renameValue} onChange={event => setRenameValue(event.target.value)} onFocus={event => event.target.select()} onClick={event => event.stopPropagation()} onBlur={() => finishRename()} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.currentTarget.dataset.cancel = 'true'; setRenaming(null); } }}/> : <button type="button" className="layer-name" aria-label={`Select ${element.name}`} aria-pressed={selected.includes(element.id)} onDoubleClick={event => { event.stopPropagation(); beginRename('element', element.id, element.name); }}>{element.name}</button>}
          <button aria-label={element.hidden ? `Show ${element.name}` : `Hide ${element.name}`} title={element.hidden ? 'Show in story' : 'Hide in story'} onClick={event => { event.stopPropagation(); mutate(next => { next.elements.find(candidate => candidate.id === element.id)!.hidden = !element.hidden; }); }}>{element.hidden ? <EyeOff size={12}/> : <Eye size={12}/>}</button>
          <button aria-label={element.locked ? `Unlock ${element.name}` : `Lock ${element.name}`} title={element.locked ? 'Unlock element' : 'Lock element'} onClick={event => { event.stopPropagation(); mutate(next => { next.elements.find(candidate => candidate.id === element.id)!.locked = !element.locked; }); }}>{element.locked ? <LockKeyhole size={12}/> : <UnlockKeyhole size={12}/>}</button>
        </div>;
      })}
      {!!project.elements.length && !visibleIds.length && <div className="empty-state"><p>No matching elements.</p><button className="text-action" onClick={() => { setQuery(''); setKind('all'); }}>Clear filters</button></div>}
      {!project.elements.length && !(project.folders?.length) && <div className="empty-state"><Layers size={28}/><p>No elements yet.</p><small>Use Add object to make a shape, text, or assembly.</small></div>}
      {(project.elements.length > 0 || (project.folders?.length ?? 0) > 0) && <div className="scene-root-drop" onDragOver={event => dropOver(event, null)} onDrop={event => drop(event, null)} onContextMenu={event => openMenu(event, 'blank')}>Drop here to move to the top level</div>}
    </div>
    <div className="panel-bottom scene-panel-bottom"><div className="add-object-wrap"><IconButton icon={Plus} label="Add object" onClick={() => setAddOpen(value => !value)}/>{addOpen && <div className="object-menu" role="menu"><span className="scene-menu-heading">Shapes</span>{addOption('Rectangle', Square, () => onAdd('rectangle'))}{addOption('Ellipse', Circle, () => onAdd('ellipse'))}{addOption('Polygon', Triangle, () => onAdd('polygon'))}<span className="scene-menu-heading">Other</span>{addOption('Text', Type, () => onAdd('text'))}{addOption('Assembly', Layers, () => onAdd('group'))}{addOption('Folder', FolderPlus, () => createFolder())}{addOption('Import media', Upload, onImportMedia)}</div>}</div><IconButton icon={Layers} label="Create assembly from selection" disabled={!selected.length} onClick={onGroup}/><IconButton icon={ArrowUp} label="Bring forward" disabled={!canMoveLayer(1)} onClick={() => onMoveLayer(1)}/><IconButton icon={ArrowDown} label="Send backward" disabled={!canMoveLayer(-1)} onClick={() => onMoveLayer(-1)}/><div className="flex-spacer"/><IconButton icon={Trash2} label={deleteLabel} disabled={!selected.length} onClick={onRemove}/></div>
    {menu && <div className="context-menu scene-context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 310) }} onPointerDown={event => event.stopPropagation()}>
      {menu.type === 'element' && activeElement && <>
        <button onClick={() => beginRename('element', activeElement.id, activeElement.name)}><Type size={14}/>Rename</button>
        {activeElement.kind === 'group' && <button onClick={() => { toggle(`element:${activeElement.id}`); setMenu(null); }}><Layers size={14}/>{closed.has(`element:${activeElement.id}`) ? 'Expand assembly' : 'Collapse assembly'}</button>}
        {parentId(activeElement) && <button onClick={() => detach(activeElement.id)}><Unlink size={14}/>Detach from assembly</button>}
        <button onClick={() => { onDuplicate(); setMenu(null); }}><Copy size={14}/>Duplicate</button>
        <button onClick={() => { onCopy(); setMenu(null); }}><Copy size={14}/>Copy selection</button>
        <button disabled={!canPaste} onClick={() => { onPaste(); setMenu(null); }}><Copy size={14}/>Paste at playhead</button>
        <button onClick={() => { onGroup(); setMenu(null); }}><Layers size={14}/>Create assembly</button>
        <button onClick={() => { onExportAssembly(); setMenu(null); }}><Download size={14}/>Export assembly</button>
        <button onClick={() => { onEditPivot(); setMenu(null); }}><Target size={14}/>Edit pivot</button><hr/><button disabled={!canMoveLayer(1)} onClick={() => { onMoveLayer(1); setMenu(null); }}><ArrowUp size={14}/>Bring Forward</button><button disabled={!canMoveLayer(-1)} onClick={() => { onMoveLayer(-1); setMenu(null); }}><ArrowDown size={14}/>Send Backward</button>
        <button disabled={!canMaskObject} onClick={() => { onMaskObject(); setMenu(null); }}><Layers size={14}/>Mask Object</button>
        <hr/><button className="danger" onClick={() => { onRemove(); setMenu(null); }}><Trash2 size={14}/>Delete object</button>
      </>}
      {menu.type === 'folder' && activeFolder && <>
        <button onClick={() => beginRename('folder', activeFolder.id, activeFolder.name)}><Type size={14}/>Rename folder</button>
        <button onClick={() => createFolder(activeFolder.id)}><FolderPlus size={14}/>New subfolder</button>
        <button onClick={() => { toggle(`folder:${activeFolder.id}`); setMenu(null); }}><Folder size={14}/>{closed.has(`folder:${activeFolder.id}`) ? 'Expand folder' : 'Collapse folder'}</button>
        <hr/><button onClick={() => { onChangeProject(removeSceneFolder(project, activeFolder.id)); setMenu(null); }}><Trash2 size={14}/>Remove folder, keep contents</button>
      </>}
      {menu.type === 'blank' && <><button onClick={() => createFolder()}><FolderPlus size={14}/>New folder</button><button disabled={!canPaste} onClick={() => { onPaste(); setMenu(null); }}><Copy size={14}/>Paste at playhead</button><button onClick={() => { onAdd('rectangle'); setMenu(null); }}><Square size={14}/>Add rectangle</button><button onClick={() => { onImportMedia(); setMenu(null); }}><Upload size={14}/>Import media</button></>}
    </div>}
  </>;
}
