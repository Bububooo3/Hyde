import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Camera, ChevronDown, ChevronRight, Circle, Copy, Download, Eye, EyeOff, FilePlus2, FolderOpen, Grip, HelpCircle, ImagePlus, Layers, Link2, LockKeyhole, Mic, MousePointer2, Pause, Play, Plus, Redo2, RotateCcw, Save, Settings2, SkipBack, Sparkles, Square, Target, Trash2, Triangle, Type, Undo2, UnlockKeyhole, Upload, Volume2, X, ZoomIn, ZoomOut, Diamond, Library, Film, Music2, Scissors, Search, Grid3X3, PanelRightClose, PanelRightOpen, PanelBottomClose, PanelBottomOpen } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AnimProperty, Assembly, AssemblyGapTransition, AssemblyTextureOverlap, Asset, CameraProperty, EasingFamily, ElementKind, Project, StoryElement, TextAnimation } from './model';
import { assignSceneOwnership,captionWindow,createElement, createProject,elementWindow,sceneIdAt, uid } from './model';
import { createExampleProject } from './example';
import {createPrimaryShowcase} from './showcase';
import { cameraToStage, evaluateCamera, evaluateCameraForScene, evaluateElement, evaluateProject, stageToCamera } from './engine';
import { Stage, SelectionOverlay } from './Stage';
import {PathOverlay} from './PathOverlay';
import {PinOverlay} from './PinOverlay';
import { SceneContents } from './SceneContents';
import { ProjectAssets, SessionLibrary } from './AssetLibraryPanels';
import {scanLibraryDirectory,type LibraryDirectoryHandle} from './libraryDirectory';
import { AudioTransport } from './audio';
import { projectEffectTails } from './mediaExportAudio';
import { downloadBlob, loadAssemblyFile, loadAutosave, listAutosaves, loadProjectFile, saveAssemblyBlob, saveAutosave, saveProjectBlob } from './storage';
import { parentId, descendantIds, makeAssembly, insertAssemblyAt, duplicateElements, reparentElement } from './editing';
import { copyObjects, pasteObjects, type ObjectClipboard } from './clipboard';
import { exportWeb } from './export';
import { canWriteProjectFile, chooseProjectSaveFile, chooseProjectToOpen, writeProjectFile, type HydeFileHandle } from './fileHandles';
import { setPivotWithoutMovingArt } from './stageGeometry';
import { rotateSelectionAroundWorldPoint, type WorldPoint } from './worldPointRotation';
import {projectRenderOptimization} from './renderOptimization';
import {movePathAnchor,pointInShapePath,removePathPoint,setPathHandle,splitPathSegment,withEditablePath,worldToPathPoint} from './shapePath';
import {DEFAULT_PIN_CORNERS,pointInPinCorners,validPinCorners,type PinCorners} from './projectivePin';
import {applyMediaFill} from './mediaPlacement';
import {MotionBehaviorsPanel} from './MotionBehaviorsPanel';
import {MotionPathOverlay,worldToMotionPoint} from './MotionPathOverlay';
import {motionPathLocalAnchor,motionPathWorldAnchor} from './motionPathAnchor';
import {MOTION_LIMITS} from './motion';
import {MediaTransformPanel} from './MediaTransformPanel';
import {ProjectFontsPanel} from './ProjectFontsPanel';
import {GoogleFontsPanel} from './GoogleFontsPanel';
import {TextFlowPanel} from './TextFlowPanel';
import {TextReflowPanel} from './TextReflowPanel';
import {recordingPlaybackProject} from './recording';
import {TextureKeyPanel} from './TextureKeyPanel';
import type {CuratedFontAsset} from './curatedFonts';
import {addProjectFont,ProjectFontLoader} from './projectFonts';
import {captureStaticTextShapeLayout} from './textFlow';
import { TooltipLayer } from './TooltipLayer';
import { StageGuides } from './StageGuides';
import { AudioEffectsPanel } from './AudioEffectsPanel';
import { AudioClipPanel } from './AudioClipPanel';
import {setMediaSpeed} from './audioClipEditing';
import {mapSceneFramePoint,unmapSceneFramePoint} from './sceneFrame';
import { MediaExportPanel } from './MediaExportPanel';
import { WebPlayerSettingsPanel } from './WebPlayerSettingsPanel';
import { CameraPanel } from './CameraPanel';
import {LinkedScenePanel} from './LinkedScenePanel';
import { rulerStep, rulerTicks } from './timeline';
import { moveTimelineItems, timelineNudgeStep, trimTimelineClips, type TimelineItem } from './timelineSelection';
import {snapTimelineDelta,snapTimelineTime,timelineSnapTargets} from './timelineSnap';
import { deleteScene, duplicateScene, moveScene, retimeScene } from './sceneOperations';
import {addCaption,deleteCaption,editCaption} from './captionEditing';
import {captureAssemblyClip,editAssemblyClipGapTransition,editAssemblyClipInstance,editAssemblyClipPriority,editAssemblyTextureOverlap,placeAssemblyClip,removeAssemblyClipInstance,selectAssemblyClipGapSegments} from './assemblyClips';
import {groupAssemblyGapSegments} from './assemblyGapView';
import {AssemblyGapBands,AssemblyGapPanel} from './AssemblyGapPanel';
import {AssemblyMixPanel} from './AssemblyMixPanel';
import {AssemblyClipEditorPanel} from './AssemblyClipEditorPanel';
import {AssemblyStructurePanel} from './AssemblyStructurePanel';
import {AssemblyMasterRows} from './AssemblyMasterRows';
import {addAssemblyClipKey,assemblyTrackView,editAssemblyClipKey,removeAssemblyClipKey,resetAssemblyClipTrackOverride,type AssemblyKeyPatch,type AssemblyTrackTarget} from './assemblyClipEditing';
import {ClipDraftConflictError,deleteClipDraft,loadClipDraft,recoverClipDraftCopy,restoreClipDraft,saveClipDraft,type ClipEditKind,type SavedClipDraft} from './clipEditDrafts';
import type {AssemblyMasterKey} from './assemblyMaster';
import { makeSceneIndependent, materializeScenePlacements, placeLinkedScene } from './scenePlacement';
import { alignSelection, type Alignment } from './alignment';
import {snapStagePosition,type StageAlignmentGuides} from './stageAlignment';
import './timeline.css';

const ICONS:Record<ElementKind,LucideIcon>={rectangle:Square,ellipse:Circle,polygon:Triangle,text:Type,image:ImagePlus,video:Film,audio:Music2,group:Layers};
const PROPERTY_ICONS:Record<AnimProperty,LucideIcon>={x:Target,y:Target,rotation:RotateCcw,scaleX:ZoomIn,scaleY:ZoomIn,opacity:Eye,fill:Circle,volume:Volume2,assetId:ImagePlus};
const PROPERTY_LABELS:Record<AnimProperty,string>={x:'Position X',y:'Position Y',rotation:'Rotation',scaleX:'Scale X',scaleY:'Scale Y',opacity:'Opacity',fill:'Fill',volume:'Volume',assetId:'Texture'};
const DEFAULT_TEXT_ANIMATION:TextAnimation={unit:'word',effect:'fade',direction:'in',start:0,duration:.5,stagger:.14,easing:'sine',easingDirection:'inOut',distance:35,seed:1,amplitude:12,frequency:2};
const FAMILIES:EasingFamily[]=['linear','sine','quad','cubic','quart','quint','expo','circ','back','bounce','elastic'];
const clone=<T,>(v:T):T=>structuredClone(v);
const safeName=(s:string)=>s.replace(/[<>:"/\\|?*]/g,'_')||'Untitled';
const round=(n:number)=>Math.round(n*100)/100;
const clamp=(n:number,a:number,b:number)=>Math.min(b,Math.max(a,n));
const readData=(file:File)=>new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=()=>reject(new Error('Unable to read file'));r.readAsDataURL(file);});
const AUDIO_MIME_BY_EXTENSION:Record<string,string>={mp3:'audio/mpeg',m4a:'audio/mp4',aac:'audio/aac',wav:'audio/wav',wave:'audio/wav',ogg:'audio/ogg',oga:'audio/ogg',opus:'audio/ogg',flac:'audio/flac'};
const mediaMime=(file:File)=>/^(image|video|audio)\//.test(file.type)?file.type:AUDIO_MIME_BY_EXTENSION[file.name.toLowerCase().split('.').pop()??'']??'';
interface ClipEditSession {kind:ClipEditKind;targetId:string;base:Project;draft:Project;dirty:boolean}

function Button({icon:Icon,label,onClick,active=false,disabled=false,className=''}:{icon:LucideIcon;label:string;onClick?:()=>void;active?:boolean;disabled?:boolean;className?:string}){return <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled} className={`icon-button ${active?'active':''} ${className}`} onClick={onClick}><Icon size={16}/></button>;}
function NumberField({label,value,onChange,min,max,step=1,disabled=false}:{label:string;value:number;onChange:(n:number)=>void;min?:number;max?:number;step?:number;disabled?:boolean}) {return <label className="number-field"><span>{label}</span><input aria-label={label} type="number" value={Number.isFinite(value)?round(value):0} min={min} max={max} step={step} disabled={disabled} onChange={e=>{if(e.target.value!==''){const n=+e.target.value;if(Number.isFinite(n))onChange(clamp(n,min??-1e6,max??1e6));}}}/></label>;}
function LibraryAudio({file}:{file:File}){const [url,setUrl]=useState('');useEffect(()=>{const next=URL.createObjectURL(file);setUrl(next);return()=>URL.revokeObjectURL(next);},[file]);return <audio controls preload="none" src={url||undefined}/>;}
function CaptionTimeField({label,value,onCommit}:{label:string;value:number;onCommit:(value:number)=>boolean}){
  const [draft,setDraft]=useState(String(round(value)));
  const cancelled=useRef(false);
  useEffect(()=>setDraft(String(round(value))),[value]);
  const commitDraft=()=>{const next=Number(draft);if(!Number.isFinite(next)||!onCommit(next))setDraft(String(round(value)));};
  return <label className="number-field"><span>{label}</span><input aria-label={label} type="number" step="any" value={draft} onChange={event=>setDraft(event.target.value)} onBlur={()=>{if(cancelled.current){cancelled.current=false;return;}commitDraft();}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}else if(event.key==='Escape'){event.preventDefault();cancelled.current=true;setDraft(String(round(value)));event.currentTarget.blur();}}}/></label>;
}

export default function App(){
  const [project,setProject]=useState<Project>(()=>assignSceneOwnership(createExampleProject())); const projectRef=useRef(project);projectRef.current=project;
  const effectTails=useMemo(()=>projectEffectTails(project),[project]);
  const audioTail=effectTails.reduce((longest,tail)=>Math.max(longest,tail.end-project.duration),0);
  const [selected,setSelected]=useState<string[]>([]),[time,setTime]=useState(0),[playing,setPlaying]=useState(false),[preparing,setPreparing]=useState(false);
  const [tailPlaying,setTailPlaying]=useState(false);
  const [recordKeys,setRecordKeys]=useState(false),[pivotMode,setPivotMode]=useState(false),[axes,setAxes]=useState<'world'|'local'>('world'),[snap,setSnap]=useState(true),[ripple,setRipple]=useState(false);
  const [rotationOrigin,setRotationOrigin]=useState<'pivot'|'world'>('pivot'),[worldPoint,setWorldPoint]=useState<WorldPoint>({x:0,y:0}),[pickingWorldPoint,setPickingWorldPoint]=useState(false);
  const [gridEnabled,setGridEnabled]=useState(false),[gridCount,setGridCount]=useState(8),[onionPrevious,setOnionPrevious]=useState(false),[onionNext,setOnionNext]=useState(false);
  const [alignmentGuides,setAlignmentGuides]=useState<StageAlignmentGuides|null>(null);
  const [pathEditMode,setPathEditMode]=useState(false),[activePathPoint,setActivePathPoint]=useState(0);
  const [pinEditMode,setPinEditMode]=useState(false);
  const [editingMotionId,setEditingMotionId]=useState<string|null>(null),[activeMotionPoint,setActiveMotionPoint]=useState(0);
  const [leftTab,setLeftTab]=useState<'layers'|'assets'|'library'>('layers'),[libraryFiles,setLibraryFiles]=useState<File[]>([]),[libraryDepth,setLibraryDepth]=useState(4),[hiddenSections,setHiddenSections]=useState<string[]>([]);
  const [librarySource,setLibrarySource]=useState<'handle'|'snapshot'|null>(null),[libraryName,setLibraryName]=useState('');
  const [splash,setSplash]=useState(true),[recent,setRecent]=useState<Project|null>(null),[dialog,setDialog]=useState<'help'|'export'|'settings'|'overwrite'|null>(null),[menu,setMenu]=useState<string|null>(null);
  const [skipOverwriteNotice,setSkipOverwriteNotice]=useState(false);
  const [notice,setNotice]=useState(''),[saveStatus,setSaveStatus]=useState('Local workspace'),[fileStatus,setFileStatus]=useState('Not saved to file'),[zoom,setZoom]=useState(1),[pan,setPan]=useState({x:0,y:0}),[stageSize,setStageSize]=useState({width:0,height:0}),[leftWidth,setLeftWidth]=useState(220),[rightWidth,setRightWidth]=useState(252),[rightCollapsed,setRightCollapsed]=useState(false),[timelineHeight,setTimelineHeight]=useState(()=>Math.max(205,Math.round(window.innerHeight*.29))),[timelineCollapsed,setTimelineCollapsed]=useState(false),[timelineScale,setTimelineScale]=useState(1),[showAll,setShowAll]=useState(true);
  const [history,setHistory]=useState<Project[]>([]),[future,setFuture]=useState<Project[]>([]),[expanded,setExpanded]=useState<string[]>([]),[keySelection,setKeySelection]=useState<{element:string;property:AnimProperty;key:string}|null>(null);
  const [timelineItems,setTimelineItems]=useState<TimelineItem[]>([]);
  const [timelineMarquee,setTimelineMarquee]=useState<{left:number;top:number;width:number;height:number}|null>(null);
  const [context,setContext]=useState<{x:number;y:number}|null>(null),[busy,setBusy]=useState(''),[recording,setRecording]=useState(false),[muteWhileRecording,setMuteWhileRecording]=useState(false),[monitorWhileRecording,setMonitorWhileRecording]=useState(false);
  const [timelineContext,setTimelineContext]=useState<{x:number;y:number;kind:'ruler'|'scene'|'clip'|'key'|'cameraKey'|'property';element?:string;property?:AnimProperty|CameraProperty;key?:string;scene?:string;at?:number}|null>(null);
  const [sceneDialog,setSceneDialog]=useState<{id:string;kind:'rename'|'duration';value:string}|null>(null);
  const [sceneRename,setSceneRename]=useState<{id:string;value:string}|null>(null);
  const [selectedCaptionId,setSelectedCaptionId]=useState<string|null>(null);
  const [clipCaptureName,setClipCaptureName]=useState('Animation clip'),[clipCaptureLength,setClipCaptureLength]=useState('2');
  const [focusedAssemblyGap,setFocusedAssemblyGap]=useState<string|null>(null);
  const [focusedAssemblyInstance,setFocusedAssemblyInstance]=useState<string|null>(null);
  const [focusedAssemblyTrack,setFocusedAssemblyTrack]=useState<{rootId:string;elementId:string;property:AnimProperty;scope:'shared'|'instance';keyIndex:number}|null>(null);
  const [clipSession,setClipSession]=useState<ClipEditSession|null>(null),clipSessionRef=useRef<ClipEditSession|null>(null);
  const [staleClipDraft,setStaleClipDraft]=useState<SavedClipDraft|null>(null),staleClipDraftRef=useRef<SavedClipDraft|null>(null);
  const [staleDraftIssue,setStaleDraftIssue]=useState(''),[showStaleDraft,setShowStaleDraft]=useState(false),[staleDraftBusy,setStaleDraftBusy]=useState(false);
  const draftLookup=useRef<Project|null>(null);
  const objectClipboard=useRef<ObjectClipboard|null>(null),pasteCount=useRef(0);
  const [clipLeavePrompt,setClipLeavePrompt]=useState(false);
  const clipSessionOpener=useRef<HTMLElement|null>(null),appRoot=useRef<HTMLDivElement>(null);
  const [previewingAudioId,setPreviewingAudioId]=useState<string|null>(null);
  const [timelineWidth,setTimelineWidth]=useState(800);
  const [visibleTimelineRange,setVisibleTimelineRange]=useState<[number,number]>([0,Number.POSITIVE_INFINITY]);
  const [projectFileExtension,setProjectFileExtension]=useState('.hyde');
  const [recentProjects,setRecentProjects]=useState<Project[]>([]);
  const stageBox=useRef<HTMLDivElement>(null),stageWorkspace=useRef<HTMLDivElement>(null),workspaceBox=useRef<HTMLDivElement>(null),timelineBody=useRef<HTMLDivElement>(null),fileInput=useRef<HTMLInputElement>(null),mediaInput=useRef<HTMLInputElement>(null),fontInput=useRef<HTMLInputElement>(null),assemblyInput=useRef<HTMLInputElement>(null),libraryInput=useRef<HTMLInputElement>(null);
  const libraryHandle=useRef<LibraryDirectoryHandle|null>(null);
  const transport=useRef(new AudioTransport()),playRef=useRef(false),recorder=useRef<MediaRecorder|null>(null),recStream=useRef<MediaStream|null>(null);
  const recordingPlayback=useRef<Project|null>(null),finishRecording=useRef<(()=>void)|null>(null);
  const recordingMonitor=useRef<AudioContext|null>(null);
  const previewReturn=useRef<{time:number;playing:boolean}|null>(null),previewToken=useRef(0);
  const cancelledSceneRename=useRef<string|null>(null);
  const drag=useRef<{base:Project;id:string;mode:'move'|'resize'|'rotate'|'pivot';px:number;py:number;start:StoryElement;world:StoryElement;rotationCenter?:WorldPoint;rotationIds?:string[]}|null>(null);
  const pathDrag=useRef<{base:Project;id:string;index:number;handle:'anchor'|'in'|'out';pose:StoryElement;moved:boolean}|null>(null);
  const pinDrag=useRef<{base:Project;id:string;index:number;pose:StoryElement;moved:boolean}|null>(null);
  const motionPathDrag=useRef<{base:Project;id:string;behaviorId:string;index:number;handle:'anchor'|'in'|'out';pose:StoryElement;parent:StoryElement|null;moved:boolean}|null>(null);
  const timelineDrag=useRef<{base:Project;id:string;mode:'move'|'trim';x:number;start:number;duration:number;pixels:number;items:TimelineItem[];anchors:number[];targets:number[]}|null>(null);
  const keyDrag=useRef<{base:Project;element:string;property:AnimProperty;key:string;x:number;start:number;anchor:number;pixels:number;moved:boolean;items:TimelineItem[];targets:number[]}|null>(null);
  const cameraDrag=useRef<{base:Project;sequenceId:string;start:number;anchor:number;x:number;pixels:number;moved:boolean;items:TimelineItem[];targets:number[]}|null>(null);
  const assemblyClipDrag=useRef<{base:Project;rootId:string;instanceId:string;mode:'move'|'trim';at:number;duration:number;x:number;pixels:number;moved:boolean;targets:number[]}|null>(null),assemblyClipClickSuppressed=useRef(false);
  const assemblyMasterDrag=useRef<{base:Project;target:AssemblyTrackTarget;keyIndex:number;time:number;anchor:number;x:number;pixels:number;sourceRate:number;moved:boolean;targets:number[]}|null>(null),assemblyMasterClickSuppressed=useRef(false);
  const timelineAnchor=useRef<TimelineItem|null>(null);
  const timelineMarqueeDrag=useRef<{x:number;y:number;currentX:number;currentY:number;extend:boolean;pointerId:number;lane:Element}|null>(null);
  const playheadDrag=useRef<number|null>(null),rulerBody=useRef<HTMLDivElement>(null);
  const lastSave=useRef(0),dirty=useRef(false);
  const panDrag=useRef<{x:number;y:number;originX:number;originY:number}|null>(null);
  const panelDrag=useRef<{x:number;width:number}|null>(null);
  const rightPanelDrag=useRef<{x:number;width:number}|null>(null),timelinePanelDrag=useRef<{y:number;height:number}|null>(null);
  const marqueeDrag=useRef<{x:number;y:number;currentX:number;currentY:number;extend:boolean}|null>(null);
  const [marquee,setMarquee]=useState<{x:number;y:number;width:number;height:number}|null>(null);
  const projectHandle=useRef<HydeFileHandle|null>(null);
  const selectedElement=project.elements.find(e=>e.id===selected[0])??null;
  const clipSessionElement=clipSession?.draft.elements.find(e=>e.id===clipSession.targetId)??null;
  const clipSessionLabel=clipSession?.kind==='assembly'?'Edit assembly animation':clipSession?.kind==='structure'?'Edit assembly attachment':'Edit media clip';
  const evaluated=evaluateProject(project,time);
  const selectedWorld=evaluated.find(e=>e.id===selected[0])??null;
  const selectedAssetId=selectedWorld?selectedWorld.assetId:selectedElement?.assetId;
  const selectedAudioAsset=project.assets.find(asset=>asset.id===selectedAssetId&&(asset.kind==='audio'||asset.kind==='video'));
  const selectedVisualAsset=project.assets.find(asset=>asset.id===selectedAssetId&&(asset.kind==='image'||asset.kind==='video'));
  const motionCandidate=selectedElement?.motionBehaviors?.find(behavior=>behavior.id===editingMotionId);
  const motionPathBehavior=motionCandidate?.type==='followPath'?motionCandidate:null;
  const motionAnchor=useMemo(()=>motionPathBehavior&&selectedElement?motionPathLocalAnchor(project,selectedElement,motionPathBehavior):null,[project,selectedElement?.id,motionPathBehavior?.id]);
  const motionGuide=motionPathBehavior&&selectedElement&&selectedWorld&&motionAnchor?(()=>{
    const parent=parentId(selectedElement),parentPose=parent?evaluated.find(element=>element.id===parent)??null:null;
    const origin=motionPathWorldAnchor(motionAnchor,parentPose);
    return {base:{...selectedWorld,x:origin.x,y:origin.y},parent:parentPose};
  })():null;
  useEffect(()=>{setPathEditMode(false);setActivePathPoint(0);setPinEditMode(false);setEditingMotionId(null);setActiveMotionPoint(0);},[selected[0]]);

  useEffect(()=>{const dismiss=(event:Event)=>{if(!(event.target instanceof Element)||!event.target.closest('.menu-wrap'))setMenu(null);};document.addEventListener('pointerdown',dismiss,true);document.addEventListener('focusin',dismiss);return()=>{document.removeEventListener('pointerdown',dismiss,true);document.removeEventListener('focusin',dismiss);};},[]);
  useEffect(()=>{const ruler=rulerBody.current;if(!ruler)return;const observer=new ResizeObserver(()=>setTimelineWidth(ruler.getBoundingClientRect().width));observer.observe(ruler);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    const viewport=timelineBody.current,ruler=rulerBody.current;
    if(!viewport||!ruler)return;
    const measure=()=>{
      const view=viewport.getBoundingClientRect(),lane=ruler.getBoundingClientRect();
      const label=ruler.previousElementSibling?.getBoundingClientRect().width??220;
      const start=clamp((view.left+label-lane.left)/Math.max(1,lane.width)*project.duration,0,project.duration);
      const end=clamp((view.right-lane.left)/Math.max(1,lane.width)*project.duration,0,project.duration);
      setVisibleTimelineRange(current=>Math.abs(current[0]-start)<.0001&&Math.abs(current[1]-end)<.0001?current:[start,end]);
    };
    measure();
    const observer=new ResizeObserver(measure);
    observer.observe(viewport);observer.observe(ruler);
    viewport.addEventListener('scroll',measure,{passive:true});
    return()=>{observer.disconnect();viewport.removeEventListener('scroll',measure);};
  },[project.duration,timelineScale,timelineCollapsed,timelineHeight]);
  useEffect(()=>{const dismiss=(event:PointerEvent)=>{if(!(event.target instanceof Element)||!event.target.closest('.timeline-context-menu'))setTimelineContext(null);};document.addEventListener('pointerdown',dismiss,true);return()=>document.removeEventListener('pointerdown',dismiss,true);},[]);
  function alert(message:string){setNotice(message);}
  function commit(next:Project,before=projectRef.current){if(clipSessionRef.current){alert('Apply or discard the clip edit before changing the project.');return;}next.updatedAt=new Date().toISOString();setHistory(h=>[...h.slice(-79),before]);setFuture([]);projectRef.current=next;setProject(next);dirty.current=true;setFileStatus('Changes not saved to file');}
  function edit(fn:(p:Project)=>void){const next=clone(projectRef.current);fn(next);commit(next);}
  function undo(){if(clipSessionRef.current||!history.length)return;stop();const current=projectRef.current,next=history[history.length-1];setFuture(f=>[current,...f]);setHistory(h=>h.slice(0,-1));projectRef.current=next;setProject(next);dirty.current=true;setFileStatus('Changes not saved to file');}
  function redo(){if(clipSessionRef.current||!future.length)return;stop();const current=projectRef.current,next=future[0];setHistory(h=>[...h,current]);setFuture(f=>f.slice(1));projectRef.current=next;setProject(next);dirty.current=true;setFileStatus('Changes not saved to file');}
  function setActiveClipSession(next:ClipEditSession|null){clipSessionRef.current=next;setClipSession(next);}
  function setPendingStaleDraft(next:SavedClipDraft|null){staleClipDraftRef.current=next;setStaleClipDraft(next);}
  function beginClipSession(kind:ClipEditKind,targetId:string){
    if(clipSessionRef.current)return;
    if(draftLookup.current){alert('Checking browser recovery for an unfinished clip edit. Try again in a moment.');return;}
    if(staleClipDraftRef.current){setShowStaleDraft(true);return;}
    stop();const base=projectRef.current;
    clipSessionOpener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    setActiveClipSession({kind,targetId,base,draft:clone(base),dirty:false});
  }
  function updateClipSession(nextProject:Project,targetId?:string){
    const current=clipSessionRef.current;if(!current)return;
    const next={...current,draft:nextProject,targetId:targetId??current.targetId,dirty:true};
    setActiveClipSession(next);
    void saveClipDraft(next.base,next.draft,next.kind,next.targetId).catch(error=>alert(error instanceof ClipDraftConflictError?error.message:'Could not preserve the unfinished clip edit in browser recovery. Keep this editor open or apply the changes.'));
  }
  function patchClipSessionElement(patch:Partial<StoryElement>){
    const current=clipSessionRef.current;if(!current)return;
    const next=clone(current.draft),element=next.elements.find(item=>item.id===current.targetId);
    if(!element)return;
    Object.assign(element,patch);updateClipSession(next);
  }
  function reparentClipSessionElement(parent:string|undefined){
    const current=clipSessionRef.current;if(!current)return;
    try{const next=reparentElement(current.draft,current.targetId,parent,time);if(parent)next.elements.find(item=>item.id===current.targetId)!.attachment={parentId:parent,type:'hinge'};updateClipSession(next);}
    catch(error){alert(error instanceof Error?error.message:String(error));}
  }
  function changeClipSessionTarget(targetId:string){
    const current=clipSessionRef.current;if(!current)return;
    const next={...current,targetId};setActiveClipSession(next);
    if(next.dirty)void saveClipDraft(next.base,next.draft,next.kind,targetId).catch(()=>alert('Could not update the unfinished clip draft in browser recovery.'));
  }
  function applyClipSession(){
    const current=clipSessionRef.current;if(!current)return;
    if(projectRef.current!==current.base||projectRef.current.id!==current.base.id||projectRef.current.updatedAt!==current.base.updatedAt){alert('The project changed while this clip edit was open. The draft was not applied.');return;}
    setActiveClipSession(null);
    if(current.dirty){stop();commit(current.draft,current.base);}
    if(current.kind==='media')setSelected([current.targetId]);
    setClipLeavePrompt(false);
    void deleteClipDraft(current.base.id).catch(()=>alert('The applied clip draft could not be removed from browser recovery.'));
    requestAnimationFrame(()=>clipSessionOpener.current?.isConnected&&clipSessionOpener.current.focus());
  }
  function discardClipSession(){
    const current=clipSessionRef.current;if(!current)return;
    setActiveClipSession(null);setClipLeavePrompt(false);
    void deleteClipDraft(current.base.id).catch(()=>alert('The discarded clip draft could not be removed from browser recovery.'));
    requestAnimationFrame(()=>clipSessionOpener.current?.isConnected&&clipSessionOpener.current.focus());
  }
  function leaveClipSession(){if(clipSessionRef.current?.dirty)setClipLeavePrompt(true);else discardClipSession();}
  function replaceProject(p:Project){if(clipSessionRef.current){alert('Apply or discard the open clip edit before opening another project.');return false;}if(dirty.current)void saveAutosave(projectRef.current).catch(()=>alert("Could not preserve the previous project in browser recovery. Save a project file before closing."));stop();setActiveClipSession(null);setClipLeavePrompt(false);const opened=assignSceneOwnership(p);draftLookup.current=opened;setPendingStaleDraft(null);setShowStaleDraft(false);setStaleDraftIssue('');projectRef.current=opened;projectHandle.current=null;setProject(opened);setSelected([]);setSelectedCaptionId(null);setTimelineItems([]);setHistory([]);setFuture([]);setTime(0);setSplash(false);dirty.current=false;setFileStatus('Opened project');setHiddenSections([]);setKeySelection(null);setSceneDialog(null);
    void loadClipDraft(opened.id).then(saved=>{
      if(!saved||projectRef.current!==opened)return;
      try{setActiveClipSession({kind:saved.kind,targetId:saved.targetId,base:opened,draft:restoreClipDraft(opened,saved),dirty:true});setSelected([saved.targetId]);alert('Recovered an unfinished clip edit. Apply or discard it when ready.');}
      catch(error){setPendingStaleDraft(saved);setStaleDraftIssue(error instanceof Error?error.message:String(error));setShowStaleDraft(true);}
    }).catch(()=>alert('Could not inspect unfinished clip edits in browser recovery.')).finally(()=>{if(draftLookup.current===opened)draftLookup.current=null;});
    return true;
  }
  async function recoverStaleClipDraft(){
    const saved=staleClipDraftRef.current,source=projectRef.current;
    if(!saved||source.id!==saved.projectId)return;
    setStaleDraftBusy(true);
    try{
      const {base,draft}=recoverClipDraftCopy(source,saved,uid());
      await saveAutosave(base);
      await saveClipDraft(base,draft,saved.kind,saved.targetId);
      await deleteClipDraft(source.id);
      setPendingStaleDraft(null);setShowStaleDraft(false);
      replaceProject(base);
    }catch(error){alert(`Could not recover the clip draft: ${error instanceof Error?error.message:String(error)} The original draft remains in browser recovery.`);}
    finally{setStaleDraftBusy(false);}
  }
  async function discardStaleClipDraft(){
    const saved=staleClipDraftRef.current;if(!saved)return;
    setStaleDraftBusy(true);
    try{await deleteClipDraft(saved.projectId);setPendingStaleDraft(null);setShowStaleDraft(false);setStaleDraftIssue('');}
    catch(error){alert(`Could not discard the clip draft: ${error instanceof Error?error.message:String(error)}`);}
    finally{setStaleDraftBusy(false);}
  }
  useEffect(()=>{if(selected.length)setSelectedCaptionId(null);},[selected]);
  function stop(){previewToken.current++;previewReturn.current=null;setPreviewingAudioId(null);setTailPlaying(false);playRef.current=false;setPlaying(false);setPreparing(false);transport.current.stop();recordingPlayback.current=null;}
  async function playFrom(start:number){const p=projectRef.current,token=previewToken.current;setTime(start);setTailPlaying(false);setPreparing(true);playRef.current=true;try{await transport.current.play(p,start);if(playRef.current&&token===previewToken.current)setPlaying(true);}catch(e){if(token===previewToken.current){alert(String(e));stop();}}finally{if(token===previewToken.current)setPreparing(false);}}
  async function togglePlay(){if(playRef.current){stop();return;}await playFrom(time>=projectRef.current.duration?0:time);}
  async function previewAudio(){
    const element=selectedElement;
    if(!element||!selectedAudioAsset)return;
    const window=elementWindow(projectRef.current,element);
    if(!window){alert('This audio object has no visible clip to preview.');return;}
    const previous=previewReturn.current??{time:playRef.current?transport.current.time:time,playing:playRef.current&&!transport.current.previewingId};
    const token=++previewToken.current;
    previewReturn.current=previous;
    transport.current.stop();
    const start=time>=window.start&&time<window.end?time:window.start;
    setTime(start);setPreviewingAudioId(element.id);setPlaying(false);setPreparing(true);playRef.current=true;
    try{
      await transport.current.preview(projectRef.current,element.id,start,()=>{
        if(token!==previewToken.current)return;
        previewToken.current++;previewReturn.current=null;setPreviewingAudioId(null);setPlaying(false);setPreparing(false);playRef.current=false;
        setTime(previous.time);
        if(previous.playing)void playFrom(previous.time);
      });
      if(token===previewToken.current){setPreparing(false);setPlaying(true);}
    }catch(error){if(token===previewToken.current){stop();setTime(previous.time);if(previous.playing)void playFrom(previous.time);alert(error instanceof Error?error.message:String(error));}}
  }
  function stopPreview(){if(previewReturn.current)transport.current.stop();}
  function seek(t:number,exact=false){stop();setTime(clamp(snap&&!exact?Math.round(t*project.fps)/project.fps:t,0,project.duration));}

  useEffect(()=>{void loadAutosave().then(setRecent).catch(()=>setSaveStatus('Browser recovery unavailable'));return()=>{transport.current.destroy();recorder.current?.stop();recStream.current?.getTracks().forEach(t=>t.stop());void recordingMonitor.current?.close();};},[]);
  useEffect(()=>{if(splash)return;const generation=++lastSave.current;setSaveStatus('Saving in browser…');const timer=setTimeout(()=>{void saveAutosave(project).then(()=>{if(generation===lastSave.current)setSaveStatus('Autosaved in this browser');}).catch(()=>setSaveStatus('Autosave failed — save a project file'));},700);return()=>clearTimeout(timer);},[project,splash]);
  useEffect(()=>{if(!playing)return;let raf=0;function tick(){if(!playRef.current)return;const p=projectRef.current;const raw=transport.current.time,t=clamp(raw,0,p.duration);setTime(t);transport.current.update(recordingPlayback.current??p,raw);setTailPlaying(!transport.current.previewingId&&raw>=p.duration&&raw<p.duration+audioTail);if(raw>=p.duration+audioTail&&!transport.current.previewingId){finishRecording.current?.();stop();return;}raf=requestAnimationFrame(tick);}raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf);},[playing,audioTail]);
  useEffect(()=>{if(!notice)return;const t=setTimeout(()=>setNotice(''),6000);return()=>clearTimeout(t);},[notice]);
  useEffect(()=>{if(splash)void listAutosaves().then(p=>{setRecentProjects(p);setRecent(p[0]??null);}).catch(()=>setSaveStatus('Browser recovery unavailable'));},[splash]);
  useEffect(()=>{const node=stageWorkspace.current;if(!node)return;const fit=()=>{const width=Math.max(1,node.clientWidth-76),height=Math.max(1,node.clientHeight-74),ratio=project.width/project.height;const fittedWidth=Math.min(width,height*ratio);setStageSize({width:fittedWidth,height:fittedWidth/ratio});};fit();const observer=new ResizeObserver(fit);observer.observe(node);return()=>observer.disconnect();},[project.width,project.height]);
  useEffect(()=>{const handler=(event:BeforeUnloadEvent)=>{if(dirty.current||clipSessionRef.current?.dirty){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);},[]);
  useLayoutEffect(()=>{
    if(!clipSession||!appRoot.current)return;
    const root=appRoot.current;
    const previous=Array.from(root.children).map(child=>[child,(child as HTMLElement).inert] as const);
    for(const [child] of previous){
      const allowed=child.classList.contains(clipLeavePrompt?'clip-leave-backdrop':'clip-edit-backdrop');
      (child as HTMLElement).inert=!allowed;
    }
    const focus=root.querySelector<HTMLElement>(clipLeavePrompt?'.clip-leave-backdrop button':'.clip-edit-backdrop .dialog-title button');
    focus?.focus();
    return()=>{for(const [child,inert] of previous)(child as HTMLElement).inert=inert;};
  },[!!clipSession,clipLeavePrompt]);
  useLayoutEffect(()=>{
    if(!showStaleDraft||!appRoot.current)return;
    const previous=Array.from(appRoot.current.children).map(child=>[child,(child as HTMLElement).inert] as const);
    for(const [child] of previous)(child as HTMLElement).inert=!child.classList.contains('stale-draft-backdrop');
    appRoot.current.querySelector<HTMLElement>('.stale-draft-backdrop button')?.focus();
    return()=>{for(const [child,inert] of previous)(child as HTMLElement).inert=inert;};
  },[showStaleDraft]);

  function projectFileName(){return safeName(projectRef.current.name)+projectFileExtension;}
  function overwriteChoiceSaved(){try{return localStorage.getItem(`hyde:replace:${projectRef.current.id}`)==='yes';}catch{return false;}}
  async function writeCurrentProject(handle:HydeFileHandle){try{setBusy('Saving project…');const snapshot=projectRef.current;const blob=await saveProjectBlob(snapshot);await writeProjectFile(handle,blob);if(projectRef.current===snapshot){dirty.current=false;setFileStatus(`Saved to ${handle.name}`);alert(`Saved ${handle.name}`);}else{dirty.current=true;setFileStatus('Changes not saved to file');alert(`Saved ${handle.name}; newer edits still need saving.`);}}catch(error){alert(String(error));}finally{setBusy('');}}
  async function downloadProjectCopy(){try{downloadBlob(await saveProjectBlob(projectRef.current),projectFileName());setFileStatus('Project copy downloaded');}catch(error){alert(String(error));}}
  async function save(asNew=false){try{
    if(!canWriteProjectFile()){const blob=await saveProjectBlob(projectRef.current);downloadBlob(blob,projectFileName());dirty.current=false;setFileStatus('Project file downloaded');alert('Your browser downloaded a new copy. Open Hyde in Chrome or Edge to save changes directly to a selected file.');return;}
    let handle=!asNew&&projectHandle.current?.name===projectFileName()?projectHandle.current:null;
    if(handle){if(!overwriteChoiceSaved()){setSkipOverwriteNotice(false);setDialog('overwrite');return;}await writeCurrentProject(handle);return;}
    handle=await chooseProjectSaveFile(projectFileName());if(!handle)return;
    if(handle.name!==projectFileName()){alert(`Choose ${projectFileName()} to keep the project name and file name in sync.`);return;}
    projectHandle.current=handle;await writeCurrentProject(handle);
  }catch(error){if((error as DOMException)?.name!=='AbortError')alert(String(error));}}
  async function openFile(file:File,handle?:HydeFileHandle){try{setBusy('Opening project…');const p=await loadProjectFile(file);if(!replaceProject(p))return;projectHandle.current=handle??null;setProjectFileExtension(file.name.toLowerCase().endsWith('.hy')?'.hy':'.hyde');alert(`Opened ${file.name}`);}catch(e){alert(String(e));}finally{setBusy('');}}
  async function chooseOpenProject(){try{const handle=await chooseProjectToOpen();if(handle)await openFile(await handle.getFile(),handle);else fileInput.current?.click();}catch(error){if((error as DOMException)?.name!=='AbortError')alert(String(error));}}
  async function exportAssembly(){if(!selected.length)return;try{const assembly=makeAssembly(project,selected,time);downloadBlob(await saveAssemblyBlob(assembly),safeName(assembly.name)+'.hyproj');alert('Assembly exported with its keyframes and assets.');}catch(e){alert(String(e));}}
  async function insertAssembly(file:File){try{const a=await loadAssemblyFile(file);const current=projectRef.current;const p=insertAssemblyAt(current,a,time);const old=new Set(current.elements.map(e=>e.id));const inserted=p.elements.filter(e=>!old.has(e.id));const sceneId=sceneIdAt(p,time);for(const element of inserted)element.sceneId=sceneId;commit(p);setSelected(inserted.length?[inserted[0].id]:[]);alert(`Imported ${a.name}`);}catch(e){alert(String(e));}}
  async function openLibraryDirectory(){
    const picker=(window as Window&{showDirectoryPicker?:(options?:{mode:'read'})=>Promise<LibraryDirectoryHandle>}).showDirectoryPicker;
    if(!picker){libraryInput.current?.click();return;}
    try{
      const handle=await picker.call(window,{mode:'read'});
      setBusy(`Reading ${handle.name}…`);
      const files=await scanLibraryDirectory(handle);
      libraryHandle.current=handle;setLibraryFiles(files);setLibraryName(handle.name);setLibrarySource('handle');setLeftTab('library');
    }catch(error){
      if((error as DOMException).name!=='AbortError'){
        alert(`The folder could not be opened through the browser: ${String(error)}. Choose a folder snapshot instead.`);
        libraryInput.current?.click();
      }
    }finally{setBusy('');}
  }
  async function refreshLibraryDirectory(){
    const handle=libraryHandle.current;
    if(!handle){libraryInput.current?.click();return;}
    try{setBusy(`Refreshing ${handle.name}…`);setLibraryFiles(await scanLibraryDirectory(handle));}
    catch(error){alert(`The library could not be refreshed: ${String(error)}. Select the folder again.`);}
    finally{setBusy('');}
  }
  async function importMedia(files:FileList|File[]|null,targetId?:string){if(!files)return;stop();for(const file of Array.from(files)){try{if(file.name.toLowerCase().endsWith('.hyproj')){await insertAssembly(file);continue;}if(/\.(hyde|hy)$/i.test(file.name)){await openFile(file);continue;}const mime=mediaMime(file);if(!mime){alert(`Unsupported media: ${file.name}`);continue;}setBusy(`Importing ${file.name}…`);const dataUrl=await readData(file.type===mime?file:new File([file],file.name,{type:mime}));const kind=mime.split('/')[0] as 'image'|'video'|'audio';let w=320,h=200,duration=projectRef.current.duration-time;
      if(kind==='image'){const img=new Image();img.src=dataUrl;await img.decode();const ratio=Math.min(1,400/img.width,300/img.height);w=img.width*ratio;h=img.height*ratio;}
      else {const m=document.createElement(kind);m.preload='metadata';m.src=dataUrl;await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Media metadata timed out')),10000);m.onloadedmetadata=()=>{clearTimeout(timer);resolve();};m.onerror=()=>{clearTimeout(timer);reject(new Error('This browser cannot read that recording.'));};});duration=Number.isFinite(m.duration)?m.duration:duration;if(kind==='video'){const v=m as HTMLVideoElement;const ratio=Math.min(1,480/v.videoWidth,300/v.videoHeight);w=v.videoWidth*ratio;h=v.videoHeight*ratio;}}
      const asset:Asset={id:uid(),name:file.name,mime,kind,dataUrl,duration:kind==='image'?undefined:duration};
      const target=targetId&&kind!=='audio'?projectRef.current.elements.find(element=>element.id===targetId):undefined;
      if(target&&['rectangle','ellipse','polygon','image','video'].includes(target.kind)){
        commit(applyMediaFill(projectRef.current,target.id,asset));setSelected([target.id]);setLeftTab('layers');continue;
      }
      const p=clone(projectRef.current);p.assets.push(asset);const e=createElement(kind,{name:file.name.replace(/\.[^.]+$/,''),assetId:asset.id,x:p.width/2,y:p.height/2,width:w,height:h,start:time,duration:Math.max(1/p.fps,duration),sceneId:sceneIdAt(p,time)});p.elements.push(e);p.duration=Math.max(p.duration,e.start+e.duration);commit(p);setSelected([e.id]);setLeftTab('layers');}catch(e){alert(String(e));}finally{setBusy('');}}}

  async function importFont(file:File|undefined){
    if(!file)return;
    const extension=file.name.toLowerCase().split('.').pop()??'';
    const mime=({woff2:'font/woff2',woff:'font/woff',ttf:'font/ttf',otf:'font/otf'} as Record<string,string>)[extension];
    if(!mime){alert('Choose a WOFF2, WOFF, TTF, or OTF font file.');return;}
    if(file.size>20*1024*1024){alert('This font file exceeds the 20 MB project-font limit.');return;}
    try{
      setBusy(`Importing ${file.name}…`);
      const dataUrl=await readData(file.type===mime?file:new File([file],file.name,{type:mime}));
      stop();
      const next=addProjectFont(projectRef.current,{name:file.name,mime,dataUrl},selected[0]).project;
      await captureImportedStaticFont(next,selected[0]);
      commit(next);
    }catch(error){alert(error instanceof Error?error.message:String(error));}finally{setBusy('');}
  }
  async function importCuratedFont(source:CuratedFontAsset){
    try{
      stop();const next=addProjectFont(projectRef.current,source,selected[0]).project;
      await captureImportedStaticFont(next,selected[0]);
      commit(next);
    }catch(error){alert(error instanceof Error?error.message:String(error));}
  }
  async function captureImportedStaticFont(next:Project,textId:string|undefined){
    const element=next.elements.find(item=>item.id===textId&&item.kind==='text'&&item.textLayout==='static');
    if(!element)return;
    const loader=new ProjectFontLoader();
    try{await loader.sync(next.assets);element.staticLayoutWidth=element.width;element.staticTextFlow=captureStaticTextShapeLayout(next,element.id,time);}
    finally{loader.dispose();}
  }
  function add(kind:ElementKind){stop();const p=clone(project);const e=createElement(kind,{x:p.width/2,y:p.height/2,start:time,duration:Math.max(1/p.fps,p.duration-time),sceneId:sceneIdAt(p,time),points:kind==='polygon'?[{x:90,y:0},{x:180,y:140},{x:0,y:140}]:undefined});p.elements.push(e);commit(p);setTimelineItems([]);setSelected([e.id]);setPivotMode(false);}
  function changeElement(patch:Partial<StoryElement>){
    if(!selectedElement)return;
    stop();
    try{edit(p=>{
      const e=p.elements.find(value=>value.id===selectedElement.id)!;
      const refresh=e.kind==='text'&&(patch.textLayout==='static'||e.textLayout==='static'&&
        ['text','fontFamily','fontSize','flowAroundId','textShapeMode'].some(key=>Object.prototype.hasOwnProperty.call(patch,key)));
      if(refresh)patch.staticLayoutWidth=e.width;
      for(const [key,value] of Object.entries(patch)){
        if(recordKeys&&['x','y','rotation','scaleX','scaleY','opacity','fill','volume','assetId'].includes(key))
          setKey(e,key as AnimProperty,key==='assetId'?(value??'') as string:value as number|string);
        else Object.assign(e,{[key]:value});
      }
      if(e.kind==='text'){
        if(e.textLayout!=='static')delete e.staticTextFlow;
        else if(refresh)e.staticTextFlow=captureStaticTextShapeLayout(p,e.id,time);
      }
    });}catch(error){alert(error instanceof Error?error.message:String(error));}
  }
  function changeFillColor(color:string){
    if(!selectedElement)return;
    // Once fill has an animation track, changing only the base value is
    // invisible at the playhead. Edit that pose even when Auto key is off.
    if(recordKeys||selectedElement.tracks.some(track=>track.property==='fill'&&track.keyframes.length)){
      stop();edit(p=>setKey(p.elements.find(element=>element.id===selectedElement.id)!,'fill',color));
    }else changeElement({fill:color});
  }
  function refreshStaticTextShape(){
    if(selectedElement?.kind!=='text'||selectedElement.textLayout!=='static')return;
    stop();
    try{edit(p=>{const e=p.elements.find(item=>item.id===selectedElement.id)!;
      e.staticLayoutWidth=e.width;e.staticTextFlow=captureStaticTextShapeLayout(p,e.id,time);
    });}catch(error){alert(error instanceof Error?error.message:String(error));}
  }
  function changeTextAnimation(patch:Partial<TextAnimation>){if(!selectedElement||selectedElement.kind!=='text')return;changeElement({textAnimation:{...DEFAULT_TEXT_ANIMATION,...selectedElement.textAnimation,...patch}});}
  function convertSelectedPath(){if(!selectedElement)return;try{stop();edit(p=>{const index=p.elements.findIndex(item=>item.id===selectedElement.id);p.elements[index]=withEditablePath(p.elements[index]);});setActivePathPoint(0);setPathEditMode(true);setPinEditMode(false);}catch(error){alert(error instanceof Error?error.message:String(error));}}
  function editSelectedPath(action:'curve'|'straight'|'split'|'remove'){
    if(!selectedElement?.shapePath)return;
    try{
      const original=selectedElement.shapePath,index=Math.min(activePathPoint,original.points.length-1);
      let next=original;
      if(action==='curve'){
        const point=original.points[index],previous=original.points[(index+original.points.length-1)%original.points.length],following=original.points[(index+1)%original.points.length];
        const offset={x:(following.x-previous.x)/6,y:(following.y-previous.y)/6};
        next=setPathHandle(next,index,'in',{x:point.x-offset.x,y:point.y-offset.y});
        next=setPathHandle(next,index,'out',{x:point.x+offset.x,y:point.y+offset.y});
      }else if(action==='straight')next=setPathHandle(setPathHandle(next,index,'in'),index,'out');
      else if(action==='split'){next=splitPathSegment(next,index);setActivePathPoint(index+1);}
      else{next=removePathPoint(next,index);setActivePathPoint(Math.max(0,index-1));}
      stop();edit(p=>{p.elements.find(item=>item.id===selectedElement.id)!.shapePath=next;});
    }catch(error){alert(error instanceof Error?error.message:String(error));}
  }
  function startPathDrag(event:React.PointerEvent,index:number,handle:'anchor'|'in'|'out'){
    if(event.button!==0||!selectedElement?.shapePath||!selectedWorld)return;
    event.preventDefault();event.stopPropagation();stop();setActivePathPoint(index);
    event.currentTarget.setPointerCapture(event.pointerId);
    pathDrag.current={base:projectRef.current,id:selectedElement.id,index,handle,pose:selectedWorld,moved:false};
  }
  function movePathDrag(event:React.PointerEvent){
    const drag=pathDrag.current;if(!drag)return;
    const world=stagePoint(event,drag.pose.sceneId),local=worldToPathPoint(drag.pose,world);
    if(!Number.isFinite(local.x)||!Number.isFinite(local.y))return;
    const next=clone(drag.base),element=next.elements.find(item=>item.id===drag.id)!;
    if(!element.shapePath)return;
    element.shapePath=drag.handle==='anchor'?movePathAnchor(element.shapePath,drag.index,local.x,local.y):setPathHandle(element.shapePath,drag.index,drag.handle,local);
    drag.moved=true;projectRef.current=next;setProject(next);
  }
  function endPathDrag(){const drag=pathDrag.current;if(!drag)return;pathDrag.current=null;if(drag.moved&&projectRef.current!==drag.base)commit(clone(projectRef.current),drag.base);}
  function enableSelectedPin(){if(!selectedElement||!selectedVisualAsset)return;changeElement({mediaPin:clone(DEFAULT_PIN_CORNERS) as PinCorners});setPathEditMode(false);setPinEditMode(true);}
  function startPinDrag(event:React.PointerEvent,index:number){
    if(event.button!==0||!selectedElement?.mediaPin||!selectedWorld)return;
    event.preventDefault();event.stopPropagation();stop();
    event.currentTarget.setPointerCapture(event.pointerId);
    pinDrag.current={base:projectRef.current,id:selectedElement.id,index,pose:selectedWorld,moved:false};
  }
  function movePinDrag(event:React.PointerEvent){
    const drag=pinDrag.current;if(!drag)return;
    const world=stagePoint(event,drag.pose.sceneId),local=worldToPathPoint(drag.pose,world);
    if(!Number.isFinite(local.x)||!Number.isFinite(local.y))return;
    const next=clone(drag.base),element=next.elements.find(item=>item.id===drag.id)!;
    if(!element.mediaPin)return;
    const corners=element.mediaPin.map((corner,index)=>index===drag.index?local:corner);
    if(!validPinCorners(corners))return;
    element.mediaPin=corners;drag.moved=true;projectRef.current=next;setProject(next);
  }
  function endPinDrag(){const drag=pinDrag.current;if(!drag)return;pinDrag.current=null;if(drag.moved&&projectRef.current!==drag.base)commit(clone(projectRef.current),drag.base);}
  function startMotionPathDrag(event:React.PointerEvent,index:number,handle:'anchor'|'in'|'out'){
    if(event.button!==0||!selectedElement||!motionPathBehavior||!motionGuide)return;
    event.preventDefault();event.stopPropagation();stop();setActiveMotionPoint(index);
    event.currentTarget.setPointerCapture(event.pointerId);
    motionPathDrag.current={base:projectRef.current,id:selectedElement.id,behaviorId:motionPathBehavior.id,index,handle,pose:motionGuide.base,parent:motionGuide.parent,moved:false};
  }
  function moveMotionPathDrag(event:React.PointerEvent){
    const drag=motionPathDrag.current;if(!drag)return;
    const offset=worldToMotionPoint(drag.pose,drag.parent,stagePoint(event,drag.pose.sceneId));
    if(!Number.isFinite(offset.x)||!Number.isFinite(offset.y))return;
    const limit=MOTION_LIMITS.pathCoordinate,point={x:clamp(offset.x,-limit,limit),y:clamp(offset.y,-limit,limit)};
    const next=clone(drag.base),element=next.elements.find(item=>item.id===drag.id);
    const behavior=element?.motionBehaviors?.find(item=>item.id===drag.behaviorId);
    if(!behavior||behavior.type!=='followPath')return;
    const current=behavior.points[drag.index];if(!current)return;
    if(drag.handle==='anchor'){
      const dx=point.x-current.x,dy=point.y-current.y;
      behavior.points[drag.index]={...current,...point,
        ...(current.in?{in:{x:clamp(current.in.x+dx,-limit,limit),y:clamp(current.in.y+dy,-limit,limit)}}:{}),
        ...(current.out?{out:{x:clamp(current.out.x+dx,-limit,limit),y:clamp(current.out.y+dy,-limit,limit)}}:{})};
    }else behavior.points[drag.index]={...current,[drag.handle]:point};
    drag.moved=true;projectRef.current=next;setProject(next);
  }
  function endMotionPathDrag(){const drag=motionPathDrag.current;if(!drag)return;motionPathDrag.current=null;if(drag.moved&&projectRef.current!==drag.base)commit(clone(projectRef.current),drag.base);}
  function resetPivot(){if(!selectedElement)return;if(parentId(selectedElement)){alert('Detach this part to edit its pivot.');return;}stop();const pose=evaluateElement(selectedElement,time)??selectedElement;edit(p=>{const e=p.elements.find(v=>v.id===selectedElement.id)!;setPivotWithoutMovingArt(e,.5,.5,pose);});}
  function rotateAtWorldPoint(degrees:number){if(!selectedElement||!Number.isFinite(degrees))return;try{stop();commit(rotateSelectionAroundWorldPoint(projectRef.current,selected,time,worldPoint,degrees,recordKeys));}catch(error){alert(error instanceof Error?error.message:String(error));}}
  function changeRotation(degrees:number){if(!selectedElement)return;if(rotationOrigin==='world'){rotateAtWorldPoint(degrees-(displayElement?.rotation??selectedElement.rotation));return;}changeElement({rotation:degrees});}
  function setKey(e:StoryElement,property:AnimProperty,value:number|string){let track=e.tracks.find(t=>t.property===property);if(!track){track={property,keyframes:[]};e.tracks.push(track);}const kt=clamp(Math.round((time-e.start)*project.fps)/project.fps,0,e.duration);const existing=track.keyframes.find(k=>Math.abs(k.time-kt)<.000001);if(existing)existing.value=value;else track.keyframes.push({id:uid(),time:kt,value,easing:'linear',direction:'inOut',mode:'smooth'});track.keyframes.sort((a,b)=>a.time-b.time);}
  function keyProperty(property:AnimProperty){if(!selectedElement)return;const e=evaluateElement(selectedElement,time)||selectedElement;edit(p=>setKey(p.elements.find(v=>v.id===e.id)!,property,property==='assetId'?(e.assetId??''):(e[property]??1)));setExpanded(v=>v.includes(e.id)?v:[...v,e.id]);alert(`Keyframe added for ${property}`);}
  function removeSelected(){if(keySelection){deleteSelectedKeyframe();setContext(null);return;}if(!selected.length)return;stop();edit(p=>{const ids=descendantIds(p,selected);p.elements=p.elements.filter(e=>!ids.has(e.id));for(const element of p.elements)if(element.flowAroundId&&ids.has(element.flowAroundId))delete element.flowAroundId;});setTimelineItems([]);setSelected([]);setContext(null);}
  function duplicate(){if(!selected.length)return;const result=duplicateElements(project,selected);commit(result.project);setTimelineItems([]);setSelected(result.ids.slice(0,1));setContext(null);}
  function copySelection(){if(!selected.length)return;try{objectClipboard.current=copyObjects(projectRef.current,selected,time);pasteCount.current=0;alert(`Copied ${selected.length} selected object${selected.length===1?'':'s'}.`);}catch(error){alert(error instanceof Error?error.message:String(error));}}
  function pasteSelection(){const copied=objectClipboard.current;if(!copied)return;try{stop();const result=pasteObjects(projectRef.current,copied,time,pasteCount.current+1);commit(result.project);pasteCount.current++;setTimelineItems([]);setKeySelection(null);setSelected(result.ids);setContext(null);alert(`Pasted ${result.ids.length} selected object${result.ids.length===1?'':'s'}.`);}catch(error){alert(error instanceof Error?error.message:String(error));}}
  function align(mode:Alignment){try{stop();commit(alignSelection(projectRef.current,selected,time,mode));}catch(error){alert(error instanceof Error?error.message:String(error));}}
  function groupSelection(){if(!selected.length)return;const p=assignSceneOwnership(project);const children=p.elements.filter(e=>selected.includes(e.id));if(children.some(e=>parentId(e))){alert('Select top-level parts to assemble. Detach an existing part first.');return;}if(new Set(children.map(e=>e.sceneId)).size>1){alert('Assemble parts from one scene at a time.');return;}const start=Math.min(...children.map(e=>e.start)),end=Math.max(...children.map(e=>e.start+e.duration));const g=createElement('group',{name:'New assembly',x:0,y:0,width:0,height:0,pivotX:0,pivotY:0,start,duration:Math.max(1/p.fps,end-start),sceneId:children[0].sceneId});const sameFolder=children.every(e=>e.folderId===children[0].folderId);if(sameFolder)g.folderId=children[0].folderId;for(const e of children){e.parentId=g.id;delete e.folderId;}p.elements.push(g);commit(p);setSelected([g.id]);alert('Assembly created. Select a part to choose its attachment.');}
  function saveAssemblyClip(rootId:string){try{const duration=Number(clipCaptureLength);if(!Number.isFinite(duration))throw new Error('Enter a clip length in seconds.');const result=captureAssemblyClip(projectRef.current,rootId,time,duration,clipCaptureName);stop();commit(result.project);alert('Assembly clip saved. Place it from the list below.');}catch(error){alert(error instanceof Error?error.message:String(error));}}
  function insertAssemblyClip(rootId:string,clipId:string){try{const result=placeAssemblyClip(projectRef.current,rootId,clipId,time);stop();commit(result.project);}catch(error){alert(error instanceof Error?error.message:String(error));}}
  function deleteAssemblyClipInstance(rootId:string,instanceId:string){try{stop();commit(removeAssemblyClipInstance(projectRef.current,rootId,instanceId));}catch(error){alert(error instanceof Error?error.message:String(error));}}
  function updateAssemblyClipInstance(rootId:string,instanceId:string,patch:{at?:number;duration?:number;loop?:boolean}){try{stop();commit(editAssemblyClipInstance(projectRef.current,rootId,instanceId,patch));}catch(error){alert(error instanceof Error?error.message:String(error));}}
  function updateAssemblyGap(rootId:string,toInstanceId:string,elementId:string,property:AnimProperty,patch:Partial<Pick<AssemblyGapTransition,'mode'|'easing'|'direction'|'switchPoint'>>|null){
    try{const current=clipSessionRef.current;if(current)updateClipSession(editAssemblyClipGapTransition(current.draft,rootId,toInstanceId,elementId,property,patch));}catch(error){alert(error instanceof Error?error.message:String(error));}
  }
  function updateAssemblyPriority(rootId:string,instanceId:string,elementId:string,property:AnimProperty,priority:number){
    try{const current=clipSessionRef.current;if(current)updateClipSession(editAssemblyClipPriority(current.draft,rootId,instanceId,elementId,property,priority));}catch(error){alert(error instanceof Error?error.message:String(error));}
  }
  function updateAssemblyTexture(rootId:string,instanceId:string,elementId:string,patch:Partial<Omit<AssemblyTextureOverlap,'elementId'>>|null){
    try{const current=clipSessionRef.current;if(current)updateClipSession(editAssemblyTextureOverlap(current.draft,rootId,instanceId,elementId,patch));}catch(error){alert(error instanceof Error?error.message:String(error));}
  }
  function updateAssemblyKey(target:AssemblyTrackTarget,index:number,patch:AssemblyKeyPatch):boolean{
    try{const current=clipSessionRef.current;if(!current)return false;updateClipSession(editAssemblyClipKey(current.draft,target,index,patch));return true;}catch(error){alert(error instanceof Error?error.message:String(error));return false;}
  }
  function insertAssemblyKey(target:AssemblyTrackTarget,at:number){
    try{const current=clipSessionRef.current;if(current)updateClipSession(addAssemblyClipKey(current.draft,target,at));}catch(error){alert(error instanceof Error?error.message:String(error));}
  }
  function deleteAssemblyKey(target:AssemblyTrackTarget,index:number){
    try{const current=clipSessionRef.current;if(current)updateClipSession(removeAssemblyClipKey(current.draft,target,index));}catch(error){alert(error instanceof Error?error.message:String(error));}
  }
  function resetAssemblyKeyOverride(target:AssemblyTrackTarget){
    try{const current=clipSessionRef.current;if(current){const next=resetAssemblyClipTrackOverride(current.draft,target);if(next!==current.draft)updateClipSession(next);}}catch(error){alert(error instanceof Error?error.message:String(error));}
  }
  function startAssemblyClipDrag(event:React.PointerEvent,root:StoryElement,instance:NonNullable<StoryElement['clipInstances']>[number],mode:'move'|'trim'){
    if(event.button!==0)return;
    event.stopPropagation();stop();setSelected([root.id]);setFocusedAssemblyInstance(instance.id);event.currentTarget.setPointerCapture(event.pointerId);
    const base=projectRef.current;
    assemblyClipDrag.current={base,rootId:root.id,instanceId:instance.id,mode,at:root.start+instance.start,duration:instance.duration,x:event.clientX,pixels:event.currentTarget.closest('.timeline-lane')!.getBoundingClientRect().width,moved:false,targets:timelineSnapTargets(base,{playhead:time,excludeInstanceIds:[instance.id]})};
  }
  function moveAssemblyClipDrag(event:React.PointerEvent){const drag=assemblyClipDrag.current;if(!drag||Math.abs(event.clientX-drag.x)<2&&!drag.moved)return;drag.moved=true;const raw=(event.clientX-drag.x)/drag.pixels*drag.base.duration;const anchors=drag.mode==='move'?[drag.at,drag.at+drag.duration]:[drag.at+drag.duration];const delta=snapTimelineDelta(raw,anchors,{duration:drag.base.duration,laneWidth:drag.pixels,fps:drag.base.fps,targets:drag.targets,enabled:snap&&!event.altKey});try{const next=editAssemblyClipInstance(drag.base,drag.rootId,drag.instanceId,drag.mode==='move'?{at:drag.at+delta,alignToFrame:false}:{duration:drag.duration+delta,alignToFrame:false});projectRef.current=next;setProject(next);}catch{/* Keep the last valid drag position. */}}
  function endAssemblyClipDrag(){const drag=assemblyClipDrag.current;if(!drag)return;assemblyClipDrag.current=null;if(drag.moved&&projectRef.current!==drag.base){assemblyClipClickSuppressed.current=true;commit(clone(projectRef.current),drag.base);}}
  function startAssemblyMasterKeyDrag(event:React.PointerEvent<HTMLButtonElement>,rootId:string,key:AssemblyMasterKey){
    if(event.button!==0)return;
    const root=projectRef.current.elements.find(item=>item.id===rootId),instance=root?.clipInstances?.find(item=>item.id===key.instanceId),clip=root?.assemblyClips?.find(item=>item.id===instance?.clipId);
    if(!root||!instance||!clip)return;
    const target:AssemblyTrackTarget={rootId,clipId:clip.id,elementId:key.elementId,property:key.property,...(key.scope==='instance'?{instanceId:instance.id}:{})};
    const sourceKey=assemblyTrackView(projectRef.current,target).track.keyframes[key.keyIndex];
    if(!sourceKey)return;
    event.preventDefault();event.stopPropagation();stop();event.currentTarget.setPointerCapture(event.pointerId);
    setSelected([rootId]);setFocusedAssemblyInstance(instance.id);setFocusedAssemblyTrack({rootId,elementId:key.elementId,property:key.property,scope:key.scope,keyIndex:key.keyIndex});
    const pixels=event.currentTarget.closest('.timeline-lane')?.getBoundingClientRect().width??1;
    const base=projectRef.current;
    assemblyMasterDrag.current={base,target,keyIndex:key.keyIndex,time:sourceKey.time,anchor:key.time,x:event.clientX,pixels,sourceRate:instance.loop?1:clip.duration/instance.duration,moved:false,targets:timelineSnapTargets(base,{playhead:time})};
  }
  function moveAssemblyMasterKeyDrag(event:React.PointerEvent<HTMLButtonElement>){
    const drag=assemblyMasterDrag.current;if(!drag||Math.abs(event.clientX-drag.x)<3&&!drag.moved)return;
    const raw=(event.clientX-drag.x)/drag.pixels*drag.base.duration;
    const delta=snapTimelineDelta(raw,[drag.anchor],{duration:drag.base.duration,laneWidth:drag.pixels,fps:drag.base.fps,targets:drag.targets,enabled:snap&&!event.altKey})*drag.sourceRate;
    try{const next=editAssemblyClipKey(drag.base,drag.target,drag.keyIndex,{time:drag.time+delta},{alignToFrame:false});drag.moved=true;projectRef.current=next;setProject(next);}catch{/* Keep the last valid drag position. */}
  }
  function endAssemblyMasterKeyDrag(){const drag=assemblyMasterDrag.current;if(!drag)return;assemblyMasterDrag.current=null;if(drag.moved&&projectRef.current!==drag.base){assemblyMasterClickSuppressed.current=true;commit(clone(projectRef.current),drag.base);}}
  function moveLayer(delta:number){if(!selectedElement)return;edit(p=>{const i=p.elements.findIndex(e=>e.id===selectedElement.id),to=clamp(i+delta,0,p.elements.length-1);[p.elements[i],p.elements[to]]=[p.elements[to],p.elements[i]];});}

  function stageCanvasPoint(e:{clientX:number;clientY:number}){const r=stageBox.current!.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width*project.width,y:(e.clientY-r.top)/r.height*project.height};}
  function stagePoint(e:{clientX:number;clientY:number},sceneId?:string){let point=stageCanvasPoint(e);const scene=project.sequences.find(item=>item.id===sceneId);if(scene)point=unmapSceneFramePoint(project,scene,point);return stageToCamera(point,scene?evaluateCameraForScene(project,scene,time):evaluateCamera(project,time),project);}
  function hitStageElement(ev:{clientX:number;clientY:number}){const editable=new Set(project.elements.map(element=>element.id)),activeId=sceneIdAt(project,time);return [...evaluated].reverse().find(e=>{if(!editable.has(e.id)||(e.sceneId&&e.sceneId!==activeId)||e.kind==='group'||e.kind==='audio'||e.locked)return false;const pt=stagePoint(ev,e.sceneId);const angle=-e.rotation*Math.PI/180,dx=pt.x-e.x,dy=pt.y-e.y;const x=(dx*Math.cos(angle)-dy*Math.sin(angle))/e.scaleX+e.width*e.pivotX;const y=(dx*Math.sin(angle)+dy*Math.cos(angle))/e.scaleY+e.height*e.pivotY;if(e.shapePath)return pointInShapePath(e.shapePath,e.width,e.height,x,y);if(e.mediaPin&&(e.kind==='image'||e.kind==='video'))return pointInPinCorners(e.mediaPin,{x:x/e.width,y:y/e.height});return x>=0&&x<=e.width&&y>=0&&y<=e.height;});}
  function startPan(ev:React.PointerEvent,allowPrimary=false){if(ev.button!==1&&!(ev.button===0&&(ev.altKey||allowPrimary)))return false;ev.preventDefault();ev.stopPropagation();panDrag.current={x:ev.clientX,y:ev.clientY,originX:pan.x,originY:pan.y};(ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);return true;}
  function movePan(ev:React.PointerEvent){const d=panDrag.current;if(!d)return false;setPan({x:d.originX+ev.clientX-d.x,y:d.originY+ev.clientY-d.y});return true;}
  function endPan(){panDrag.current=null;}
  function homeStage(){setZoom(1);setPan({x:0,y:0});}
  function beginPanelResize(ev:React.PointerEvent){ev.preventDefault();panelDrag.current={x:ev.clientX,width:leftWidth};(ev.currentTarget as Element).setPointerCapture(ev.pointerId);}
  function movePanelResize(ev:React.PointerEvent){const drag=panelDrag.current;if(!drag)return;setLeftWidth(clamp(drag.width+ev.clientX-drag.x,180,Math.max(180,Math.min(580,(workspaceBox.current?.clientWidth??1200)-620))));}
  function endPanelResize(){panelDrag.current=null;}
  function beginRightResize(ev:React.PointerEvent){ev.preventDefault();rightPanelDrag.current={x:ev.clientX,width:rightWidth};(ev.currentTarget as Element).setPointerCapture(ev.pointerId);}
  function moveRightResize(ev:React.PointerEvent){const drag=rightPanelDrag.current;if(!drag)return;setRightWidth(clamp(drag.width-(ev.clientX-drag.x),210,Math.max(210,Math.min(520,(workspaceBox.current?.clientWidth??1200)-leftWidth-400))));}
  function endRightResize(){rightPanelDrag.current=null;}
  function beginTimelineResize(ev:React.PointerEvent){ev.preventDefault();timelinePanelDrag.current={y:ev.clientY,height:timelineHeight};(ev.currentTarget as Element).setPointerCapture(ev.pointerId);}
  function moveTimelineResize(ev:React.PointerEvent){const drag=timelinePanelDrag.current;if(!drag)return;setTimelineHeight(clamp(drag.height-(ev.clientY-drag.y),160,Math.max(160,window.innerHeight-320)));}
  function endTimelineResize(){timelinePanelDrag.current=null;}
  function beginDrag(ev:React.PointerEvent,mode:'move'|'resize'|'rotate'|'pivot',id=selected[0]){
    ev.preventDefault();ev.stopPropagation();
    setAlignmentGuides(null);
    if(ev.button!==0)return;
    const raw=project.elements.find(e=>e.id===id),world=evaluated.find(e=>e.id===id);if(!raw||!world||raw.locked)return;
    if(raw.attachment&&mode==='pivot'){alert('Pivot is locked by the attachment. Edit attachment settings in Properties.');return;}
    if(raw.attachment&&mode==='rotate'&&raw.attachment.type!=='hinge'){alert('Rotation is locked by this attachment. Choose a hinge to rotate this part.');return;}
    if(raw.attachment&&mode==='rotate'&&rotationOrigin==='world'){alert('Detach this constrained part to rotate it around a world point.');return;}
    if(parentId(raw)&&(mode==='resize'||mode==='pivot')){alert('Edit this part’s size or pivot in Properties.');return;}
    if(raw.attachment&&mode==='move'){alert('This part is attached. Edit its anchor coordinates or rotation in Properties.');return;}
    if(mode==='rotate'&&rotationOrigin==='world'){try{rotateSelectionAroundWorldPoint(project,selected.includes(id)?selected:[id],time,worldPoint,0,recordKeys);}catch(error){alert(error instanceof Error?error.message:String(error));return;}}
    stop();setTimelineItems([]);setKeySelection(null);(ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);const pt=stagePoint(ev,raw.sceneId);drag.current={base:project,id,mode,px:pt.x,py:pt.y,start:clone(evaluateElement(raw,time)??raw),world:clone(world),rotationCenter:mode==='rotate'&&rotationOrigin==='world'?{...worldPoint}:undefined,rotationIds:selected.includes(id)?selected:[id]};
  }
  function stageDown(ev:React.PointerEvent){const hit=ev.button===0?hitStageElement(ev):undefined;if(((ev.button===1||ev.altKey&&!hit)&&startPan(ev))||ev.button!==0)return;if(pickingWorldPoint){ev.preventDefault();ev.stopPropagation();setWorldPoint(stagePoint(ev,selectedElement?.sceneId));setPickingWorldPoint(false);return;}setTimelineItems([]);setKeySelection(null);if(hit){setSelected(ev.shiftKey?[...new Set([...selected,hit.id])]:[hit.id]);beginDrag(ev,pivotMode?'pivot':'move',hit.id);}else{const pt=stageCanvasPoint(ev);if(!ev.shiftKey)setSelected([]);marqueeDrag.current={x:pt.x,y:pt.y,currentX:pt.x,currentY:pt.y,extend:ev.shiftKey};setMarquee({x:pt.x,y:pt.y,width:0,height:0});(ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);}}
  function moveDrag(ev:React.PointerEvent){const box=marqueeDrag.current;if(box){const pt=stageCanvasPoint(ev);box.currentX=pt.x;box.currentY=pt.y;setMarquee({x:Math.min(box.x,pt.x),y:Math.min(box.y,pt.y),width:Math.abs(box.x-pt.x),height:Math.abs(box.y-pt.y)});return;}const d=drag.current;if(!d)return;const pt=stagePoint(ev,d.world.sceneId),dx=pt.x-d.px,dy=pt.y-d.py;const p=clone(d.base),e=p.elements.find(v=>v.id===d.id)!;let patch:Partial<StoryElement>={};
    if(d.mode==='move'){let mx=dx,my=dy;if(parentId(e)){const parent=evaluateProject(d.base,time).find(v=>v.id===parentId(e));if(parent){const r=-parent.rotation*Math.PI/180;mx=(dx*Math.cos(r)-dy*Math.sin(r))/parent.scaleX;my=(dx*Math.sin(r)+dy*Math.cos(r))/parent.scaleY;}}if(ev.shiftKey){if(axes==='local'){const r=-d.start.rotation*Math.PI/180;const lx=mx*Math.cos(r)-my*Math.sin(r),ly=mx*Math.sin(r)+my*Math.cos(r);const x=Math.abs(lx)>Math.abs(ly)?lx:0,y=Math.abs(lx)>Math.abs(ly)?0:ly;mx=x*Math.cos(-r)-y*Math.sin(-r);my=x*Math.sin(-r)+y*Math.cos(-r);}else{if(Math.abs(mx)>Math.abs(my))my=0;else mx=0;}}const x=d.start.x+mx,y=d.start.y+my;let aligned:{position:{x:number;y:number};guides:StageAlignmentGuides}|null=null;if(snap&&!ev.altKey&&!parentId(e)){const width=stageBox.current?.getBoundingClientRect().width??project.width;const tolerance=8*project.width/Math.max(width*selectionCamera.zoom,1);const excluded=new Set(selected);excluded.add(e.id);aligned=snapStagePosition(d.world,evaluateProject(d.base,time).filter(other=>!excluded.has(other.id)),{x,y},{width:project.width,height:project.height},tolerance);}setAlignmentGuides(aligned?.guides??null);patch={x:aligned?.guides.x!==undefined?aligned.position.x:snap&&!ev.altKey?Math.round(x/10)*10:x,y:aligned?.guides.y!==undefined?aligned.position.y:snap&&!ev.altKey?Math.round(y/10)*10:y};}
    else setAlignmentGuides(null);
    if(d.mode==='resize')patch={width:Math.max(8,d.start.width+dx),height:Math.max(8,d.start.height+dy)};
    if(d.mode==='rotate'){
      // The renderer flattens hierarchy rotation additively, so pointer-angle changes map directly to local rotation.
      const center=d.rotationCenter??d.world;
      const angle=(x:number,y:number)=>Math.atan2(y-center.y,x-center.x);
      const delta=angle(pt.x,pt.y)-angle(d.px,d.py);let r=d.start.rotation+Math.atan2(Math.sin(delta),Math.cos(delta))*180/Math.PI;
      if(snap&&!ev.altKey)r=Math.round(r/15)*15;
      if(e.attachment?.type==='hinge'){const min=e.attachment.min??-180,max=e.attachment.max??180;r=clamp(r,Math.min(min,max),Math.max(min,max));}
      if(d.rotationCenter){try{const rotated=rotateSelectionAroundWorldPoint(d.base,d.rotationIds??[d.id],time,d.rotationCenter,r-d.start.rotation,recordKeys);projectRef.current=rotated;setProject(rotated);}catch(error){alert(error instanceof Error?error.message:String(error));}return;}
      patch={rotation:r};
    }
    if(d.mode==='pivot'){const a=-d.start.rotation*Math.PI/180;const lx=(dx*Math.cos(a)-dy*Math.sin(a))/d.start.scaleX,ly=(dx*Math.sin(a)+dy*Math.cos(a))/d.start.scaleY;setPivotWithoutMovingArt(e,d.start.pivotX+lx/d.start.width,d.start.pivotY+ly/d.start.height,d.start);}
    for(const [k,v]of Object.entries(patch)){if(recordKeys&&d.mode!=='pivot'&&['x','y','rotation'].includes(k))setKey(e,k as AnimProperty,v as number);else Object.assign(e,{[k]:v});}projectRef.current=p;setProject(p);
  }
  function endDrag(){
    setAlignmentGuides(null);
    const box=marqueeDrag.current;
    if(box){
      marqueeDrag.current=null;setMarquee(null);
      const left=Math.min(box.x,box.currentX),right=Math.max(box.x,box.currentX);
      const top=Math.min(box.y,box.currentY),bottom=Math.max(box.y,box.currentY);
      if(right-left>3||bottom-top>3){
        const editable=new Set(project.elements.map(element=>element.id));
        const hits=evaluated.filter(element=>{
          if(!editable.has(element.id)||(element.sceneId&&element.sceneId!==sceneIdAt(project,time))||
            element.kind==='audio'||element.kind==='group'||element.locked)return false;
          const angle=element.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
          const scene=project.sequences.find(item=>item.id===element.sceneId);
          const view=scene?evaluateCameraForScene(project,scene,time):evaluateCamera(project,time);
          const points=[[0,0],[element.width,0],[element.width,element.height],[0,element.height]].map(([x,y])=>{
            const dx=(x-element.width*element.pivotX)*element.scaleX;
            const dy=(y-element.height*element.pivotY)*element.scaleY;
            const world={x:element.x+dx*c-dy*s,y:element.y+dx*s+dy*c};
            const stage=cameraToStage(world,view,project);
            return scene?mapSceneFramePoint(project,scene,stage):stage;
          });
          return Math.max(...points.map(point=>point.x))>=left&&Math.min(...points.map(point=>point.x))<=right&&
            Math.max(...points.map(point=>point.y))>=top&&Math.min(...points.map(point=>point.y))<=bottom;
        }).map(element=>element.id);
        setSelected(box.extend?[...new Set([...selected,...hits])]:hits);
      }
      return;
    }
    const dragState=drag.current;
    if(dragState){drag.current=null;commit(clone(projectRef.current),dragState.base);}
  }

  function timelineItemId(item:TimelineItem){return item.kind==='clip'?`clip:${item.elementId}`:item.kind==='key'?`key:${item.elementId}:${item.property}:${item.keyId}`:`camera:${item.sequenceId}:${item.property}:${item.keyId}`;}
  function setTimelineSelection(items:TimelineItem[],primary?:TimelineItem){setTimelineItems(items);const key=(primary?.kind==='key'?primary:items.filter(item=>item.kind==='key').at(-1)) as Extract<TimelineItem,{kind:'key'}>|undefined;setKeySelection(key?{element:key.elementId,property:key.property,key:key.keyId}:null);if(items.length)setSelected([...new Set(items.filter(item=>item.kind!=='cameraKey').map(item=>item.elementId))]);}
  function selectTimelineItem(item:TimelineItem,ev:{ctrlKey:boolean;metaKey:boolean;shiftKey:boolean}):TimelineItem[]{
    const id=timelineItemId(item),has=timelineItems.some(current=>timelineItemId(current)===id);
    let next:TimelineItem[];
    if(ev.shiftKey&&timelineAnchor.current?.kind===item.kind){
      const anchor=timelineAnchor.current;
      if(item.kind==='clip'&&anchor.kind==='clip'){
        const ordered=[...project.elements].reverse().map(element=>element.id),a=ordered.indexOf(anchor.elementId),b=ordered.indexOf(item.elementId);
        next=a<0||b<0?[item]:ordered.slice(Math.min(a,b),Math.max(a,b)+1).map(elementId=>({kind:'clip',elementId} as TimelineItem));
      }else if(item.kind==='key'&&anchor.kind==='key'&&anchor.elementId===item.elementId&&anchor.property===item.property){
        const track=project.elements.find(element=>element.id===item.elementId)?.tracks.find(track=>track.property===item.property);
        const ordered=[...(track?.keyframes??[])].sort((a,b)=>a.time-b.time),a=ordered.findIndex(key=>key.id===anchor.keyId),b=ordered.findIndex(key=>key.id===item.keyId);
        next=a<0||b<0?[item]:ordered.slice(Math.min(a,b),Math.max(a,b)+1).map(key=>({kind:'key',elementId:item.elementId,property:item.property,keyId:key.id} as TimelineItem));
      }else if(item.kind==='cameraKey'&&anchor.kind==='cameraKey'&&anchor.sequenceId===item.sequenceId&&anchor.property===item.property){
        const track=project.sequences.find(sequence=>sequence.id===item.sequenceId)?.camera?.tracks.find(track=>track.property===item.property);
        const ordered=[...(track?.keyframes??[])].sort((a,b)=>a.time-b.time),a=ordered.findIndex(key=>key.id===anchor.keyId),b=ordered.findIndex(key=>key.id===item.keyId);
        next=a<0||b<0?[item]:ordered.slice(Math.min(a,b),Math.max(a,b)+1).map(key=>({kind:'cameraKey',sequenceId:item.sequenceId,property:item.property,keyId:key.id} as TimelineItem));
      }else next=[item];
      if(ev.ctrlKey||ev.metaKey)next=[...new Map([...timelineItems,...next].map(entry=>[timelineItemId(entry),entry])).values()];
    }else if(ev.ctrlKey||ev.metaKey){next=has?timelineItems.filter(current=>timelineItemId(current)!==id):[...timelineItems,item];timelineAnchor.current=item;}
    else{next=has?timelineItems:[item];timelineAnchor.current=item;}
    setTimelineSelection(next,item);
    return next;
  }
  function timelineTimeAt(ev:{clientX:number;altKey:boolean}, lane:Element,movingPlayhead=false){const rect=lane.getBoundingClientRect();const raw=clamp((ev.clientX-rect.left)/rect.width*project.duration,0,project.duration);const step=rulerStep(project.duration,rect.width);const tick=clamp(Math.round(raw/step)*step,0,project.duration);const targets=timelineSnapTargets(project,movingPlayhead?{}:{playhead:time});targets.push(tick);return clamp(snapTimelineTime(raw,{duration:project.duration,laneWidth:rect.width,fps:project.fps,targets,enabled:snap&&!ev.altKey}),0,project.duration);}
  function startPlayheadDrag(ev:React.PointerEvent){if(ev.button!==0)return;ev.stopPropagation();setTimelineItems([]);setKeySelection(null);ev.currentTarget.setPointerCapture(ev.pointerId);playheadDrag.current=ev.pointerId;seek(timelineTimeAt(ev,ev.currentTarget,true),true);}
  function movePlayheadDrag(ev:React.PointerEvent){if(playheadDrag.current===ev.pointerId)seek(timelineTimeAt(ev,ev.currentTarget,true),true);}
  function endPlayheadDrag(ev:React.PointerEvent){if(playheadDrag.current===ev.pointerId)playheadDrag.current=null;}
  function startTimelineMarquee(ev:React.PointerEvent){if(ev.button!==0||ev.target!==ev.currentTarget)return;ev.currentTarget.setPointerCapture(ev.pointerId);timelineMarqueeDrag.current={x:ev.clientX,y:ev.clientY,currentX:ev.clientX,currentY:ev.clientY,extend:ev.ctrlKey||ev.metaKey||ev.shiftKey,pointerId:ev.pointerId,lane:ev.currentTarget};}
  function moveTimelineMarquee(ev:React.PointerEvent){const d=timelineMarqueeDrag.current;if(!d||d.pointerId!==ev.pointerId)return;d.currentX=ev.clientX;d.currentY=ev.clientY;if(Math.abs(d.x-ev.clientX)>3||Math.abs(d.y-ev.clientY)>3)setTimelineMarquee({left:Math.min(d.x,ev.clientX),top:Math.min(d.y,ev.clientY),width:Math.abs(d.x-ev.clientX),height:Math.abs(d.y-ev.clientY)});}
  function endTimelineMarquee(ev:React.PointerEvent){
    const d=timelineMarqueeDrag.current;if(!d||d.pointerId!==ev.pointerId)return;
    timelineMarqueeDrag.current=null;setTimelineMarquee(null);
    const left=Math.min(d.x,ev.clientX),right=Math.max(d.x,ev.clientX),top=Math.min(d.y,ev.clientY),bottom=Math.max(d.y,ev.clientY);
    if(right-left<=3&&bottom-top<=3){if(!d.extend){setTimelineSelection([]);seek(timelineTimeAt(ev,d.lane),true);}return;}
    const hits:TimelineItem[]=[];
    for(const node of timelineBody.current?.querySelectorAll<HTMLElement>('.clip-block[data-element-id],.key-dot[data-key-id],.camera-key-dot[data-camera-key-id]')??[]){
      const rect=node.getBoundingClientRect();if(rect.right<left||rect.left>right||rect.bottom<top||rect.top>bottom)continue;
      if(node.dataset.cameraKeyId&&node.dataset.sequenceId&&node.dataset.property){hits.push({kind:'cameraKey',sequenceId:node.dataset.sequenceId,property:node.dataset.property as CameraProperty,keyId:node.dataset.cameraKeyId});continue;}
      const elementId=node.dataset.elementId;if(!elementId)continue;
      if(node.dataset.keyId&&node.dataset.property)hits.push({kind:'key',elementId,property:node.dataset.property as AnimProperty,keyId:node.dataset.keyId});else hits.push({kind:'clip',elementId});
    }
    const combined=d.extend?[...timelineItems,...hits]:hits;
    setTimelineSelection([...new Map(combined.map(item=>[timelineItemId(item),item])).values()]);timelineAnchor.current=hits.at(-1)??null;
  }
  function startTimelineDrag(ev:React.PointerEvent,e:StoryElement,mode:'move'|'trim'){if(ev.button!==0)return;ev.stopPropagation();const item:TimelineItem={kind:'clip',elementId:e.id};const items=selectTimelineItem(item,ev);if(ev.ctrlKey||ev.metaKey||ev.shiftKey)return;stop();ev.currentTarget.setPointerCapture(ev.pointerId);const base=projectRef.current,clipIds=items.filter(entry=>entry.kind==='clip').map(entry=>entry.elementId),clips=base.elements.filter(entry=>clipIds.includes(entry.id));const anchors=mode==='move'?clips.flatMap(entry=>[entry.start,entry.start+entry.duration]):clips.map(entry=>entry.start+entry.duration);timelineDrag.current={base,id:e.id,mode,x:ev.clientX,start:e.start,duration:e.duration,pixels:ev.currentTarget.closest('.timeline-lane')!.getBoundingClientRect().width,items,anchors,targets:timelineSnapTargets(base,{playhead:time,excludeElementIds:clipIds})};}
  function moveTimelineDrag(ev:React.PointerEvent){const d=timelineDrag.current;if(!d)return;const raw=(ev.clientX-d.x)/d.pixels*d.base.duration;const delta=snapTimelineDelta(raw,d.anchors,{duration:d.base.duration,laneWidth:d.pixels,fps:d.base.fps,targets:d.targets,enabled:snap&&!ev.altKey});try{const p=d.mode==='move'?moveTimelineItems(d.base,d.items,delta,{ripple}):trimTimelineClips(d.base,d.items.filter(item=>item.kind==='clip').map(item=>item.elementId),delta,{ripple});projectRef.current=p;setProject(p);}catch{/* Preserve the last valid preview. */}}
  function endTimelineDrag(){const d=timelineDrag.current;if(d){timelineDrag.current=null;if(projectRef.current!==d.base)commit(clone(projectRef.current),d.base);}}
  function startKeyDrag(ev:React.PointerEvent,e:StoryElement,property:AnimProperty,key:string,keyTime:number){if(ev.button!==0)return;ev.preventDefault();ev.stopPropagation();const item:TimelineItem={kind:'key',elementId:e.id,property,keyId:key};const items=selectTimelineItem(item,ev);if(ev.ctrlKey||ev.metaKey||ev.shiftKey)return;stop();setTime(e.start+keyTime);ev.currentTarget.setPointerCapture(ev.pointerId);const base=projectRef.current;keyDrag.current={base,element:e.id,property,key,x:ev.clientX,start:keyTime,anchor:e.start+keyTime,pixels:ev.currentTarget.closest('.timeline-lane')!.getBoundingClientRect().width,moved:false,items,targets:timelineSnapTargets(base)};}
  function moveKeyDrag(ev:React.PointerEvent){const d=keyDrag.current;if(!d||Math.abs(ev.clientX-d.x)<2&&!d.moved)return;d.moved=true;const raw=(ev.clientX-d.x)/d.pixels*d.base.duration;const delta=snapTimelineDelta(raw,[d.anchor],{duration:d.base.duration,laneWidth:d.pixels,fps:d.base.fps,targets:d.targets,enabled:snap&&!ev.altKey});try{const p=moveTimelineItems(d.base,d.items,delta,{ripple});projectRef.current=p;setProject(p);setTime(clamp(p.elements.find(e=>e.id===d.element)!.start+d.start+delta,0,p.duration));}catch{/* Preserve the last valid preview. */}}
  function endKeyDrag(){const d=keyDrag.current;if(d){keyDrag.current=null;if(d.moved&&projectRef.current!==d.base)commit(clone(projectRef.current),d.base);}}
  function startCameraKeyDrag(ev:React.PointerEvent,sequenceId:string,property:CameraProperty,keyId:string,keyTime:number){if(ev.button!==0)return;ev.preventDefault();ev.stopPropagation();const item:TimelineItem={kind:'cameraKey',sequenceId,property,keyId};const items=selectTimelineItem(item,ev);if(ev.ctrlKey||ev.metaKey||ev.shiftKey)return;stop();const base=projectRef.current,scene=base.sequences.find(candidate=>candidate.id===sequenceId);if(!scene)return;setTime(scene.start+keyTime);ev.currentTarget.setPointerCapture(ev.pointerId);cameraDrag.current={base,sequenceId,start:keyTime,anchor:scene.start+keyTime,x:ev.clientX,pixels:ev.currentTarget.closest('.timeline-lane')!.getBoundingClientRect().width,moved:false,items,targets:timelineSnapTargets(base)};}
  function moveCameraKeyDrag(ev:React.PointerEvent){const d=cameraDrag.current;if(!d||Math.abs(ev.clientX-d.x)<2&&!d.moved)return;d.moved=true;const raw=(ev.clientX-d.x)/d.pixels*d.base.duration;const delta=snapTimelineDelta(raw,[d.anchor],{duration:d.base.duration,laneWidth:d.pixels,fps:d.base.fps,targets:d.targets,enabled:snap&&!ev.altKey});try{const next=moveTimelineItems(d.base,d.items,delta,{ripple});projectRef.current=next;setProject(next);const scene=next.sequences.find(candidate=>candidate.id===d.sequenceId);if(scene)setTime(clamp(scene.start+d.start+delta,0,next.duration));}catch{/* Preserve the last valid preview. */}}
  function endCameraKeyDrag(){const d=cameraDrag.current;if(d){cameraDrag.current=null;if(d.moved&&projectRef.current!==d.base)commit(clone(projectRef.current),d.base);}}
  function deleteSelectedKeyframe(){const keys=timelineItems.filter((item):item is Extract<TimelineItem,{kind:'key'}>=>item.kind==='key');if(!keys.length&&keySelection)keys.push({kind:'key',elementId:keySelection.element,property:keySelection.property,keyId:keySelection.key});if(!keys.length)return;edit(p=>{for(const {elementId,property,keyId} of keys){const item=p.elements.find(e=>e.id===elementId);const track=item?.tracks.find(t=>t.property===property);if(!item||!track)continue;track.keyframes=track.keyframes.filter(k=>k.id!==keyId);item.tracks=item.tracks.filter(t=>t.keyframes.length>0);}});setTimelineSelection(timelineItems.filter(item=>item.kind!=='key'));setTimelineContext(null);}
  function duplicateSelectedKeyframe(){if(!keySelection)return;const sources=timelineItems.filter((item):item is Extract<TimelineItem,{kind:'key'}>=>item.kind==='key');if(!sources.length)sources.push({kind:'key',elementId:keySelection.element,property:keySelection.property,keyId:keySelection.key});const next=clone(projectRef.current),created:TimelineItem[]=[];for(const source of sources){const element=next.elements.find(item=>item.id===source.elementId);const track=element?.tracks.find(item=>item.property===source.property);const original=track?.keyframes.find(item=>item.id===source.keyId);if(!element||!track||!original)continue;const target=original.time+1/next.fps;if(target>element.duration+1e-7||track.keyframes.some(item=>Math.abs(item.time-target)<1e-7)){alert('Move the selection to leave one free frame before duplicating keyframes.');return;}const copy=clone(original);copy.id=uid();copy.time=target;track.keyframes.push(copy);created.push({kind:'key',elementId:element.id,property:source.property,keyId:copy.id});}if(!created.length)return;for(const element of next.elements)for(const track of element.tracks)track.keyframes.sort((a,b)=>a.time-b.time);commit(next);setTimelineSelection(created,created.at(-1));setTimelineContext(null);}
  function updateKey(patch:Record<string,unknown>){if(!keySelection)return;const keys=timelineItems.filter((item):item is Extract<TimelineItem,{kind:'key'}>=>item.kind==='key');if(!keys.length)keys.push({kind:'key',elementId:keySelection.element,property:keySelection.property,keyId:keySelection.key});if(typeof patch.time==='number'){const delta=patch.time-(activeKey?.time??0);try{const next=moveTimelineItems(projectRef.current,keys,snap?Math.round(delta*project.fps)/project.fps:delta);if(next!==projectRef.current)commit(next);}catch(error){alert(error instanceof Error?error.message:String(error));}return;}edit(p=>{for(const {elementId,property,keyId} of keys){const element=p.elements.find(e=>e.id===elementId);const track=element?.tracks.find(t=>t.property===property);const key=track?.keyframes.find(k=>k.id===keyId);if(key)Object.assign(key,patch);}});}
  function changeTimelineTiming(field:'start'|'duration',value:number){if(!selectedElement)return;const clips=timelineItems.filter((item):item is Extract<TimelineItem,{kind:'clip'}>=>item.kind==='clip');if(!clips.length)clips.push({kind:'clip',elementId:selectedElement.id});const anchor=clips.some(item=>item.elementId===selectedElement.id)?selectedElement:project.elements.find(item=>item.id===clips[0].elementId)??selectedElement;const delta=value-anchor[field];try{const next=field==='start'?moveTimelineItems(projectRef.current,clips,delta,{ripple}):trimTimelineClips(projectRef.current,clips.map(item=>item.elementId),delta,{ripple});if(next!==projectRef.current)commit(next);}catch(error){alert(error instanceof Error?error.message:String(error));}}
  function deleteTimelineSelection(){if(!timelineItems.length){removeSelected();return;}const clips=timelineItems.filter((item):item is Extract<TimelineItem,{kind:'clip'}>=>item.kind==='clip');const keys=timelineItems.filter((item):item is Extract<TimelineItem,{kind:'key'}>=>item.kind==='key');const cameraKeys=timelineItems.filter((item):item is Extract<TimelineItem,{kind:'cameraKey'}>=>item.kind==='cameraKey');edit(p=>{const ids=descendantIds(p,clips.map(item=>item.elementId));p.elements=p.elements.filter(item=>!ids.has(item.id));for(const element of p.elements)if(element.flowAroundId&&ids.has(element.flowAroundId))delete element.flowAroundId;for(const {elementId,property,keyId} of keys){const element=p.elements.find(item=>item.id===elementId);const track=element?.tracks.find(item=>item.property===property);if(!track)continue;track.keyframes=track.keyframes.filter(key=>key.id!==keyId);element!.tracks=element!.tracks.filter(item=>item.keyframes.length);}for(const {sequenceId,property,keyId} of cameraKeys){const camera=p.sequences.find(item=>item.id===sequenceId)?.camera;const track=camera?.tracks.find(item=>item.property===property);if(!track||!camera)continue;track.keyframes=track.keyframes.filter(key=>key.id!==keyId);camera.tracks=camera.tracks.filter(item=>item.keyframes.length);}});setTimelineItems([]);setSelected([]);setKeySelection(null);setTimelineContext(null);}
  function addScene(){const p=clone(projectRef.current);const start=Math.max(p.duration,...p.sequences.map(scene=>scene.start+scene.duration));const duration=8;p.sequences.push({id:uid(),name:`Scene ${String(p.sequences.length+1).padStart(2,'0')}`,start,duration,color:'#ffc857'});p.duration=start+duration;commit(p);seek(start);}
  function insertCaption(){try{stop();const result=addCaption(projectRef.current,time);commit(result.project);setSelected([]);setTimelineItems([]);setKeySelection(null);setSelectedCaptionId(result.caption.id);setTime(result.caption.start);}catch(error){alert(error instanceof Error?error.message:String(error));}}
  function changeCaption(id:string,patch:Parameters<typeof editCaption>[2]):boolean{try{commit(editCaption(projectRef.current,id,patch));return true;}catch(error){alert(error instanceof Error?error.message:String(error));return false;}}
  function removeCaption(id:string){commit(deleteCaption(projectRef.current,id));setSelectedCaptionId(null);}
  function addKeyAt(elementId:string,property:AnimProperty,at:number){const raw=projectRef.current.elements.find(e=>e.id===elementId);if(!raw)return;const value=property==='assetId'?((evaluateElement(raw,at)??raw).assetId??''):((evaluateElement(raw,at)??raw)[property]??1);edit(p=>{const e=p.elements.find(item=>item.id===elementId)!;let track=e.tracks.find(item=>item.property===property);if(!track){track={property,keyframes:[]};e.tracks.push(track);}const keyTime=clamp(Math.round((at-e.start)*p.fps)/p.fps,0,e.duration);const previous=track.keyframes.find(k=>Math.abs(k.time-keyTime)<1e-8);if(previous)previous.value=value;else track.keyframes.push({id:uid(),time:keyTime,value,easing:'linear',direction:'inOut',mode:'smooth'});track.keyframes.sort((a,b)=>a.time-b.time);});setSelected([elementId]);setExpanded(v=>v.includes(elementId)?v:[...v,elementId]);seek(at);setTimelineContext(null);}
  function renameScene(id:string){const current=projectRef.current.sequences.find(scene=>scene.id===id);if(!current)return;cancelledSceneRename.current=null;setSceneRename({id,value:current.name});setTimelineContext(null);}
  function commitSceneRename(id:string,value:string){const name=value.trim(),current=projectRef.current.sequences.find(scene=>scene.id===id);setSceneRename(null);if(!current||name===current.name)return;if(!name){alert('Scene names cannot be empty.');return;}edit(p=>{p.sequences.find(scene=>scene.id===id)!.name=name;});}
  function editSceneDuration(id:string){const current=projectRef.current.sequences.find(scene=>scene.id===id);if(!current)return;setSceneDialog({id,kind:'duration',value:String(round(current.duration))});setTimelineContext(null);}
  function applySceneDialog(){if(!sceneDialog)return;try{if(sceneDialog.kind==='rename'){commitSceneRename(sceneDialog.id,sceneDialog.value);}else{const duration=Number(sceneDialog.value);const next=retimeScene(projectRef.current,sceneDialog.id,duration);stop();commit(next);setTime(t=>clamp(t,0,next.duration));}setSceneDialog(null);}catch(error){alert(error instanceof Error?error.message:String(error));}}
  function changeScene(action:'duplicate'|'delete'|'earlier'|'later',id:string){try{stop();const source=projectRef.current;const ordered=[...source.sequences].sort((a,b)=>a.start-b.start);const index=ordered.findIndex(scene=>scene.id===id);if(index<0)return;if(action==='duplicate'){const result=duplicateScene(source,id);commit(result.project);setTime(result.start);}else if(action==='delete'){const next=deleteScene(source,id);commit(next);setTime(t=>clamp(t,0,next.duration));}else{const target=action==='earlier'?ordered[index-1]?.id:ordered[index+2]?.id;if(action==='earlier'&&!target||action==='later'&&index===ordered.length-1)return;commit(moveScene(source,id,target));setTime(projectRef.current.sequences.find(scene=>scene.id===id)?.start??0);}setTimelineContext(null);}catch(error){alert(error instanceof Error?error.message:String(error));}}
  function linkScene(id:string){try{stop();const result=placeLinkedScene(projectRef.current,id);commit(result.project);seek(result.project.sequences.find(scene=>scene.id===result.sceneId)!.start);setTimelineContext(null);}catch(error){alert(error instanceof Error?error.message:String(error));}}
  function unlinkScene(id:string){try{stop();commit(makeSceneIndependent(projectRef.current,id));setTimelineContext(null);}catch(error){alert(error instanceof Error?error.message:String(error));}}
  function changeLinkedScene(id:string,patch:Partial<Pick<Project['sequences'][number],'sourceIn'|'sourceOut'|'muted'|'frame'|'frameFit'|'frameRotation'|'opacity'>>){try{const next=clone(projectRef.current);const scene=next.sequences.find(item=>item.id===id)!;Object.assign(scene,patch);if(scene.frame&&(!Number.isFinite(scene.frame.x)||!Number.isFinite(scene.frame.y)||!Number.isFinite(scene.frame.width)||!Number.isFinite(scene.frame.height)||scene.frame.width<=0||scene.frame.height<=0))throw new Error('Choose a valid placement frame.');if(scene.frameRotation!==undefined&&!Number.isFinite(scene.frameRotation))throw new Error('Choose a valid frame rotation.');if(scene.opacity!==undefined&&(scene.opacity<0||scene.opacity>1))throw new Error('Placement opacity must be between 0 and 100%.');materializeScenePlacements(next);stop();commit(next);}catch(error){alert(error instanceof Error?error.message:String(error));}}
  function zoomTimeline(factor:number,clientX?:number){const viewport=timelineBody.current;if(!viewport)return;const rect=viewport.getBoundingClientRect();const x=clientX===undefined?rect.width/2:clientX-rect.left;const label=rulerBody.current?.previousElementSibling?.getBoundingClientRect().width??220;const relative=clamp((viewport.scrollLeft+x-label)/Math.max(1,viewport.scrollWidth-label),0,1);setTimelineScale(current=>clamp(current*factor,1,16));requestAnimationFrame(()=>{viewport.scrollLeft=Math.max(0,relative*Math.max(1,viewport.scrollWidth-label)+label-x);});}
  function timelineWheel(ev:React.WheelEvent){const viewport=timelineBody.current;if(!viewport)return;if(ev.ctrlKey||ev.metaKey){ev.preventDefault();zoomTimeline(ev.deltaY<0?1.25:.8,ev.clientX);return;}if(ev.shiftKey){ev.preventDefault();viewport.scrollTop+=ev.deltaY||ev.deltaX;return;}if((ev.target as Element).closest('.timeline-lane,.ruler')){ev.preventDefault();viewport.scrollLeft+=ev.deltaY+ev.deltaX;}}
  async function record(){
    if(recording){finishRecording.current?.();return;}
    try{
      if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw new Error('Microphone recording needs a supported browser on HTTPS or localhost.');
      stop();setPreparing(true);
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});recStream.current=stream;
      if(monitorWhileRecording){
        const monitor=new AudioContext();recordingMonitor.current=monitor;
        monitor.createMediaStreamSource(stream).connect(monitor.destination);
        await monitor.resume();
      }
      const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t));
      const r=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);recorder.current=r;const chunks:Blob[]=[];
      const requestedStart=time>=projectRef.current.duration?0:time;
      const playback=recordingPlaybackProject(projectRef.current,muteWhileRecording);
      recordingPlayback.current=playback;
      await transport.current.play(playback,requestedStart);
      let start=transport.current.time,endedAt:number|null=null;
      finishRecording.current=()=>{if(r.state==='recording'){endedAt=transport.current.time;r.stop();}};
      r.onstart=()=>{start=transport.current.time;};
      r.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      r.onstop=()=>{
        const elapsed=Math.max(1/projectRef.current.fps,(endedAt??transport.current.time)-start);
        stream.getTracks().forEach(t=>t.stop());void recordingMonitor.current?.close();recordingMonitor.current=null;setRecording(false);stop();finishRecording.current=null;recorder.current=null;
        const blob=new Blob(chunks,{type:r.mimeType});
        if(!blob.size){alert('No microphone audio was captured.');return;}
        void readData(new File([blob],'Voice recording')).then(dataUrl=>{
          const p=clone(projectRef.current);const asset:Asset={id:uid(),name:'Voice recording',mime:blob.type,kind:'audio',dataUrl,duration:elapsed};p.assets.push(asset);
          const e=createElement('audio',{name:'Voice recording',assetId:asset.id,start,duration:elapsed,sceneId:sceneIdAt(p,start),recorded:true,recordingOffset:0});p.elements.push(e);p.duration=Math.max(p.duration,start+elapsed);commit(p);setSelected([e.id]);
        }).catch(e=>alert(String(e)));
      };
      r.onerror=()=>{alert('Microphone recording failed.');stream.getTracks().forEach(t=>t.stop());void recordingMonitor.current?.close();recordingMonitor.current=null;setRecording(false);stop();finishRecording.current=null;recorder.current=null;};
      r.start();setTime(start);setRecording(true);setPreparing(false);playRef.current=true;setPlaying(true);
    }catch(e){alert(String(e));recStream.current?.getTracks().forEach(t=>t.stop());void recordingMonitor.current?.close();recordingMonitor.current=null;setRecording(false);stop();finishRecording.current=null;recorder.current=null;}
  }

  useEffect(()=>{const handler=(event:KeyboardEvent)=>{
    if(!clipSessionRef.current&&!showStaleDraft)return;
    const target=event.target instanceof Element?event.target:null;
    if(event.key==='Escape'){
      event.preventDefault();event.stopImmediatePropagation();
      if(clipSessionRef.current){if(clipLeavePrompt)setClipLeavePrompt(false);else leaveClipSession();}
      else setShowStaleDraft(false);
      return;
    }
    if(target?.matches('input,textarea,select,[contenteditable]'))return;
    const mod=event.ctrlKey||event.metaKey;
    if(mod&&'szdgcv'.includes(event.key.toLowerCase())||['Delete','Backspace','ArrowLeft','ArrowRight'].includes(event.key)||event.code==='Space'&&!target?.closest('button,a,summary,[role="button"],[role="checkbox"],[role="slider"]')){
      event.preventDefault();event.stopImmediatePropagation();
    }
  };window.addEventListener('keydown',handler,true);return()=>window.removeEventListener('keydown',handler,true);},[clipLeavePrompt,showStaleDraft]);
  useEffect(()=>{function handler(ev:KeyboardEvent){const target=ev.target instanceof Element?ev.target:null;const typing=!!target?.matches('input,textarea,select,[contenteditable]');if(ev.key==='Escape'){setMenu(null);setDialog(null);setContext(null);setTimelineContext(null);setPivotMode(false);return;}if(typing)return;const mod=ev.ctrlKey||ev.metaKey;if(mod&&ev.key.toLowerCase()==='s'){ev.preventDefault();void save();}else if(mod&&ev.key.toLowerCase()==='z'){ev.preventDefault();ev.shiftKey?redo():undo();}else if(mod&&ev.key.toLowerCase()==='d'){ev.preventDefault();duplicate();}else if(mod&&ev.key.toLowerCase()==='g'){ev.preventDefault();groupSelection();}else if(ev.code==='Space'){if(target?.closest('button,a,summary,[role="button"],[role="checkbox"],[role="slider"]'))return;ev.preventDefault();void togglePlay();}else if(ev.key==='Delete'||ev.key==='Backspace'){ev.preventDefault();if(selectedCaptionId)removeCaption(selectedCaptionId);else if(timelineItems.length)deleteTimelineSelection();else if(keySelection)deleteSelectedKeyframe();else removeSelected();}else if(ev.key==='ArrowLeft'||ev.key==='ArrowRight'){ev.preventDefault();if(timelineItems.length){const direction=ev.key==='ArrowRight'?1:-1;const span=visibleTimelineRange[1]-visibleTimelineRange[0];const step=timelineNudgeStep(span,project.fps,snap);try{const next=moveTimelineItems(projectRef.current,timelineItems,direction*step,{ripple});if(next!==projectRef.current)commit(next);}catch(error){alert(error instanceof Error?error.message:String(error));}}else seek(time+(ev.key==='ArrowRight'?1:-1)/project.fps);}}window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);});

  useEffect(()=>{const handler=(event:KeyboardEvent)=>{
    if(!(event.ctrlKey||event.metaKey)||clipSessionRef.current)return;
    const target=event.target instanceof Element?event.target:null;
    if(target?.matches('input,textarea,select,[contenteditable]'))return;
    if(event.key.toLowerCase()==='c'&&selected.length){event.preventDefault();copySelection();}
    else if(event.key.toLowerCase()==='v'&&objectClipboard.current){event.preventDefault();pasteSelection();}
  };window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);});

  const activeKeyTrack=keySelection?project.elements.find(e=>e.id===keySelection.element)?.tracks.find(t=>t.property===keySelection.property):null;
  const activeKey=keySelection?activeKeyTrack?.keyframes.find(k=>k.id===keySelection.key):null;
  const activeKeyHasNext=!!activeKey&&!!activeKeyTrack&&activeKeyTrack.keyframes.some(key=>key.time>activeKey.time);
  const autoKeySuggested=!recordKeys&&!!selectedElement?.tracks.some(track=>['x','y','rotation'].includes(track.property)&&track.keyframes.length>0);
  const ticks=rulerTicks(project.duration,timelineWidth);
  const displayElement=selectedElement?(evaluateElement(selectedElement,time)??selectedElement):null;
  const sections=[...new Set(project.elements.map(e=>e.section).filter(Boolean))] as string[];
  const rows=[...project.elements].reverse().filter(e=>selected.includes(e.id)||(!e.section||!hiddenSections.includes(e.section))&&(showAll||e.start<=visibleTimelineRange[1]&&e.start+e.duration>=visibleTimelineRange[0]));
  const assemblyGapGroups=groupAssemblyGapSegments(selectAssemblyClipGapSegments(project));
  const orderedScenes=[...project.sequences].sort((a,b)=>a.start-b.start);
  const activeScene=orderedScenes.filter(scene=>time>=scene.start&&time<scene.start+scene.duration).at(-1)??orderedScenes.filter(scene=>scene.start<=time).at(-1)??orderedScenes[0];
  const camera=evaluateCamera(project,time);
  const selectedScene=project.sequences.find(scene=>scene.id===selectedWorld?.sceneId);
  const selectionCamera=selectedScene?evaluateCameraForScene(project,selectedScene,time):camera;
  const activeCameraKey=timelineItems.find((item):item is Extract<TimelineItem,{kind:'cameraKey'}>=>item.kind==='cameraKey'&&item.sequenceId===activeScene?.id);
  const caption=materializeScenePlacements(project).captions.find(c=>{const window=captionWindow(project,c);return !!window&&time>=window.start&&time<window.end;});
  const selectedCaption=!selected.length?project.captions.find(item=>item.id===selectedCaptionId):undefined;

  return <div ref={appRoot} className="app" style={{gridTemplateRows:`52px minmax(220px,1fr) ${timelineCollapsed?44:timelineHeight}px 27px`}} onPointerDown={()=>{if(context)setContext(null);}}>
    <input ref={fileInput} type="file" accept=".hyde,.hy" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void openFile(f);e.target.value='';}}/>
    <input ref={mediaInput} type="file" accept="image/*,video/*,audio/*" multiple hidden onChange={e=>{void importMedia(e.target.files);e.target.value='';}}/>
    <input ref={fontInput} type="file" accept=".woff2,.woff,.ttf,.otf" hidden onChange={e=>{void importFont(e.target.files?.[0]);e.target.value='';}}/>
    <input ref={assemblyInput} type="file" accept=".hyproj" multiple hidden onChange={e=>{const files=Array.from(e.target.files??[]);e.target.value='';void (async()=>{for(const f of files)await insertAssembly(f);})();}}/>
    <input ref={libraryInput} type="file" multiple hidden {...{webkitdirectory:''} as any} onChange={e=>{const files=Array.from(e.target.files??[]);setLibraryFiles(files.filter(f=>/\.hyproj$/i.test(f.name)||mediaMime(f).startsWith('audio/')));libraryHandle.current=null;setLibraryName(files[0]?.webkitRelativePath.split('/')[0]??'Selected folder');setLibrarySource('snapshot');setLeftTab('library');e.target.value='';}}/>
    <header className="topbar"><button className="brand" onClick={()=>setSplash(true)} title="Hyde home"><span className="brand-mark" aria-hidden="true">h<span>•</span></span><strong>hyde</strong><span className="build-label">STORY STUDIO</span></button><nav>{['File','Edit','View','Help'].map(name=><div className="menu-wrap" key={name}><button className={menu===name?'menu-active':''} onClick={()=>setMenu(menu===name?null:name)}>{name}</button>{menu===name&&<div className="dropdown">
      {name==='File'&&<><button onClick={()=>{setSplash(true);setMenu(null);}}><FilePlus2 size={14}/>New / recent project</button><button onClick={()=>{void chooseOpenProject();setMenu(null);}}><FolderOpen size={14}/>Open project…</button><button onClick={()=>{void save();setMenu(null);}}><Save size={14}/>Save project file <kbd>Ctrl S</kbd></button><button onClick={()=>{void save(true);setMenu(null);}}><Save size={14}/>Save as…</button><button onClick={()=>{void downloadProjectCopy();setMenu(null);}}><Download size={14}/>Download project copy</button><hr/><button onClick={()=>{mediaInput.current?.click();setMenu(null);}}>Import media…</button><button onClick={()=>{assemblyInput.current?.click();setMenu(null);}}>Import assembly…</button><button disabled={!selected.length} onClick={()=>{void exportAssembly();setMenu(null);}}>Export selected assembly…</button><hr/><button onClick={()=>{setDialog('export');setMenu(null);}}>Export story…</button></>}
      {name==='Edit'&&<><button disabled={!history.length} onClick={()=>{undo();setMenu(null);}}>Undo <kbd>Ctrl Z</kbd></button><button disabled={!future.length} onClick={()=>{redo();setMenu(null);}}>Redo <kbd>Ctrl Shift Z</kbd></button><hr/><button disabled={!selected.length} onClick={()=>{duplicate();setMenu(null);}}>Duplicate <kbd>Ctrl D</kbd></button><button disabled={!selected.length} onClick={()=>{copySelection();setMenu(null);}}>Copy selection <kbd>Ctrl C</kbd></button><button disabled={!objectClipboard.current} onClick={()=>{pasteSelection();setMenu(null);}}>Paste at playhead <kbd>Ctrl V</kbd></button><button disabled={!selected.length} onClick={()=>{groupSelection();setMenu(null);}}>Create assembly <kbd>Ctrl G</kbd></button><button disabled={!selected.length} onClick={()=>{removeSelected();setMenu(null);}}>{keySelection?'Delete keyframe':'Delete selection'}</button></>}
      {name==='View'&&<><button onClick={()=>{homeStage();setLeftWidth(220);setRightWidth(252);setRightCollapsed(false);setTimelineHeight(Math.max(205,Math.round(window.innerHeight*.29)));setTimelineCollapsed(false);setTimelineScale(1);setMenu(null);}}>Reset workspace view</button><button onClick={()=>{setShowAll(!showAll);setMenu(null);}}>{showAll?'Show active rows only':'Show all timeline rows'}</button><button onClick={()=>{setHiddenSections([]);setMenu(null);}}>Reveal timeline sections</button><button onClick={()=>{setDialog('settings');setMenu(null);}}>Project settings…</button></>}
      {name==='Help'&&<><button onClick={()=>{setDialog('help');setMenu(null);}}>Guide & shortcuts</button><button onClick={()=>{replaceProject(createPrimaryShowcase());setMenu(null);}}>Open primary showcase</button><button onClick={()=>{replaceProject(createExampleProject());setMenu(null);}}>Open example project</button></>}
    </div>}</div>)}</nav><div className="document-title"><span className="document-dot"/><input aria-label="Project name" value={project.name} onChange={e=>edit(p=>{p.name=e.target.value;})}/><span className="local-pill">LOCAL</span></div><div className="header-right"><Button icon={Undo2} label="Undo (Ctrl Z)" onClick={undo} disabled={!history.length}/><Button icon={Redo2} label="Redo" onClick={redo} disabled={!future.length}/><span className="divider"/><button className="save-button" onClick={()=>void save()}><Save size={14}/>Save</button><button className="primary small" onClick={()=>setDialog('export')}><Download size={14}/>Export</button></div></header>
    <div ref={workspaceBox} className="workspace" style={{gridTemplateColumns:`${leftWidth}px minmax(0,1fr) ${rightCollapsed?36:rightWidth}px`}}>
      <aside className="left-panel"><div className="panel-tabs">{(['layers','assets','library'] as const).map(t=><button className={leftTab===t?'selected':''} onClick={()=>setLeftTab(t)} key={t}>{t==='library'?'Libraries':t[0].toUpperCase()+t.slice(1)}</button>)}</div>
        {leftTab==='layers'&&<SceneContents project={project} time={time} selected={selected} onSelect={ids=>{setTimelineItems([]);setSelected(ids);setKeySelection(null);}} onChangeProject={next=>commit(next)} onAdd={add} onImportMedia={()=>mediaInput.current?.click()} onGroup={groupSelection} onDuplicate={duplicate} onCopy={copySelection} onPaste={pasteSelection} canPaste={!!objectClipboard.current} onExportAssembly={()=>void exportAssembly()} onEditPivot={()=>setPivotMode(true)} onMoveLayer={moveLayer} onRemove={removeSelected} deleteLabel={keySelection?'Delete keyframe':'Delete selection'} onNotice={alert}/>}
        {leftTab==='assets'&&<ProjectAssets project={project} time={time} onChangeProject={next=>commit(next)} onSelect={ids=>{setTimelineItems([]);setSelected(ids);setKeySelection(null);}} onImportMedia={()=>mediaInput.current?.click()}/>}
        {leftTab==='library'&&<SessionLibrary files={libraryFiles} depth={libraryDepth} source={librarySource} folderName={libraryName} onRefresh={()=>void refreshLibraryDirectory()} onDepthChange={setLibraryDepth} onOpenFolder={()=>void openLibraryDirectory()} onInsertAssembly={file=>void insertAssembly(file)} onImportMedia={files=>void importMedia(files)} onNotice={alert}/>}
      </aside>
      <div className="panel-resize-handle" role="separator" aria-label="Resize scene panel" aria-orientation="vertical" style={{left:leftWidth-4}} onPointerDown={beginPanelResize} onPointerMove={movePanelResize} onPointerUp={endPanelResize} onPointerCancel={endPanelResize}/>
      {!rightCollapsed&&<div className="panel-resize-handle right-resize-handle" role="separator" aria-label="Resize properties panel" aria-orientation="vertical" style={{right:rightWidth-4}} onPointerDown={beginRightResize} onPointerMove={moveRightResize} onPointerUp={endRightResize} onPointerCancel={endRightResize}/>}
      <section className="center"><div className="stage-toolbar"><div className="tool-group"><Button icon={MousePointer2} label="Select and move" active={!pivotMode} onClick={()=>setPivotMode(false)}/><Button icon={Target} label="Edit pivot (keeps artwork stationary)" active={pivotMode} onClick={()=>setPivotMode(!pivotMode)}/></div><span className="divider"/><div className="tool-group"><Button icon={Square} label="Add rectangle" onClick={()=>add('rectangle')}/><Button icon={Circle} label="Add ellipse" onClick={()=>add('ellipse')}/><Button icon={Triangle} label="Add polygon" onClick={()=>add('polygon')}/><Button icon={Type} label="Add text" onClick={()=>add('text')}/><Button icon={ImagePlus} label="Import image, video or audio" onClick={()=>mediaInput.current?.click()}/></div><div className="flex-spacer"/><button className="tool-text" title="Shift-drag constrains movement using these axes" onClick={()=>setAxes(axes==='world'?'local':'world')}>{axes==='world'?'World':'Local'}</button><Button icon={Grip} label="Snap to grid, frames, playhead, clip edges, and scene boundaries (Alt bypasses)" active={snap} onClick={()=>setSnap(!snap)}/><span className="divider"/><Button icon={Grid3X3} label="Show stage grid" active={gridEnabled} onClick={()=>setGridEnabled(!gridEnabled)}/>{gridEnabled&&<input className="grid-count" type="number" aria-label="Grid divisions" min={2} max={64} value={gridCount} onChange={e=>setGridCount(clamp(+e.target.value||2,2,64))}/>}<button className={'tool-text onion-toggle '+(onionPrevious?'active':'')} aria-pressed={onionPrevious} title="Previous keyframe outline (gray)" onClick={()=>setOnionPrevious(!onionPrevious)}>Prev</button><button className={'tool-text onion-toggle '+(onionNext?'active':'')} aria-pressed={onionNext} title="Next keyframe outline (yellow)" onClick={()=>setOnionNext(!onionNext)}>Next</button><span className="divider"/><button className="tool-text" onClick={()=>setDialog('settings')}>{project.width} × {project.height}</button></div>
        <div className="stage-breadcrumb"><span>Project</span><ChevronRight size={12}/><strong>{activeScene?.name||'Scene 01'}</strong><span className="stage-badge">{recordKeys?'● Recording keyframes':'STAGE'}</span></div>
        <div ref={stageWorkspace} className="stage-workspace" onPointerDown={e=>{const target=e.target as Element;if(target.closest('.stage-frame,button,input,.zoom-control'))return;if(e.button===0&&!e.altKey){const hit=hitStageElement(e);if(hit){setSelected(e.shiftKey?[...new Set([...selected,hit.id])]:[hit.id]);beginDrag(e,'move',hit.id);return;}}startPan(e,true);}} onPointerMove={e=>{if(!movePan(e)&&!(e.target as Element).closest('.stage-frame'))moveDrag(e);}} onPointerUp={()=>{endPan();endDrag();}} onPointerCancel={()=>{endPan();endDrag();}} onWheel={e=>{e.preventDefault();setZoom(v=>clamp(v-(e.deltaY>0?.1:-.1),.2,4));}} onDragOver={e=>{e.preventDefault();}} onDrop={e=>{e.preventDefault();const hit=hitStageElement(e);void importMedia(e.dataTransfer.files,hit?.id);}}>
          <div className="stage-sizer" style={{width:stageSize.width,height:stageSize.height,transform:`translate(${pan.x}px, ${pan.y}px) scale(${zoom})`}}><div ref={stageBox} className="stage-frame" onPointerDown={stageDown} onPointerMove={e=>{if(!movePan(e))moveDrag(e);}} onPointerUp={()=>{endPan();endDrag();}} onPointerCancel={()=>{endPan();endDrag();}} onContextMenu={e=>{e.preventDefault();setContext({x:e.clientX,y:e.clientY});}}>
            <Stage project={clipSession?.draft??project} time={time} onError={alert} editorOverscan={240}/><StageGuides project={project} time={time} camera={selectionCamera} selectedId={selected[0]} gridCount={gridEnabled?gridCount:0} previous={onionPrevious} next={onionNext} alignment={alignmentGuides}/><SelectionOverlay element={selectedWorld} project={project} camera={selectionCamera} pivotMode={pivotMode} rotationPoint={rotationOrigin==='world'?worldPoint:undefined} zoom={zoom} onStart={beginDrag}/>{pathEditMode&&<PathOverlay element={selectedWorld} project={project} camera={selectionCamera} zoom={zoom} activePoint={activePathPoint} onStart={startPathDrag} onMove={movePathDrag} onEnd={endPathDrag}/>} {pinEditMode&&<PinOverlay element={selectedWorld} project={project} camera={selectionCamera} zoom={zoom} onStart={startPinDrag} onMove={movePinDrag} onEnd={endPinDrag}/>} {marquee&&<svg className="stage-marquee" viewBox={[0,0,project.width,project.height].join(" ")} aria-hidden="true"><rect x={marquee.x} y={marquee.y} width={marquee.width} height={marquee.height}/></svg>}{caption&&<div className="stage-caption">{caption.text}</div>}
            {motionPathBehavior&&motionGuide&&<MotionPathOverlay behavior={motionPathBehavior} base={motionGuide.base} parent={motionGuide.parent} project={project} camera={selectionCamera} zoom={zoom} activePoint={activeMotionPoint} onStart={startMotionPathDrag} onMove={moveMotionPathDrag} onEnd={endMotionPathDrag}/>}
          </div><div className="canvas-caption"><span>{project.name}</span><span>{project.fps} FPS · {project.width} × {project.height}</span></div></div>
          <div className="stage-hint">{pickingWorldPoint?'Click the stage to set the world rotation point':pivotMode?'Drag the pivot • artwork stays in place':recordKeys?'Move the playhead, then change a property to record a keyframe':'Drag to move · Shift to constrain · Alt to bypass snapping'}</div>
          <div className="zoom-control"><Button icon={ZoomOut} label="Zoom out" onClick={()=>setZoom(v=>clamp(v-.1,.2,4))}/><button aria-label="Home stage" title="Home stage" onClick={homeStage}>⌂</button><span>{Math.round(zoom*100)}%</span><Button icon={ZoomIn} label="Zoom in" onClick={()=>setZoom(v=>clamp(v+.1,.2,4))}/></div>
        </div>
      </section>
      <aside className={`right-panel ${rightCollapsed?'collapsed':''}`}><div className="panel-heading">{!rightCollapsed&&<><Settings2 size={15}/><strong>Properties</strong></>}<Button icon={rightCollapsed?PanelRightOpen:PanelRightClose} label={rightCollapsed?'Expand properties':'Collapse properties'} onClick={()=>setRightCollapsed(!rightCollapsed)}/>{!rightCollapsed&&<Button icon={HelpCircle} label="Properties help" onClick={()=>setDialog('help')}/>}</div><div className="inspector-scroll">
        {activeScene?.sourceSceneId?<LinkedScenePanel project={project} scene={activeScene} onEdit={patch=>changeLinkedScene(activeScene.id,patch)} onEditSource={()=>seek(project.sequences.find(scene=>scene.id===activeScene.sourceSceneId)?.start??0)} onIndependent={()=>unlinkScene(activeScene.id)} onDuration={()=>editSceneDuration(activeScene.id)}/>:activeScene&&<CameraPanel project={project} sequence={activeScene} time={time} recordKeys={recordKeys} selectedKey={activeCameraKey?{property:activeCameraKey.property,id:activeCameraKey.keyId}:null} selectedKeys={timelineItems.filter((item):item is Extract<TimelineItem,{kind:'cameraKey'}>=>item.kind==='cameraKey'&&item.sequenceId===activeScene.id).map(item=>({property:item.property,id:item.keyId}))} onSelectKey={key=>setTimelineSelection(key?[{kind:'cameraKey',sequenceId:activeScene.id,property:key.property,keyId:key.id}]:[])} onCommit={next=>{stop();commit(next);}} onSeek={seek} onError={alert}/>}
        {selectedCaption&&<section className="inspector-section caption-inspector"><h3>Viewer caption</h3><textarea aria-label="Caption text" value={selectedCaption.text} onChange={event=>changeCaption(selectedCaption.id,{text:event.target.value})}/><div className="field-pair"><CaptionTimeField label="Caption start s" value={selectedCaption.start} onCommit={value=>changeCaption(selectedCaption.id,{start:value})}/><CaptionTimeField label="Caption end s" value={selectedCaption.end} onCommit={value=>changeCaption(selectedCaption.id,{end:value})}/></div><label className="select-label">Scene<select aria-label="Caption scene" value={selectedCaption.sceneId??''} onChange={event=>changeCaption(selectedCaption.id,{sceneId:event.target.value})}>{project.sequences.map(scene=><option key={scene.id} value={scene.id}>{scene.name}</option>)}</select></label><p className="muted-note">Captions appear in the player and can be hidden by viewers. Artistic text remains a separate stage object.</p><button className="text-action danger" onClick={()=>removeCaption(selectedCaption.id)}><Trash2 size={13}/>Delete caption</button></section>}
        {selected.length>1&&<section className="inspector-section arrange-section"><h3>Arrange {selected.length} objects</h3><div className="arrange-grid">{([['left','Left'],['centerX','Center X'],['right','Right'],['top','Top'],['centerY','Center Y'],['bottom','Bottom'],['distributeX','Space X'],['distributeY','Space Y']] as [Alignment,string][]).map(([mode,label])=><button key={mode} title={`${label} selected objects`} onClick={()=>align(mode)}>{label}</button>)}</div></section>}
        {selectedElement&&displayElement?<><div className="object-heading"><span className="object-kind">{selectedElement.kind}</span><input aria-label="Element name" value={selectedElement.name} onChange={e=>changeElement({name:e.target.value})}/></div>
          {selectedElement.attachment&&<div className="attachment-lock-note"><LockKeyhole size={14}/><span>{selectedElement.attachment.type==='hinge'?'Hinge':selectedElement.attachment.type==='slider'?'Slider':'Fixed'} anchor locked to parent</span><button className="text-action" onClick={()=>beginClipSession('structure',selectedElement.id)}>Edit attachment…</button></div>}
          <section className="inspector-section"><h3>Transform <button title="Keyframe position" disabled={!!selectedElement.attachment&&selectedElement.attachment.type!=='slider'} onClick={()=>{keyProperty('x');if(!selectedElement.attachment)keyProperty('y');}}><Diamond size={12}/></button></h3><div className="field-pair"><NumberField label="X" value={displayElement.x} disabled={!!selectedElement.attachment&&(selectedElement.attachment.type!=='slider'||!recordKeys)} onChange={n=>changeElement({x:n})}/><NumberField label="Y" value={displayElement.y} disabled={!!selectedElement.attachment} onChange={n=>changeElement({y:n})}/></div><div className="field-pair"><NumberField label="Width" value={selectedElement.width} min={1} onChange={n=>changeElement({width:n})}/><NumberField label="Height" value={selectedElement.height} min={1} onChange={n=>changeElement({height:n})}/></div><div className="field-with-key"><NumberField label="Rotation °" value={displayElement.rotation} disabled={!!selectedElement.attachment&&selectedElement.attachment.type!=='hinge'} onChange={changeRotation}/><Button icon={Diamond} label="Keyframe rotation" disabled={!!selectedElement.attachment&&selectedElement.attachment.type!=='hinge'} onClick={()=>keyProperty('rotation')}/></div><div className="rotation-origin"><button type="button" className={rotationOrigin==='pivot'?'active':''} aria-pressed={rotationOrigin==='pivot'} onClick={()=>{setRotationOrigin('pivot');setPickingWorldPoint(false);}}>Object pivot</button><button type="button" className={rotationOrigin==='world'?'active':''} aria-pressed={rotationOrigin==='world'} disabled={!!selectedElement.attachment} onClick={()=>{setRotationOrigin('world');setWorldPoint(selectedWorld?{x:selectedWorld.x,y:selectedWorld.y}:{x:0,y:0});setPivotMode(false);}}>World point</button></div>{rotationOrigin==='world'&&<><div className="field-pair"><NumberField label="World X" value={worldPoint.x} step={.1} onChange={x=>setWorldPoint(point=>({...point,x}))}/><NumberField label="World Y" value={worldPoint.y} step={.1} onChange={y=>setWorldPoint(point=>({...point,y}))}/></div><button type="button" className="text-action" onClick={()=>setPickingWorldPoint(true)}><Target size={13}/>Pick point on stage</button></>}<div className="field-pair"><NumberField label="Scale X" value={displayElement.scaleX} step={.1} min={.01} onChange={n=>changeElement({scaleX:n})}/><NumberField label="Scale Y" value={displayElement.scaleY} step={.1} min={.01} onChange={n=>changeElement({scaleY:n})}/></div><button className="text-action" onClick={()=>setPivotMode(!pivotMode)}><Target size={13}/>{selectedElement.attachment?'Pivot locked by attachment':'Edit pivot on stage'}</button><button className="text-action" disabled={!!parentId(selectedElement)} onClick={resetPivot}><Target size={13}/>Reset pivot to center</button></section>
          {selectedElement.kind!=='audio'&&<section className="inspector-section"><h3>Rendering</h3><label className="select-label">Optimize for<select aria-label="Render optimization" value={selectedElement.optimize??'auto'} onChange={event=>changeElement({optimize:event.target.value as StoryElement['optimize']})}><option value="auto">Auto</option><option value="motion">Motion</option><option value="static">Static</option></select></label><p className="muted-note">{(selectedElement.optimize??'auto')==='auto'?`Auto chooses ${projectRenderOptimization(project,selectedElement)} for this object.`:'This choice never changes the finished story.'}</p></section>}
          {(['rectangle','ellipse','polygon','image','video'] as ElementKind[]).includes(selectedElement.kind)&&<section className="inspector-section path-inspector"><h3>Shape path</h3>{!selectedElement.shapePath?<button className="secondary full" onClick={convertSelectedPath}>Convert to editable path</button>:<><button className="secondary full" aria-label={pathEditMode?'Finish editing path':'Edit path on stage'} onClick={()=>{setPathEditMode(!pathEditMode);setPinEditMode(false);}}>{pathEditMode?'Finish editing path':'Edit path on stage'}</button>{pathEditMode&&<><p className="muted-note">Drag points and curve handles on the stage.</p><div className="path-point-list" aria-label="Path points">{selectedElement.shapePath.points.map((point,index)=><button key={index} className={activePathPoint===index?'active':''} aria-label={`Select path point ${index+1}`} title={`Point ${index+1}: ${Math.round(point.x*100)}%, ${Math.round(point.y*100)}%`} onClick={()=>setActivePathPoint(index)}>{index+1}</button>)}</div><div className="path-point-controls"><button onClick={()=>editSelectedPath('curve')}>Curve point</button><button onClick={()=>editSelectedPath('straight')}>Straighten point</button><button onClick={()=>editSelectedPath('split')}>Add point after</button><button disabled={selectedElement.shapePath.points.length<=3} onClick={()=>editSelectedPath('remove')}>Delete point</button></div></>}</>}</section>}          {selectedElement.kind==='text'&&<section className="inspector-section"><h3>Typography</h3><textarea aria-label="Text content" value={selectedElement.text} onChange={e=>changeElement({text:e.target.value})}/><select aria-label="Font family" value={selectedElement.fontFamily} onChange={e=>changeElement({fontFamily:e.target.value})}><option>JetBrains Mono</option><option>Georgia</option><option>Arial</option><option>Verdana</option><option>Courier New</option></select><div className="field-pair"><NumberField label="Font size" value={selectedElement.fontSize??40} min={8} max={300} onChange={n=>changeElement({fontSize:n})}/><select aria-label="Text layout" value={selectedElement.textLayout??'live'} onChange={e=>changeElement({textLayout:e.target.value as 'live'|'static'})}><option value="live">Live layout</option><option value="static">Static layout</option></select></div></section>}
          {selectedElement.kind==='text'&&<section className="inspector-section text-animation-panel"><h3>Word & line animation</h3><label className="check-row"><input aria-label="Animate text" type="checkbox" checked={!!selectedElement.textAnimation} onChange={event=>event.target.checked?changeTextAnimation({}):changeElement({textAnimation:undefined})}/>Animate text</label>{selectedElement.textAnimation&&<><div className="field-pair"><label className="select-label">Effect<select aria-label="Text animation effect" value={selectedElement.textAnimation.effect} onChange={event=>changeTextAnimation({effect:event.target.value as TextAnimation['effect']})}>{(['reveal','fade','slide','scale','rotate','wave','scatter'] as const).map(effect=><option key={effect} value={effect}>{effect==='scatter'?'Scatter / assemble':effect[0].toUpperCase()+effect.slice(1)}</option>)}</select></label><label className="select-label">Apply to<select aria-label="Text animation unit" value={selectedElement.textAnimation.unit} onChange={event=>changeTextAnimation({unit:event.target.value as TextAnimation['unit']})}><option value="word">Words</option><option value="line">Lines</option></select></label></div><label className="select-label">Direction<select aria-label="Text animation direction" value={selectedElement.textAnimation.direction} onChange={event=>changeTextAnimation({direction:event.target.value as TextAnimation['direction']})}><option value="in">Animate in</option><option value="out">Animate out</option></select></label><div className="field-pair"><NumberField label="Start s" value={selectedElement.textAnimation.start} min={0} step={.1} onChange={n=>changeTextAnimation({start:n})}/><NumberField label="Duration s" value={selectedElement.textAnimation.duration} min={.01} step={.1} onChange={n=>changeTextAnimation({duration:n})}/></div><NumberField label="Stagger s" value={selectedElement.textAnimation.stagger} min={0} step={.05} onChange={n=>changeTextAnimation({stagger:n})}/><div className="field-pair"><select aria-label="Text animation easing" value={selectedElement.textAnimation.easing} onChange={event=>changeTextAnimation({easing:event.target.value as EasingFamily})}>{FAMILIES.map(family=><option key={family} value={family}>{family}</option>)}</select><select aria-label="Text animation easing direction" value={selectedElement.textAnimation.easingDirection} onChange={event=>changeTextAnimation({easingDirection:event.target.value as TextAnimation['easingDirection']})}><option value="in">Ease in</option><option value="out">Ease out</option><option value="inOut">Ease in-out</option></select></div>{['slide','rotate','scatter'].includes(selectedElement.textAnimation.effect)&&<NumberField label={selectedElement.textAnimation.effect==='rotate'?'Angle °':'Distance px'} value={selectedElement.textAnimation.distance} min={0} onChange={n=>changeTextAnimation({distance:n})}/>}{selectedElement.textAnimation.effect==='wave'&&<div className="field-pair"><NumberField label="Height px" value={selectedElement.textAnimation.amplitude} min={0} onChange={n=>changeTextAnimation({amplitude:n})}/><NumberField label="Frequency" value={selectedElement.textAnimation.frequency} min={.01} step={.1} onChange={n=>changeTextAnimation({frequency:n})}/></div>}{selectedElement.textAnimation.effect==='scatter'&&<NumberField label="Variation seed" value={selectedElement.textAnimation.seed} step={1} onChange={n=>changeTextAnimation({seed:Math.round(n)})}/>}</>}</section>}          {selectedVisualAsset&&selectedElement.kind!=='text'&&<section className="inspector-section media-pin-panel"><h3>Media corner pin</h3>{!selectedElement.mediaPin?<button className="secondary full" onClick={enableSelectedPin}>Enable four-corner pin</button>:<><button className="secondary full" aria-label={pinEditMode?'Finish editing corners':'Edit media corners on stage'} onClick={()=>{setPinEditMode(!pinEditMode);setPathEditMode(false);}}>{pinEditMode?'Finish editing corners':'Edit corners on stage'}</button>{pinEditMode&&<p className="muted-note">Drag the four yellow corners to change perspective. The shape path, if present, clips the image.</p>}<button className="text-action" onClick={()=>{changeElement({mediaPin:undefined});setPinEditMode(false);}}>Remove corner pin</button></>}</section>}          {selectedElement.kind!=='audio'&&<section className="inspector-section"><h3>Appearance</h3><label className="color-field"><span>Fill</span><input aria-label="Fill color" type="color" value={displayElement.fill} onChange={e=>changeFillColor(e.target.value)}/><code>{displayElement.fill.toUpperCase()}</code><Button icon={Diamond} label="Keyframe fill" onClick={()=>keyProperty('fill')}/></label><label className="color-field"><span>Outline</span><input aria-label="Outline color" type="color" value={selectedElement.stroke} onChange={e=>changeElement({stroke:e.target.value})}/><NumberField label="px" value={selectedElement.strokeWidth} min={0} max={40} onChange={n=>changeElement({strokeWidth:n})}/></label><div className="field-with-key"><NumberField label="Opacity %" value={displayElement.opacity*100} min={0} max={100} onChange={n=>changeElement({opacity:n/100})}/><Button icon={Diamond} label="Keyframe opacity" onClick={()=>keyProperty('opacity')}/></div><label className="check-row"><input type="checkbox" checked={selectedElement.shadow.enabled} onChange={e=>changeElement({shadow:{...selectedElement.shadow,enabled:e.target.checked}})}/>Drop shadow</label>{selectedElement.shadow.enabled&&<><div className="field-pair"><NumberField label="Offset X" value={selectedElement.shadow.x} onChange={n=>changeElement({shadow:{...selectedElement.shadow,x:n}})}/><NumberField label="Offset Y" value={selectedElement.shadow.y} onChange={n=>changeElement({shadow:{...selectedElement.shadow,y:n}})}/></div><NumberField label="Blur" value={selectedElement.shadow.blur} min={0} max={60} onChange={n=>changeElement({shadow:{...selectedElement.shadow,blur:n}})}/></>}
          {(selectedElement.assetId||project.assets.some(a=>a.kind==='image'||a.kind==='video'))&&<><div className="field-with-key"><label className="select-label">Texture<select aria-label="Texture asset" value={displayElement.assetId??''} onChange={e=>changeElement({assetId:e.target.value||undefined})}><option value="">Solid color</option>{project.assets.filter(a=>a.kind==='image'||a.kind==='video').map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><Button icon={Diamond} label="Keyframe texture" onClick={()=>keyProperty('assetId')}/></div><select aria-label="Media fitting" value={selectedElement.mediaFit} onChange={e=>changeElement({mediaFit:e.target.value as any})}><option value="fill">Fill boundary</option><option value="fit">Fit inside</option><option value="stretch">Stretch</option></select><NumberField label="Media opacity %" value={(selectedElement.mediaOpacity??1)*100} min={0} max={100} onChange={n=>changeElement({mediaOpacity:n/100})}/></>}</section>}
          <section className="inspector-section"><h3>Timing</h3><div className="field-pair"><NumberField label="Start s" value={selectedElement.start} min={0} onChange={n=>changeTimelineTiming('start',n)}/><NumberField label="Duration s" value={selectedElement.duration} min={1/project.fps} step={.1} onChange={n=>changeTimelineTiming('duration',n)}/></div>{(selectedAudioAsset||['video','audio'].includes(selectedElement.kind))&&<><NumberField label="Speed ×" value={selectedElement.speed??1} min={.25} max={4} step={.05} onChange={n=>{if(!selectedAudioAsset){changeElement({speed:n});return;}stop();try{commit(setMediaSpeed(projectRef.current,selectedElement.id,n));}catch(error){alert(error instanceof Error?error.message:String(error));}}}/>{!selectedAudioAsset&&<><NumberField label="Volume %" value={(selectedElement.volume??1)*100} min={0} max={200} onChange={n=>changeElement({volume:n/100})}/><label className="check-row"><input type="checkbox" checked={selectedElement.muted??false} onChange={e=>changeElement({muted:e.target.checked})}/>Mute audio</label></>}<p className="muted-note">{selectedElement.linkSpeedPitch===false?'Speed preserves audio pitch.':'Speed changes audio pitch.'}</p></>}</section>
          {(selectedElement.kind==='video'||selectedVisualAsset?.kind==='video')&&<section className="inspector-section"><h3>Video end</h3><label className="select-label">After source ends<select aria-label="Video end behavior" value={selectedElement.videoEndBehavior??'hold'} onChange={event=>changeElement({videoEndBehavior:event.target.value as 'hold'|'hide'})}><option value="hold">Hold last frame</option><option value="hide">Hide video</option></select></label></section>}
          {selectedAudioAsset&&<section className="inspector-section audio-preview-section"><h3>Audio preview</h3><button className="secondary full" aria-label={previewingAudioId===selectedElement.id?'Stop audio preview':'Preview audio object'} onClick={()=>previewingAudioId===selectedElement.id?stopPreview():void previewAudio()}>{previewingAudioId===selectedElement.id?<><Square size={13}/>Stop preview</>:<><Play size={13}/>Preview this object</>}</button><p className="muted-note">Listen to this object alone. Project playback resumes afterward.</p></section>}
          {selectedAudioAsset&&<section className="inspector-section"><h3>{selectedAudioAsset.kind==='video'?'Video sound':'Audio clip'}</h3><button className="secondary full" onClick={()=>beginClipSession('media',selectedElement.id)}>Edit clip…</button><p className="muted-note">Changes are kept in a recoverable draft until you apply them.</p></section>}
          {selectedAudioAsset&&<AudioEffectsPanel effects={selectedElement.audioEffects??[]} onChange={audioEffects=>changeElement({audioEffects})}/>}
          {selectedElement.kind==='text'&&<><ProjectFontsPanel project={project} selectedFamily={selectedElement.fontFamily} onImport={()=>fontInput.current?.click()} onUse={fontFamily=>changeElement({fontFamily})} onNotice={(assetId,licenseNotice)=>edit(next=>{const asset=next.assets.find(item=>item.id===assetId);if(asset)asset.licenseNotice=licenseNotice;})}/><GoogleFontsPanel projectFonts={project.assets.filter(asset=>asset.kind==='font')} onImport={importCuratedFont}/><TextFlowPanel project={project} element={selectedElement} onChange={changeElement} onRefresh={refreshStaticTextShape}/>{selectedElement.textLayout!=='static'&&<TextReflowPanel value={selectedElement.textReflow} onChange={textReflow=>changeElement({textReflow})} playheadStart={Math.max(0,time-selectedElement.start)}/>}</>}
          {selectedElement.kind==='group'&&!!selectedElement.clipInstances?.length&&<section className="inspector-section"><h3>Assembly animation</h3><button className="secondary full" onClick={()=>beginClipSession('assembly',selectedElement.id)}>Edit assembly animation…</button><p className="muted-note">Edit keys, clip transitions, and overlap in one Apply/Cancel session.</p></section>}
          {selectedVisualAsset&&<MediaTransformPanel value={selectedElement.mediaTransform} onChange={mediaTransform=>changeElement({mediaTransform})}/>}
          {selectedElement.kind!=='audio'&&<MotionBehaviorsPanel element={selectedElement} fps={project.fps} editingPathId={editingMotionId} onEditPath={id=>{setEditingMotionId(id);setActiveMotionPoint(0);setPathEditMode(false);setPinEditMode(false);}} onChange={motionBehaviors=>changeElement({motionBehaviors})}/>}
          {selectedElement.kind==='group'&&<section className="inspector-section assembly-clips-panel"><h3>Assembly clips</h3><p className="muted-note">Save this assembly’s pose and keyframes from the playhead, then place reusable clips on the timeline.</p><label className="select-label">Clip name<input aria-label="Assembly clip name" value={clipCaptureName} onChange={event=>setClipCaptureName(event.target.value)}/></label><label className="number-field"><span>Length s</span><input aria-label="Assembly clip length in seconds" type="number" min={1/project.fps} step="any" value={clipCaptureLength} onChange={event=>setClipCaptureLength(event.target.value)}/></label><button className="secondary full" onClick={()=>saveAssemblyClip(selectedElement.id)}><Plus size={13}/>Save animation clip</button>{(selectedElement.assemblyClips??[]).map(clip=><div className="assembly-clip-entry" key={clip.id}><span><strong>{clip.name}</strong><small>{clip.duration.toFixed(2)} s · {clip.tracks.length} animated properties</small></span><button className="secondary" aria-label={`Place ${clip.name} clip`} onClick={()=>insertAssemblyClip(selectedElement.id,clip.id)}><Plus size={12}/>Place</button></div>)}{(selectedElement.clipInstances??[]).length>0&&<div className="assembly-clip-instances"><strong>Placed clips</strong>{selectedElement.clipInstances!.map(instance=><div className="assembly-clip-entry" key={instance.id}><span><strong>{selectedElement.assemblyClips?.find(clip=>clip.id===instance.clipId)?.name??'Animation clip'}</strong><small>{(selectedElement.start+instance.start).toFixed(2)}–{(selectedElement.start+instance.start+instance.duration).toFixed(2)} s</small></span><label className="check-row assembly-loop"><input type="checkbox" aria-label="Loop placed clip" checked={!!instance.loop} onChange={event=>updateAssemblyClipInstance(selectedElement.id,instance.id,{loop:event.target.checked})}/>Loop</label><Button icon={Trash2} label="Remove placed clip" onClick={()=>deleteAssemblyClipInstance(selectedElement.id,instance.id)}/></div>)}</div>}</section>}
          <section className="inspector-section"><h3>Assembly & organization</h3><button className="secondary full" onClick={()=>beginClipSession('structure',selectedElement.id)}>Edit parent & attachment…</button><label className="select-label">Timeline section<input aria-label="Timeline section" placeholder="Optional section name" value={selectedElement.section??''} onChange={e=>changeElement({section:e.target.value})}/></label><button className="secondary full" onClick={()=>void exportAssembly()}><Download size={13}/>Export .hyproj</button></section>
        </>:!selectedCaption&&<div className="unselected"><div className="unselected-symbol"><MousePointer2 size={22}/></div><h3>No selection</h3><p>Select an element on the stage or in the contents list to edit its properties.</p><button className="text-action" onClick={()=>setDialog('help')}>Quick guide <ChevronRight size={13}/></button><div className="project-summary"><span>PROJECT</span><strong>{project.name}</strong><p>{project.width} × {project.height} · {project.fps} fps</p><button className="secondary full" onClick={()=>setDialog('settings')}>Project settings</button></div></div>}
        {activeKey&&<section className="inspector-section key-inspector"><h3>Selected keyframe</h3><NumberField label="Key time s" value={activeKey.time} min={0} step={1/project.fps} onChange={n=>updateKey({time:n})}/><select aria-label="Keyframe interpolation" value={activeKey.mode} onChange={e=>updateKey({mode:e.target.value})}><option value="smooth">Smooth</option><option value="hold">Held</option><option value="stepped">Stepped</option></select><div className="field-pair"><select aria-label="Easing family" value={activeKey.easing} onChange={e=>updateKey({easing:e.target.value})}>{FAMILIES.map(v=><option key={v}>{v}</option>)}</select><select aria-label="Easing direction" value={activeKey.direction} onChange={e=>updateKey({direction:e.target.value})}><option value="in">In</option><option value="out">Out</option><option value="inOut">In-out</option></select></div><button className="text-action danger" onClick={deleteSelectedKeyframe}>Delete keyframe</button></section>}{activeKey&&keySelection?.property==='assetId'&&<TextureKeyPanel project={project} keyframe={activeKey} hasNext={activeKeyHasNext} onEdit={updateKey}/>}
      </div></aside>
    </div>
    {!timelineCollapsed&&<div className="timeline-resize-handle" role="separator" aria-label="Resize timeline" aria-orientation="horizontal" style={{bottom:timelineHeight+23}} onPointerDown={beginTimelineResize} onPointerMove={moveTimelineResize} onPointerUp={endTimelineResize} onPointerCancel={endTimelineResize}/>}
    <section className={`timeline ${timelineCollapsed?'collapsed':''}`}>
      <div className="timeline-toolbar">
        <div className="timeline-title"><Layers size={15}/><strong>Timeline</strong><span>{project.sequences.length} {project.sequences.length===1?'scene':'scenes'}</span><Button icon={timelineCollapsed?PanelBottomOpen:PanelBottomClose} label={timelineCollapsed?'Expand timeline':'Collapse timeline'} onClick={()=>setTimelineCollapsed(!timelineCollapsed)}/></div>
        <div className="transport"><Button icon={SkipBack} label="Back to start" onClick={()=>seek(0)}/><button className="play-button" aria-label={playing?'Pause':'Play'} onClick={()=>void togglePlay()} disabled={preparing}>{playing?<Pause size={16}/>:<Play size={16} fill="currentColor"/>}</button>{previewingAudioId&&<Button icon={Square} label="Stop audio preview" onClick={stopPreview}/>}<span className="timecode">{String(Math.floor(time/60)).padStart(2,'0')}:{String(Math.floor(time%60)).padStart(2,'0')}<em>.{String(Math.floor(time%1*project.fps)).padStart(2,'0')}</em></span><span className="time-total">/ {project.duration.toFixed(1)}s</span>{tailPlaying&&<span className="audio-tail-status">Audio tail</span>}</div>
        <div className="timeline-actions">
          {autoKeySuggested&&<span className="auto-key-hint">Animated transform: turn on Auto key to edit this pose.</span>}
          <button className={`record-keys ${recordKeys?'on':''} ${autoKeySuggested?'suggested':''}`} title={autoKeySuggested?'This object has animated position or rotation. Turn on Auto key to edit its current pose.':'Record changed properties as keyframes'} aria-label="Auto key" aria-pressed={recordKeys} onClick={()=>setRecordKeys(!recordKeys)}><span/>Auto key</button>
          <Button icon={Mic} label={recording?'Stop microphone recording':'Record microphone with scene playback'} active={recording} onClick={()=>void record()}/>
          <label className="record-mute-option" title="Mute existing audio and video sound only while recording"><input aria-label="Mute existing audio while recording" type="checkbox" checked={muteWhileRecording} disabled={recording} onChange={event=>setMuteWhileRecording(event.target.checked)}/>Mute while recording</label>
          <label className="record-mute-option" title="Hear the microphone through your speakers or headphones while recording"><input aria-label="Monitor microphone while recording" type="checkbox" checked={monitorWhileRecording} disabled={recording} onChange={event=>setMonitorWhileRecording(event.target.checked)}/>Monitor mic</label>
          <button className={`tool-text ${ripple?'active':''}`} title="Ripple moves later clips and scene boundaries when you move or trim a clip" aria-pressed={ripple} onClick={()=>setRipple(!ripple)}>{ripple?'Ripple':'Normal'}</button>
          <Button icon={showAll?Eye:EyeOff} label={showAll?'Showing all timeline rows':'Showing active timeline rows'} active={!showAll} onClick={()=>setShowAll(!showAll)}/>
          <Button icon={ZoomOut} label="Zoom timeline out" onClick={()=>zoomTimeline(.8)}/><Button icon={ZoomIn} label="Zoom timeline in" onClick={()=>zoomTimeline(1.25)}/>
        </div>
      </div>
      {sections.length>0&&<div className="section-strip"><span>SECTIONS</span>{sections.map(s=><button key={s} className={hiddenSections.includes(s)?'hidden-section':''} onClick={()=>setHiddenSections(v=>v.includes(s)?v.filter(x=>x!==s):[...v,s])}>{hiddenSections.includes(s)?<EyeOff size={11}/>:<Eye size={11}/>} {s}</button>)}{hiddenSections.length>0&&<span>{hiddenSections.length} hidden · output unchanged</span>}</div>}
      <div className="timeline-scroll" ref={timelineBody} onWheel={timelineWheel}>
        <div className="timeline-content" style={{minWidth:`${timelineScale*100}%`}}>
          <div className="ruler-row"><div className="timeline-label"><span>LAYERS / PROPERTIES</span></div><div className="ruler" ref={rulerBody} aria-label="Timeline ruler" title="Drag to seek · scroll to pan · Ctrl/Command-scroll to zoom" onPointerDown={startPlayheadDrag} onPointerMove={movePlayheadDrag} onPointerUp={endPlayheadDrag} onPointerCancel={endPlayheadDrag} onContextMenu={ev=>{ev.preventDefault();setTimelineContext({x:ev.clientX,y:ev.clientY,kind:'ruler',at:timelineTimeAt(ev,ev.currentTarget)});}}>{ticks.map(tick=><span key={tick.time} style={{left:`${tick.time/project.duration*100}%`}}>{tick.label}</span>)}<div className="ruler-playhead" style={{left:`${time/project.duration*100}%`}}/></div></div>
          <div className="sequence-row"><div className="timeline-label"><span>SCENES</span><button className="timeline-add-scene" aria-label="Add scene" title="Add a scene after the current story" onClick={addScene}><Plus size={13}/></button></div><div className="timeline-lane sequence-lane" onPointerDown={startPlayheadDrag} onPointerMove={movePlayheadDrag} onPointerUp={endPlayheadDrag} onPointerCancel={endPlayheadDrag} onContextMenu={ev=>{ev.preventDefault();setTimelineContext({x:ev.clientX,y:ev.clientY,kind:'ruler',at:timelineTimeAt(ev,ev.currentTarget)});}}>{project.sequences.map(scene=><div key={scene.id} className={`sequence-block ${scene.sourceSceneId?'linked':''}`} style={{left:`${scene.start/project.duration*100}%`,width:`${scene.duration/project.duration*100}%`}} onPointerDown={ev=>ev.stopPropagation()} onClick={ev=>{if(sceneRename?.id!==scene.id)seek(timelineTimeAt(ev,ev.currentTarget.parentElement!),true);}} onDoubleClick={ev=>{ev.preventDefault();ev.stopPropagation();renameScene(scene.id);}} onContextMenu={ev=>{ev.preventDefault();ev.stopPropagation();setTimelineContext({x:ev.clientX,y:ev.clientY,kind:'scene',scene:scene.id});}} title={scene.sourceSceneId?'Linked scene · right-click for source actions':'Double-click to rename'}>{sceneRename?.id===scene.id?<input className="sequence-name-input" autoFocus aria-label="Scene name" value={sceneRename.value} onChange={ev=>setSceneRename({id:scene.id,value:ev.target.value})} onFocus={ev=>ev.currentTarget.select()} onPointerDown={ev=>ev.stopPropagation()} onClick={ev=>ev.stopPropagation()} onDoubleClick={ev=>ev.stopPropagation()} onKeyDown={ev=>{if(ev.key==='Enter'){ev.preventDefault();commitSceneRename(scene.id,ev.currentTarget.value);}else if(ev.key==='Escape'){ev.preventDefault();cancelledSceneRename.current=scene.id;setSceneRename(null);}}} onBlur={ev=>{if(cancelledSceneRename.current===scene.id){cancelledSceneRename.current=null;return;}commitSceneRename(scene.id,ev.currentTarget.value);}}/>:<span className="sequence-name">{scene.sourceSceneId&&<Link2 size={11}/>} {scene.name}</span>}<span>{scene.duration.toFixed(1)} s</span></div>)}<div className="playhead-line" style={{left:`${time/project.duration*100}%`}}/></div></div>
          <div className="camera-row"><div className="timeline-label"><Camera size={12}/><span>CAMERAS</span></div><div className="timeline-lane" onPointerDown={startTimelineMarquee} onPointerMove={moveTimelineMarquee} onPointerUp={endTimelineMarquee} onPointerCancel={endTimelineMarquee}>{project.sequences.flatMap(scene=>(scene.camera?.tracks??[]).flatMap(track=>track.keyframes.map(key=><button key={key.id} data-camera-key-id={key.id} data-sequence-id={scene.id} data-property={track.property} className={`key-dot camera-key-dot ${timelineItems.some(item=>item.kind==='cameraKey'&&item.keyId===key.id)?'selected':''}`} aria-label={`Camera ${track.property} keyframe at ${scene.start+key.time} seconds`} title={`${scene.name} · Camera ${track.property}: ${key.value} at ${key.time}s`} style={{left:`${(scene.start+key.time)/project.duration*100}%`}} onPointerDown={ev=>startCameraKeyDrag(ev,scene.id,track.property,key.id,key.time)} onPointerMove={moveCameraKeyDrag} onPointerUp={endCameraKeyDrag} onPointerCancel={endCameraKeyDrag} onContextMenu={ev=>{ev.preventDefault();ev.stopPropagation();const item:TimelineItem={kind:'cameraKey',sequenceId:scene.id,property:track.property,keyId:key.id};if(!timelineItems.some(current=>timelineItemId(current)===timelineItemId(item)))setTimelineSelection([item],item);setTimelineContext({x:ev.clientX,y:ev.clientY,kind:'cameraKey',scene:scene.id,property:track.property,key:key.id});}}/>)))}<div className="playhead-line" style={{left:`${time/project.duration*100}%`}}/></div></div>
          <div className="caption-row"><div className="timeline-label"><Type size={12}/><span>CAPTIONS</span><button className="timeline-add-scene" aria-label="Add caption" title="Add viewer caption at playhead" onClick={insertCaption}><Plus size={13}/></button></div><div className="timeline-lane">{project.captions.map(item=><button key={item.id} className={`caption-block ${selectedCaptionId===item.id?'selected':''}`} style={{left:`${item.start/project.duration*100}%`,width:`${(item.end-item.start)/project.duration*100}%`}} aria-label={`Caption: ${item.text}`} title={`${item.start.toFixed(2)}–${item.end.toFixed(2)} s · ${item.text}`} onClick={()=>{setSelected([]);setTimelineItems([]);setKeySelection(null);setSelectedCaptionId(item.id);seek(item.start);}}>{item.text}</button>)}<div className="playhead-line" style={{left:`${time/project.duration*100}%`}}/></div></div>
          {rows.map(e=>{const Icon=ICONS[e.kind];return <div key={e.id}>
            <div className={`timeline-row ${selected.includes(e.id)?'selected':''}`}><div className="timeline-label" onClick={ev=>selectTimelineItem({kind:'clip',elementId:e.id},ev)}><button className="expand" aria-label={`Expand ${e.name} tracks`} onClick={ev=>{ev.stopPropagation();setExpanded(v=>v.includes(e.id)?v.filter(x=>x!==e.id):[...v,e.id]);}}>{expanded.includes(e.id)?<ChevronDown size={12}/>:<ChevronRight size={12}/>}</button><Icon size={13}/><span>{e.name}</span>{e.tracks.length>0&&<Diamond size={10}/>}</div>
              <div className="timeline-lane" onPointerDown={startTimelineMarquee} onPointerMove={moveTimelineMarquee} onPointerUp={endTimelineMarquee} onPointerCancel={endTimelineMarquee} onContextMenu={ev=>{ev.preventDefault();setTimelineContext({x:ev.clientX,y:ev.clientY,kind:'clip',element:e.id,at:timelineTimeAt(ev,ev.currentTarget)});}}>{effectTails.filter(tail=>tail.elementId===e.id).map((tail,index)=><div key={`tail-${index}`} className="effect-tail" role="img" aria-label={`Audio effect tail for ${e.name}: ${tail.start.toFixed(2)} to ${tail.end.toFixed(2)} seconds`} style={{left:`${tail.start/project.duration*100}%`,width:`${(tail.end-tail.start)/project.duration*100}%`}}/>)}<div data-element-id={e.id} className={`clip-block ${e.kind==='audio'?'audio-clip':e.kind==='video'?'video-clip':''} ${timelineItems.some(item=>item.kind==='clip'&&item.elementId===e.id)?'timeline-item-selected':''}`} style={{left:`${e.start/project.duration*100}%`,width:`${e.duration/project.duration*100}%`}} onPointerDown={ev=>startTimelineDrag(ev,e,'move')} onPointerMove={moveTimelineDrag} onPointerUp={endTimelineDrag} onPointerCancel={endTimelineDrag} onContextMenu={ev=>{ev.preventDefault();ev.stopPropagation();if(!timelineItems.some(item=>item.kind==='clip'&&item.elementId===e.id))setTimelineSelection([{kind:'clip',elementId:e.id}]);setTimelineContext({x:ev.clientX,y:ev.clientY,kind:'clip',element:e.id,at:time});}}><span>{e.name}</span>{e.tracks.flatMap(t=>t.keyframes).map(k=><i className="clip-key" key={k.id} style={{left:`${k.time/e.duration*100}%`}}/>)}<div className="trim-handle" title="Trim clip end" onPointerDown={ev=>startTimelineDrag(ev,e,'trim')}/></div><div className="playhead-line" style={{left:`${time/project.duration*100}%`}}/></div>
            </div>
            {expanded.includes(e.id)&&e.tracks.map(track=>{const PropertyIcon=PROPERTY_ICONS[track.property];return <div className={`property-row property-${track.property}`} key={track.property}><div className="timeline-label"><PropertyIcon size={11}/><span>{PROPERTY_LABELS[track.property]}</span><button aria-label={`Add ${track.property} keyframe`} title={`Add ${track.property} keyframe at playhead`} onClick={()=>addKeyAt(e.id,track.property,time)}><Plus size={12}/></button></div><div className="timeline-lane" onPointerDown={startTimelineMarquee} onPointerMove={moveTimelineMarquee} onPointerUp={endTimelineMarquee} onPointerCancel={endTimelineMarquee} onContextMenu={ev=>{ev.preventDefault();setTimelineContext({x:ev.clientX,y:ev.clientY,kind:'property',element:e.id,property:track.property,at:timelineTimeAt(ev,ev.currentTarget)});}}>{track.keyframes.map(k=><button key={k.id} data-element-id={e.id} data-property={track.property} data-key-id={k.id} className={`key-dot ${timelineItems.some(item=>item.kind==='key'&&item.keyId===k.id)?'selected':''}`} aria-label={`${track.property} keyframe at ${k.time} seconds`} title={`${PROPERTY_LABELS[track.property]}: ${k.value} at ${k.time}s · drag to retime`} style={{left:`${(e.start+k.time)/project.duration*100}%`}} onPointerDown={ev=>startKeyDrag(ev,e,track.property,k.id,k.time)} onPointerMove={moveKeyDrag} onPointerUp={endKeyDrag} onPointerCancel={endKeyDrag} onContextMenu={ev=>{ev.preventDefault();ev.stopPropagation();const item:TimelineItem={kind:'key',elementId:e.id,property:track.property,keyId:k.id};if(!timelineItems.some(current=>timelineItemId(current)===timelineItemId(item)))setTimelineSelection([item],item);setTimelineContext({x:ev.clientX,y:ev.clientY,kind:'key',element:e.id,property:track.property,key:k.id});}}/>)}<div className="playhead-line" style={{left:`${time/project.duration*100}%`}}/></div></div>;})}
            {e.kind==='group'&&!!e.clipInstances?.length&&(showAll||e.clipInstances.some(instance=>e.start+instance.start<=visibleTimelineRange[1]&&e.start+instance.start+instance.duration>=visibleTimelineRange[0]))&&<div className="assembly-clips-row"><div className="timeline-label"><Layers size={11}/><span>ASSEMBLY CLIPS</span></div><div className="timeline-lane"><AssemblyGapBands groups={assemblyGapGroups.filter(group=>group.rootId===e.id)} duration={project.duration} focusedIncomingId={focusedAssemblyGap} onSelect={group=>{setSelected([group.rootId]);setFocusedAssemblyGap(group.toInstanceId);seek(group.start);}}/>{e.clipInstances.map(instance=>{const clip=e.assemblyClips?.find(item=>item.id===instance.clipId);return <div key={instance.id} role="button" tabIndex={0} className="assembly-instance-block" aria-label={`Placed assembly clip ${clip?.name??'Animation clip'}`} title={`${clip?.name??'Animation clip'} · drag to move; drag right edge to retime`} style={{left:`${(e.start+instance.start)/project.duration*100}%`,width:`${instance.duration/project.duration*100}%`}} onPointerDown={event=>startAssemblyClipDrag(event,e,instance,'move')} onPointerMove={moveAssemblyClipDrag} onPointerUp={endAssemblyClipDrag} onPointerCancel={endAssemblyClipDrag} onClick={()=>{if(assemblyClipClickSuppressed.current){assemblyClipClickSuppressed.current=false;return;}setSelected([e.id]);setFocusedAssemblyInstance(instance.id);seek(e.start+instance.start);}} onKeyDown={event=>{if(event.key==='Enter'){setSelected([e.id]);setFocusedAssemblyInstance(instance.id);seek(e.start+instance.start);}}}>{clip?.name??'Animation clip'}<span className="assembly-clip-trim" title="Drag to retime clip" onPointerDown={event=>startAssemblyClipDrag(event,e,instance,'trim')} onPointerMove={moveAssemblyClipDrag} onPointerUp={endAssemblyClipDrag} onPointerCancel={endAssemblyClipDrag}/></div>;})}<div className="playhead-line" style={{left:`${time/project.duration*100}%`}}/></div></div>}
            {e.kind==='group'&&!!e.clipInstances?.length&&<AssemblyMasterRows project={project} rootId={e.id} onSelectKey={key=>{if(assemblyMasterClickSuppressed.current){assemblyMasterClickSuppressed.current=false;return;}setSelected([e.id]);setFocusedAssemblyInstance(key.instanceId);setFocusedAssemblyTrack({rootId:e.id,elementId:key.elementId,property:key.property,scope:key.scope,keyIndex:key.keyIndex});seek(key.time);}} onKeyPointerDown={(event,key)=>startAssemblyMasterKeyDrag(event,e.id,key)} onKeyPointerMove={moveAssemblyMasterKeyDrag} onKeyPointerUp={endAssemblyMasterKeyDrag}/>}
          </div>;})}
          {!rows.length&&<div className="timeline-empty">Add an element to start building your timeline.</div>}
        </div>
      </div>
      {timelineMarquee&&<div className="timeline-marquee" style={timelineMarquee} aria-hidden="true"/>}
      {timelineContext&&<div className="context-menu timeline-context-menu" style={{left:Math.min(timelineContext.x,window.innerWidth-230),top:Math.min(timelineContext.y,window.innerHeight-(timelineContext.kind==='scene'?315:220))}} onPointerDown={ev=>ev.stopPropagation()}>
        {(timelineContext.kind==='ruler'||timelineContext.kind==='scene')&&<><button onClick={()=>{addScene();setTimelineContext(null);}}><Plus size={14}/>Add scene at end</button>{timelineContext.kind==='scene'&&<><button onClick={()=>renameScene(timelineContext.scene!)}><Type size={14}/>Rename scene</button><button onClick={()=>editSceneDuration(timelineContext.scene!)}><Settings2 size={14}/>Set scene duration…</button><button onClick={()=>changeScene('duplicate',timelineContext.scene!)}><Copy size={14}/>Duplicate scene</button><button onClick={()=>linkScene(timelineContext.scene!)}><Link2 size={14}/>Place linked copy</button>{project.sequences.find(scene=>scene.id===timelineContext.scene)?.sourceSceneId&&<><button onClick={()=>{const linked=project.sequences.find(scene=>scene.id===timelineContext.scene)!;seek(project.sequences.find(scene=>scene.id===linked.sourceSceneId)?.start??0);setTimelineContext(null);}}><Link2 size={14}/>Go to source scene</button><button onClick={()=>unlinkScene(timelineContext.scene!)}><Copy size={14}/>Make independent copy</button></>}<button disabled={project.sequences.findIndex(scene=>scene.id===timelineContext.scene)===0} onClick={()=>changeScene('earlier',timelineContext.scene!)}><ArrowUp size={14}/>Move scene earlier</button><button disabled={project.sequences.findIndex(scene=>scene.id===timelineContext.scene)===project.sequences.length-1} onClick={()=>changeScene('later',timelineContext.scene!)}><ArrowDown size={14}/>Move scene later</button><hr/><button className="danger" disabled={project.sequences.length<2} onClick={()=>changeScene('delete',timelineContext.scene!)}><Trash2 size={14}/>Delete scene</button></>}{timelineContext.kind==='ruler'&&<button onClick={()=>{seek(timelineContext.at??time,true);setTimelineContext(null);}}><Target size={14}/>Move playhead here</button>}</>}
        {timelineContext.kind==='property'&&<button onClick={()=>addKeyAt(timelineContext.element!,timelineContext.property as AnimProperty,timelineContext.at??time)}><Diamond size={14}/>Add keyframe here</button>}
        {timelineContext.kind==='key'&&<><button onClick={duplicateSelectedKeyframe}><Copy size={14}/>Duplicate keyframe</button><button className="danger" onClick={deleteSelectedKeyframe}><Trash2 size={14}/>Delete keyframe</button></>}
        {timelineContext.kind==='cameraKey'&&<button className="danger" onClick={deleteTimelineSelection}><Trash2 size={14}/>Delete camera keyframe{timelineItems.length>1?'s':''}</button>}
        {timelineContext.kind==='clip'&&<><button onClick={()=>{addKeyAt(timelineContext.element!,'x',timelineContext.at??time);addKeyAt(timelineContext.element!,'y',timelineContext.at??time);}}><Diamond size={14}/>Add position keyframes</button><button onClick={()=>{setSelected([timelineContext.element!]);duplicate();setTimelineContext(null);}}><Copy size={14}/>Duplicate object</button><button className="danger" onClick={()=>{setSelected([timelineContext.element!]);edit(p=>{const ids=descendantIds(p,[timelineContext.element!]);p.elements=p.elements.filter(item=>!ids.has(item.id));for(const element of p.elements)if(element.flowAroundId&&ids.has(element.flowAroundId))delete element.flowAroundId;});setSelected([]);setTimelineContext(null);}}><Trash2 size={14}/>Delete object</button></>}
      </div>}
    </section>
    <footer className="statusbar"><span><i className={saveStatus.includes('failed')?'error-dot':'status-dot'}/>{saveStatus}</span><span>{fileStatus}</span><div className="flex-spacer"/>{staleClipDraft&&<button onClick={()=>setShowStaleDraft(true)}>Unfinished clip draft needs review</button>}<button onClick={()=>setDialog('help')}><HelpCircle size={12}/>Guide & shortcuts</button><span>Hyde</span></footer>
    {(notice||busy)&&<div className={`toast ${busy?'busy':''}`} role="status"><span>{busy||notice}</span>{!busy&&<button onClick={()=>setNotice('')} aria-label="Dismiss notification"><X size={14}/></button>}</div>}
    {context&&<div className="context-menu" style={{left:Math.min(context.x,window.innerWidth-220),top:Math.min(context.y,window.innerHeight-210)}} onPointerDown={e=>e.stopPropagation()}><button onClick={duplicate} disabled={!selected.length}><Copy size={14}/>Duplicate</button><button onClick={()=>{copySelection();setContext(null);}} disabled={!selected.length}><Copy size={14}/>Copy selection</button><button onClick={()=>{pasteSelection();setContext(null);}} disabled={!objectClipboard.current}><Copy size={14}/>Paste at playhead</button><button onClick={()=>{groupSelection();setContext(null);}} disabled={!selected.length}><Layers size={14}/>Create assembly</button><button onClick={()=>{void exportAssembly();setContext(null);}} disabled={!selected.length}><Download size={14}/>Export assembly</button><button onClick={()=>{setPivotMode(true);setContext(null);}}><Target size={14}/>Edit pivot</button><hr/><button className="danger" onClick={removeSelected}><Trash2 size={14}/>{keySelection?'Delete keyframe':'Delete selection'}</button></div>}
    {splash&&<div className="modal-backdrop"><div className="welcome"><div className="welcome-content"><div className="welcome-top"><span className="brand-mark">h<span>•</span></span><Button icon={X} label="Close welcome" onClick={()=>setSplash(false)}/></div><h1>Hyde Story Studio</h1><p>Create a project or open an existing one.</p><button className="welcome-action" onClick={()=>{replaceProject(createProject());setDialog('settings');}}><FilePlus2/><span><strong>New project</strong><small>Choose a size and start editing.</small></span><ChevronRight size={16}/></button><button className="welcome-action" onClick={()=>void chooseOpenProject()}><FolderOpen/><span><strong>Open a project</strong><small>.hyde and .hy files</small></span><ChevronRight size={16}/></button><button className="welcome-action" onClick={()=>replaceProject(createPrimaryShowcase())}><Sparkles/><span><strong>Explore the lantern keeper</strong><small>Scenes, articulated art, animated text, and sound.</small></span><ChevronRight size={16}/></button>{recent&&<button className="welcome-action" onClick={()=>replaceProject(recent)}><RotateCcw/><span><strong>Resume {recent.name}</strong><small>Recovered from this browser</small></span><ChevronRight size={16}/></button>}{recentProjects.length>1&&<details className="recent-list"><summary>More recent projects ({recentProjects.length-1})</summary>{recentProjects.slice(1).map(p=><button key={p.id} onClick={()=>replaceProject(p)}><span>{p.name}</span><small>{new Date(p.updatedAt).toLocaleDateString()}</small></button>)}</details>}<div className="welcome-bottom"><button onClick={()=>replaceProject(createExampleProject())}><Sparkles size={14}/>Open example</button><button onClick={()=>{setSplash(false);setDialog('help');}}><HelpCircle size={14}/>Quick guide</button></div></div></div></div>}
    {showStaleDraft&&staleClipDraft&&<div className="modal-backdrop stale-draft-backdrop"><div className="dialog" role="alertdialog" aria-modal="true" aria-label="Unfinished clip edit needs review"><div className="dialog-title"><h2>Unfinished clip edit needs review</h2></div><p className="dialog-description">{staleDraftIssue} The draft remains in browser recovery. Recover it as an unapplied edit in a separate project copy, or discard it. The current project will not change.</p><div className="dialog-actions"><button className="secondary" disabled={staleDraftBusy} onClick={()=>setShowStaleDraft(false)}>Keep for later</button><button className="secondary" disabled={staleDraftBusy} onClick={()=>void discardStaleClipDraft()}>Discard draft</button><button className="primary" disabled={staleDraftBusy} onClick={()=>void recoverStaleClipDraft()}>Recover as separate copy</button></div></div></div>}
    {clipSession&&clipSessionElement&&<div className="modal-backdrop clip-edit-backdrop" onPointerDown={leaveClipSession}>
      <div className="dialog clip-edit-dialog" role="dialog" aria-modal="true" aria-label={clipSessionLabel} onPointerDown={event=>event.stopPropagation()}>
        <div className="dialog-title"><h2>{clipSessionLabel}</h2><Button icon={X} label="Close clip editor" onClick={leaveClipSession}/></div>
        <p className="muted-note">{clipSession.dirty?'Unapplied draft · recoverable in this browser':'Changes stay separate from the project until Apply.'}</p>
        {clipSession.kind==='assembly'?<><label className="select-label">Playhead · s<input aria-label="Assembly edit preview time" type="number" min="0" max={clipSession.draft.duration} step={1/clipSession.draft.fps} value={round(time)} onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value))seek(value);}}/></label><AssemblyGapPanel project={clipSession.draft} rootId={clipSession.targetId} focusedIncomingId={focusedAssemblyGap} onFocus={setFocusedAssemblyGap} onEdit={updateAssemblyGap}/><AssemblyMixPanel project={clipSession.draft} rootId={clipSession.targetId} selectedInstanceId={focusedAssemblyInstance} onSelect={setFocusedAssemblyInstance} onEdit={updateAssemblyPriority} onTextureEdit={updateAssemblyTexture}/><AssemblyClipEditorPanel project={clipSession.draft} rootId={clipSession.targetId} selectedInstanceId={focusedAssemblyInstance} focusedTrack={focusedAssemblyTrack} onSelect={setFocusedAssemblyInstance} time={time} onEditKey={updateAssemblyKey} onAddKey={insertAssemblyKey} onRemoveKey={deleteAssemblyKey} onReset={resetAssemblyKeyOverride}/></>:clipSession.kind==='structure'?<AssemblyStructurePanel project={clipSession.draft} elementId={clipSession.targetId} onReparent={reparentClipSessionElement} onChange={patchClipSessionElement}/>:<><label className="select-label">Playhead · s<input aria-label="Clip edit playhead seconds" type="number" min="0" max={clipSession.draft.duration} step={1/clipSession.draft.fps} value={round(time)} onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value))seek(value);}}/></label><AudioClipPanel project={clipSession.draft} element={clipSessionElement} time={time} onCommit={updateClipSession} onSelect={changeClipSessionTarget}/></>}
        <div className="dialog-actions clip-edit-actions"><button className="secondary" onClick={discardClipSession}>Cancel</button><button className="primary" onClick={applyClipSession}>Apply</button></div>
      </div>
    </div>}
    {clipLeavePrompt&&clipSession&&<div className="modal-backdrop clip-leave-backdrop"><div className="dialog" role="alertdialog" aria-modal="true" aria-label="Unapplied clip changes"><div className="dialog-title"><h2>Unapplied clip changes</h2></div><p className="dialog-description">Apply the draft, discard it, or keep editing. The project and its exports still use the last applied version.</p><div className="dialog-actions"><button className="secondary" onClick={()=>setClipLeavePrompt(false)}>Keep Editing</button><button className="secondary" onClick={discardClipSession}>Discard</button><button className="primary" onClick={applyClipSession}>Apply</button></div></div></div>}
    {sceneDialog&&<div className="modal-backdrop" onPointerDown={()=>setSceneDialog(null)}><form className="dialog scene-edit-dialog" onPointerDown={e=>e.stopPropagation()} onSubmit={e=>{e.preventDefault();applySceneDialog();}}><div className="dialog-title"><h2>{sceneDialog.kind==='rename'?'Rename scene':'Scene duration'}</h2><Button icon={X} label="Close dialog" onClick={()=>setSceneDialog(null)}/></div><label className="select-label">{sceneDialog.kind==='rename'?'Name':'Duration in seconds'}<input autoFocus aria-label={sceneDialog.kind==='rename'?'Scene name':'Scene duration in seconds'} type={sceneDialog.kind==='rename'?'text':'number'} min={sceneDialog.kind==='duration'?1/project.fps:undefined} step={sceneDialog.kind==='duration'?'any':undefined} value={sceneDialog.value} onChange={e=>setSceneDialog({...sceneDialog,value:e.target.value})}/></label>{sceneDialog.kind==='duration'&&<p className="muted-note">Rounded to the nearest frame at {project.fps} FPS.</p>}<div className="dialog-actions"><button type="button" className="secondary" onClick={()=>setSceneDialog(null)}>Cancel</button><button type="submit" className="primary">Apply</button></div></form></div>}
    {dialog&&<div className="modal-backdrop" onPointerDown={()=>setDialog(null)}><div className="dialog" onPointerDown={e=>e.stopPropagation()}><div className="dialog-title"><h2>{dialog==='help'?'A quick guide to Hyde':dialog==='export'?'Export':dialog==='overwrite'?'Replace project file?':'Project settings'}</h2><Button icon={X} label="Close dialog" onClick={()=>setDialog(null)}/></div>
      {dialog==='overwrite'&&<><p className="dialog-description">Replace {projectHandle.current?.name} with your current changes?</p><label className="check-row"><input type="checkbox" checked={skipOverwriteNotice} onChange={e=>setSkipOverwriteNotice(e.target.checked)}/>Do not ask again for this project</label><div className="dialog-actions"><button className="secondary" onClick={()=>setDialog(null)}>Cancel</button><button className="primary" onClick={()=>{if(skipOverwriteNotice)try{localStorage.setItem(`hyde:replace:${project.id}`,'yes');}catch{}setDialog(null);const handle=projectHandle.current;if(handle)void writeCurrentProject(handle);}}>Replace file</button></div></>}{dialog==='settings'&&<><p className="dialog-description">Choose the stage size, frame rate, and duration.</p><div className="preset-buttons">{[['Landscape',1920,1080],['Portrait',1080,1920],['Square',1080,1080]].map(([name,w,h])=><button key={name} className={project.width===+w&&project.height===+h?'active':''} aria-pressed={project.width===+w&&project.height===+h} onClick={()=>edit(p=>{p.width=+w;p.height=+h;})}>{name}</button>)}</div><div className="field-pair"><NumberField label="Width" value={project.width} min={64} max={4096} onChange={n=>edit(p=>{p.width=n;})}/><NumberField label="Height" value={project.height} min={64} max={4096} onChange={n=>edit(p=>{p.height=n;})}/></div><div className="field-pair"><NumberField label="Frame rate" value={project.fps} min={1} max={60} onChange={n=>edit(p=>{p.fps=n;})}/><NumberField label="Duration s" value={project.duration} min={1} max={3600} onChange={n=>edit(p=>{const last=p.sequences.at(-1);p.duration=Math.max(n,(last?.start??0)+1/p.fps);if(last)last.duration=Math.max(1/p.fps,p.duration-last.start);})}/></div><label className="color-field"><span>Background</span><input aria-label="Project background" type="color" value={project.background} onChange={e=>edit(p=>{p.background=e.target.value;})}/><code>{project.background}</code></label><label className="select-label">Project file extension<select value={projectFileExtension} onChange={e=>setProjectFileExtension(e.target.value)}><option>.hyde</option><option>.hy</option></select></label><button className="primary full" onClick={()=>setDialog(null)}>Done</button></>}
      {dialog==='export'&&<><p className="dialog-description">Save a project file, an independent web player, a video, or a GIF.</p><button className="export-option" onClick={()=>void save()}><Save/><span><strong>Editable project</strong><small>All elements, keyframes, and media · {projectFileExtension}</small></span><ChevronRight/></button><WebPlayerSettingsPanel project={project} onChange={settings=>edit(p=>{p.webPlayer=settings;})}/><button className="export-option" onClick={()=>{setBusy('Packaging independent web player…');void exportWeb(project).then(()=>alert('Standalone web package downloaded. Upload all extracted files to static hosting.')).catch(e=>alert(String(e))).finally(()=>setBusy(''));}}><Film/><span><strong>Standalone web story</strong><small>Player + media · no connection to this editor</small></span><ChevronRight/></button><MediaExportPanel project={project}/></>}
      {dialog==='help'&&<><p className="dialog-description">Hyde Story Studio is local-first. Nothing you import is uploaded.</p><div className="guide-grid"><div><strong>1 · Add elements</strong><p>Use the toolbar to add shapes or text. Import your own images, video, and audio.</p></div><div><strong>2 · Animate</strong><p>Turn on Auto key, move the playhead, then change position, rotation, color, or opacity. Expand a timeline row to edit easing.</p></div><div><strong>3 · Save your project</strong><p>Browser recovery is automatic. Save a .hyde file for a portable backup, or export a selection as .hyproj.</p></div></div><div className="shortcut-list">{[['Space','Play / pause'],['← / →','Move selected timeline items; otherwise step one frame'],['Ctrl S','Save project file'],['Ctrl Z','Undo'],['Ctrl Shift Z','Redo'],['Ctrl C','Copy selection'],['Ctrl V','Paste at playhead'],['Ctrl D','Duplicate selection'],['Ctrl G','Create assembly'],['Delete','Delete selection'],['Shift drag','Constrain movement'],['Alt drag','Bypass snapping']].map(([key,label])=><div key={key}><span>{label}</span><kbd>{key}</kbd></div>)}</div></>}
    </div></div>}
    <TooltipLayer/>
  </div>;
}




