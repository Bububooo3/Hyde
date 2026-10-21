import { Application, BlurFilter, Color, Container, Graphics, Mesh, MeshGeometry, Sprite, Text, Texture, VideoSource } from 'pixi.js';
import { layoutWithLines, prepareWithSegments } from '@chenglou/pretext';
import type { PreparedTextWithSegments } from '@chenglou/pretext';
import type { Asset, PlacementFrame, Project, StoryElement } from './model';
import { cameraToStage, evaluateCamera, evaluateCameraForScene, sourceTime, videoVisualExpired } from './engine';
import {mapSceneFramePoint,sceneFrameTransform,sceneVisualFrames} from './sceneFrame';
import {shapePathCommands} from './shapePath';
import {layoutTextUnits, type TextUnit} from './textUnits';
import {textMotionAt} from './textMotion';
import {buildProjectivePinMesh,DEFAULT_PIN_CORNERS,mediaPinRects} from './projectivePin';
import {DEFAULT_MEDIA_TRANSFORM,mediaPlaneRect} from './mediaTransform';
import {ProjectFontLoader} from './projectFonts';
import {flowShapeOutline,flowTextUnits,layoutFlowLines,layoutInsideShapeLines,usableStaticTextFlow,type FlowLine,type FlowPoint} from './textFlow';
import {effectiveRenderOptimization,staticVisualSignature} from './renderOptimization';

interface MediaResource {
  texture?: Texture;
  video?: HTMLVideoElement;
  failed?: boolean;
}
interface CachedResource {
  source: string;
  promise: Promise<MediaResource>;
  resource?: MediaResource;
  released?: boolean;
}
interface ElementNode {
  root: Container;
  shadow: Graphics;
  shape: Graphics;
  outline: Graphics;
  mask: Graphics;
  visibleText: Container;
  mediaText: Container;
  textClip: Graphics;
  mediaTextClip: Graphics;
  clipKey: string;
  sprite: Sprite;
  pinMesh: Mesh;
  pinGeometryKey: string;
  text: Text;
  flowText: Container;
  flowGlyphs: Container;
  flowLines: FlowLine[];
  flowKey: string;
  motion: Container;
  motionGlyphs: Container;
  motionPieces: MotionPiece[];
  motionKey: string;
  glyphMask: Sprite;
  glyphTexture?: Texture;
  glyphKey: string;
  warning: Text;
  geometryKey: string;
  textKey: string;
  preparedKey: string;
  layoutWidth: number;
  prepared?: PreparedTextWithSegments;
  blur?: BlurFilter;
  staticProject?: Project;
  staticVisualKey?: string;
  staticTexture?: Texture;
  staticResourceFailed?: boolean;
}
interface MotionPiece {
  unit: TextUnit;
  holder: Container;
  glyphHolder: Container;
  wipe: Graphics;
  glyphWipe: Graphics;
}
interface SceneLayer { frame:Container; viewport:Container; camera:Container; backdrop:Graphics; clip:Graphics; nested:SceneLayer[] }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;

function paint(value: string) {
  if (value === 'transparent' || value === 'none') return { color: 0, alpha: 0 };
  try {
    const color = new Color(value);
    return { color: color.toNumber(), alpha: color.alpha };
  } catch {
    return { color: 0x000000, alpha: 1 };
  }
}

function path(graphics: Graphics, element: StoryElement): Graphics {
  const width = Math.max(1, finite(element.width, 1));
  const height = Math.max(1, finite(element.height, 1));
  if (element.shapePath) {
    for (const command of shapePathCommands(element.shapePath, width, height)) {
      if (command.type === 'move') graphics.moveTo(command.x, command.y);
      else if (command.type === 'line') graphics.lineTo(command.x, command.y);
      else if (command.type === 'cubic') graphics.bezierCurveTo(command.x1, command.y1, command.x2, command.y2, command.x, command.y);
      else graphics.closePath();
    }
    return graphics;
  }
  if (element.mediaPin && (element.kind === 'image' || element.kind === 'video'))
    return graphics.poly(element.mediaPin.flatMap(point=>[point.x*width,point.y*height]),true);
  if (element.kind === 'ellipse') return graphics.ellipse(width / 2, height / 2, width / 2, height / 2);
  if (element.kind === 'polygon') {
    const points = element.points?.length && element.points.length >= 3
      ? element.points.flatMap(point => [point.x, point.y])
      : [width / 2, 0, width, height, 0, height];
    return graphics.poly(points, true);
  }
  return graphics.rect(0, 0, width, height);
}

/** Wait for decoded pixels, not merely a metadata event. Never leave an export waiting forever. */
function mediaReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener('loadeddata', loaded);
      video.removeEventListener('error', failed);
    };
    const loaded = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('This browser could not decode the video.')); };
    const timeout = window.setTimeout(() => { cleanup(); reject(new Error('Video decoding timed out.')); }, 15000);
    video.addEventListener('loadeddata', loaded, { once: true });
    video.addEventListener('error', failed, { once: true });
    video.load();
  });
}

/** A paused, explicitly sought video makes reverse scrubbing and sampled exports repeatable. */
async function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 0.0001 && !video.seeking) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener('seeked', sought);
      video.removeEventListener('error', failed);
    };
    const sought = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Video seek failed.')); };
    const timeout = window.setTimeout(() => { cleanup(); reject(new Error('Video seek timed out.')); }, 5000);
    video.addEventListener('seeked', sought, { once: true });
    video.addEventListener('error', failed, { once: true });
    try { video.currentTime = time; } catch { failed(); }
  });
}

/**
 * Shared editor/player renderer. Input elements have already been evaluated into world space.
 * Callers should await render() before submitting the next export frame. Concurrent requests
 * are serialized, so a resource load or video seek cannot race another frame's state.
 */
export class StageRenderer {
  private readonly app: Application;
  private readonly nodes = new Map<string, ElementNode>();
  private readonly images = new Map<string, CachedResource>();
  private readonly videos = new Map<string, CachedResource>();
  private readonly fonts = new ProjectFontLoader();
  private renderQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private projectId = '';
  private width = 960;
  private height = 540;
  private readonly editorMargin: number;
  private readonly editorBackdrop = new Graphics();
  private readonly content = new Container();
  private readonly globalLayer = new Container();
  private readonly sceneLayers = new Map<string,SceneLayer>();
  private readonly edgeMarks = new Graphics();

  private constructor(app: Application, editorMargin: number) {
    this.app = app;
    this.editorMargin = editorMargin;
    this.content.addChild(this.globalLayer);
    if (editorMargin) {
      app.stage.addChild(this.editorBackdrop, this.content, this.edgeMarks);
      app.stage.position.set(editorMargin, editorMargin);
      this.width = 960 + editorMargin * 2;
      this.height = 540 + editorMargin * 2;
    } else app.stage.addChild(this.content);
  }

  static async create(host: HTMLElement, editorMargin = 0): Promise<StageRenderer> {
    const app = new Application();
    await app.init({
      width: 960+editorMargin*2, height: 540+editorMargin*2, resolution: 1, autoDensity: false,
      antialias: true, background: editorMargin?'#1f2933':'#d9dde3', backgroundAlpha: 1,
      preference: 'webgl', autoStart: false, sharedTicker: false,
      preserveDrawingBuffer: true,
    });
    app.stop();
    app.stage.eventMode = 'none';
    const canvas = app.canvas as HTMLCanvasElement;
    canvas.setAttribute('aria-label', 'Story stage');
    canvas.style.display = 'block';
    host.appendChild(canvas);
    return new StageRenderer(app,editorMargin);
  }

  get canvas(): HTMLCanvasElement { return this.app.canvas as HTMLCanvasElement; }

  resize(width: number, height: number): void {
    if (this.disposed) return;
    width = Math.max(1, Math.round(finite(width, 960)))+this.editorMargin*2;
    height = Math.max(1, Math.round(finite(height, 540)))+this.editorMargin*2;
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.app.renderer.resize(width, height);
  }

  render(project: Project, elements: StoryElement[], time: number): Promise<void> {
    const next = this.renderQueue.then(() => this.draw(project, elements, time));
    this.renderQueue = next.catch(() => { /* A failed frame must not poison subsequent frames. */ });
    return next;
  }

  private createSceneLayer(parent:Container):SceneLayer {
    const frame=new Container({eventMode:'none'}),viewport=new Container({eventMode:'none'}),camera=new Container({eventMode:'none'});
    const backdrop=new Graphics(),clip=new Graphics();
    viewport.addChild(camera);frame.addChild(backdrop,viewport,clip);
    parent.addChild(frame);
    return {frame,viewport,camera,backdrop,clip,nested:[]};
  }

  private sceneLayer(id:string):SceneLayer {
    let layer=this.sceneLayers.get(id);
    if(layer)return layer;
    layer=this.createSceneLayer(this.content);this.sceneLayers.set(id,layer);
    return layer;
  }

  private setSceneFrame(project:Project,layer:SceneLayer,scene:PlacementFrame):void {
    const frame=scene.frame,transform=sceneFrameTransform(project,scene);
    layer.frame.pivot.set(frame?.width?frame.width/2:0,frame?.height?frame.height/2:0);
    layer.frame.position.set(frame?frame.x+frame.width/2:0,frame?frame.y+frame.height/2:0);
    layer.frame.rotation=frame?(scene.frameRotation??0)*Math.PI/180:0;
    layer.frame.scale.set(1);
    layer.frame.alpha=clamp(scene.opacity??1,0,1);
    layer.viewport.position.set(transform.x-(frame?.x??0),transform.y-(frame?.y??0));
    layer.viewport.scale.set(transform.scaleX,transform.scaleY);
    layer.backdrop.visible=!!frame;
    if(frame){
      layer.backdrop.clear().rect(0,0,frame.width,frame.height).fill(project.background);
      layer.clip.clear().rect(0,0,frame.width,frame.height).fill(0xffffff);
      layer.viewport.mask=layer.clip;
    }else layer.viewport.mask=null;
  }

  private createNode(parent:Container): ElementNode {
    const root = new Container({ eventMode: 'none' });
    const shadow = new Graphics();
    const shape = new Graphics();
    const sprite = new Sprite(Texture.EMPTY);
    sprite.anchor.set(.5);
    const initialPin=buildProjectivePinMesh(DEFAULT_PIN_CORNERS,1,1,{subdivisions:1})!;
    const pinMesh=new Mesh({geometry:new MeshGeometry(initialPin),texture:Texture.EMPTY});
    pinMesh.visible=false;
    const mask = new Graphics();
    const outline = new Graphics();
    const text = new Text({ text: '', style: { fontFamily: 'Georgia', fontSize: 40, fill: '#20251f' } });
    const flowText = new Container({eventMode:'none'});
    const flowGlyphs = new Container({eventMode:'none'});
    const motion = new Container({eventMode:'none'});
    const visibleText = new Container({eventMode:'none'});
    const mediaText = new Container({eventMode:'none'});
    const textClip = new Graphics();
    const mediaTextClip = new Graphics();
    // This detached white copy is rendered only into an alpha mask when text
    // uses an image or video fill. Its transforms match the visible glyphs.
    const motionGlyphs = new Container({eventMode:'none'});
    const glyphMask = new Sprite(Texture.EMPTY);
    const warning = new Text({ text: 'Media unavailable', style: { fontFamily: 'sans-serif', fontSize: 14, fill: '#6c3434' } });
    visibleText.addChild(text, flowText, motion);
    mediaText.addChild(sprite, pinMesh);
    root.addChild(shadow, shape, visibleText, mediaText, mask, glyphMask, textClip, mediaTextClip, outline, warning);
    sprite.mask = mask;
    glyphMask.visible = false;
    warning.visible = false;
    parent.addChild(root);
    return { root, shadow, shape, sprite, pinMesh, pinGeometryKey:'', mask, visibleText, mediaText, textClip, mediaTextClip, clipKey:'', text, flowText, flowGlyphs, flowLines:[], flowKey:'', motion, motionGlyphs, motionPieces: [], motionKey: '', glyphMask, glyphKey: '', outline, warning, geometryKey: '', textKey: '', preparedKey: '', layoutWidth: 0 };
  }

  /** The visible glyphs and text-filled media need independent masks. Both use
   * the same contour in the text object's coordinates, including animated pose. */
  private updateTextClip(node:ElementNode,outline:readonly FlowPoint[]|null):void{
    if(!outline){
      node.visibleText.mask=null;
      node.mediaText.mask=null;
      node.textClip.visible=false;
      node.mediaTextClip.visible=false;
      node.clipKey='';
      return;
    }
    const key=JSON.stringify(outline);
    if(key!==node.clipKey){
      node.clipKey=key;
      const vertices=outline.flatMap(point=>[point.x,point.y]);
      node.textClip.clear().poly(vertices,true).fill(0xffffff);
      node.mediaTextClip.clear().poly(vertices,true).fill(0xffffff);
    }
    node.textClip.visible=true;
    node.mediaTextClip.visible=true;
    node.visibleText.mask=node.textClip;
    node.mediaText.mask=node.mediaTextClip;
  }

  private updateGeometry(node: ElementNode, element: StoryElement): void {
    const key = JSON.stringify([element.kind, element.width, element.height, element.fill, element.stroke,
      element.strokeWidth, element.points, element.shapePath, element.mediaPin, element.shadow]);
    if (node.geometryKey === key) return;
    node.geometryKey = key;
    node.shape.clear();
    node.outline.clear();
    node.mask.clear();
    node.shadow.clear();
    const isText = element.kind === 'text';
    node.shape.visible = !isText;
    node.outline.visible = !isText && element.strokeWidth > 0;
    node.shadow.visible = !isText && element.shadow.enabled;
    if (!isText) {
      path(node.shape, element).fill(paint(element.fill));
      if (element.strokeWidth > 0) path(node.outline, element).stroke({ ...paint(element.stroke), width: element.strokeWidth });
      path(node.mask, element).fill(0xffffff);
    }
    if (node.shadow.visible) {
      path(node.shadow, element).fill(paint(element.shadow.color));
      node.shadow.position.set(element.shadow.x, element.shadow.y);
      const blur = Math.max(0, element.shadow.blur);
      if (blur > 0) {
        node.blur ??= new BlurFilter({ strength: blur / 2, quality: 3 });
        node.blur.strength = blur / 2;
        node.shadow.filters = [node.blur];
      } else node.shadow.filters = null;
    }
  }

  private updateText(node: ElementNode, element: StoryElement, obstacle?:StoryElement): void {
    node.text.visible = element.kind === 'text';
    if (!node.text.visible) return;
    const size = Math.max(1, element.fontSize ?? 40);
    const family = element.fontFamily || 'Georgia';
    const text = element.text ?? '';
    const preparedKey = JSON.stringify([text, family, size]);
    const width = Math.max(1, element.width);
    const staticWidth = element.textLayout === 'static' && Number.isFinite(element.staticLayoutWidth)
      ? Math.max(1, element.staticLayoutWidth!) : undefined;
    if (preparedKey !== node.preparedKey) {
      node.preparedKey = preparedKey;
      node.prepared = prepareWithSegments(text, `${size}px ${family}`, { whiteSpace: 'pre-wrap' });
      node.layoutWidth = staticWidth ?? width;
    } else if (staticWidth !== undefined) node.layoutWidth = staticWidth;
    else if (element.textLayout !== 'static') node.layoutWidth = width;
    const mode=element.textShapeMode??'around';
    const staticFlow=usableStaticTextFlow(element);
    const outline=staticFlow?staticFlow.outline??null:obstacle?flowShapeOutline(element,obstacle):null;
    // Interior flow also clips tiny glyph overhangs and shadows at the edge.
    this.updateTextClip(node,mode==='clip'||mode==='inside'?outline:null);
    const flowKey=staticFlow?JSON.stringify(staticFlow):outline&&mode!=='clip'?JSON.stringify([mode,outline.map(point=>[Math.round(point.x*2)/2,Math.round(point.y*2)/2])]):'';
    const key = JSON.stringify([preparedKey, node.layoutWidth, element.fill, element.stroke, element.strokeWidth, element.shadow, mode, flowKey]);
    if (node.textKey === key) return;
    node.textKey = key;
    node.flowKey=flowKey;
    node.flowLines=staticFlow?staticFlow.lines:outline&&mode==='inside'
      ?layoutInsideShapeLines(node.prepared!,node.layoutWidth,element.height,size*1.2,outline,Math.max(6,size*.2))
      :outline&&mode==='around'?layoutFlowLines(node.prepared!,node.layoutWidth,size*1.2,outline,Math.max(6,size*.2)):[];
    node.text.text = node.flowKey?node.flowLines.map(line=>line.text).join('\n'):
      layoutWithLines(node.prepared!, node.layoutWidth, size * 1.2).lines.map(line => line.text).join('\n');
    const shadow = element.shadow;
    node.text.style = {
      fontFamily: family, fontSize: size, fill: element.fill,
      stroke: element.strokeWidth > 0 ? { color: element.stroke, width: element.strokeWidth } : undefined,
      lineHeight: size * 1.2, wordWrap: false, padding: element.strokeWidth,
      dropShadow: shadow.enabled ? {
        color: paint(shadow.color).color, alpha: paint(shadow.color).alpha,
        blur: shadow.blur, distance: Math.hypot(shadow.x, shadow.y), angle: Math.atan2(shadow.y, shadow.x),
      } : false,
    };
    for(const child of node.flowText.removeChildren())child.destroy();
    for(const child of node.flowGlyphs.removeChildren())child.destroy();
    if(node.flowKey)for(const line of node.flowLines){
      const visible=new Text({text:line.text,style:node.text.style});
      visible.position.set(line.x,line.y);
      node.flowText.addChild(visible);
      const glyph=new Text({text:line.text,style:{fontFamily:family,fontSize:size,fill:'#ffffff',lineHeight:size*1.2,wordWrap:false,padding:0}});
      glyph.position.set(line.x,line.y);
      node.flowGlyphs.addChild(glyph);
    }
  }

  private updateTextMotion(node: ElementNode, element: StoryElement, time: number): void {
    const animation = element.kind === 'text' ? element.textAnimation : undefined;
    node.motion.visible = !!animation;
    node.text.visible = element.kind === 'text' && !animation && !node.flowKey;
    node.flowText.visible = element.kind === 'text' && !animation && !!node.flowKey;
    if (!animation) return;
    const key = JSON.stringify([node.textKey, animation.unit]);
    if (key !== node.motionKey) {
      node.motionKey = key;
      for (const piece of node.motionPieces) {
        piece.holder.destroy({children:true});
        piece.glyphHolder.destroy({children:true});
      }
      node.motionPieces = [];
      const size = Math.max(1, element.fontSize ?? 40);
      const family = element.fontFamily || 'Georgia';
      const units = node.flowKey
        ? flowTextUnits(node.prepared!,node.flowLines,`${size}px ${family}`,size*1.2,animation.unit)
        : layoutTextUnits(node.prepared!, `${size}px ${family}`, node.layoutWidth, size * 1.2, animation.unit);
      for (const unit of units) {
        const holder = new Container({eventMode:'none'}), glyphHolder = new Container({eventMode:'none'});
        const text = new Text({text:unit.text, style:node.text.style});
        const glyph = new Text({text:unit.text, style:{fontFamily:family,fontSize:size,fill:'#ffffff',lineHeight:size*1.2,wordWrap:false,padding:0}});
        const wipe = new Graphics(), glyphWipe = new Graphics();
        holder.addChild(text,wipe);glyphHolder.addChild(glyph,glyphWipe);
        text.mask=wipe;glyph.mask=glyphWipe;
        node.motion.addChild(holder);node.motionGlyphs.addChild(glyphHolder);
        node.motionPieces.push({unit,holder,glyphHolder,wipe,glyphWipe});
      }
    }
    for (const [index,piece] of node.motionPieces.entries()) {
      const value=textMotionAt(animation,time-element.start,index,node.motionPieces.length,piece.unit.id);
      for (const holder of [piece.holder,piece.glyphHolder]) {
        holder.position.set(piece.unit.x+piece.unit.width/2+value.x,piece.unit.y+piece.unit.height/2+value.y);
        holder.pivot.set(piece.unit.width/2,piece.unit.height/2);
        holder.scale.set(value.scale);
        holder.rotation=value.rotation*Math.PI/180;
        holder.alpha=clamp(value.alpha,0,1);
      }
      const reveal=clamp(value.reveal,0,1);
      for (const wipe of [piece.wipe,piece.glyphWipe]) {
        wipe.clear().rect(0,-Math.max(2,piece.unit.height*.25),Math.max(0.001,piece.unit.width*reveal),piece.unit.height*1.5).fill(0xffffff);
      }
    }
  }

  private updateMediaMask(node: ElementNode, element: StoryElement): void {
    const textMask = element.kind === 'text';
    if (textMask) {
      // A Sprite alpha mask preserves antialiased glyph edges. A Graphics mask or a
      // stencil mask of a Text container would clip to geometry rather than glyph alpha.
      const animated=!!element.textAnimation;
      const key = animated ? '' : JSON.stringify([node.text.text, element.fontFamily, element.fontSize, node.layoutWidth,node.flowKey]);
      if (animated || node.glyphKey !== key) {
        node.glyphKey = key;
        const glyphs = animated ? node.motionGlyphs : node.flowKey ? node.flowGlyphs : new Text({
          text: node.text.text || ' ',
          style: {
            fontFamily: element.fontFamily || 'Georgia', fontSize: Math.max(1, element.fontSize ?? 40),
            fill: '#ffffff', lineHeight: Math.max(1, element.fontSize ?? 40) * 1.2,
            wordWrap: false, padding: 0,
          },
        });
        const bounds = glyphs.getLocalBounds();
        const next = this.app.renderer.generateTexture({ target: glyphs, resolution: 1, antialias: true });
        const previous = node.glyphTexture;
        node.glyphTexture = next;
        node.glyphMask.texture = next;
        node.glyphMask.position.set(bounds.x, bounds.y);
        previous?.destroy(true);
        if (!animated && !node.flowKey) glyphs.destroy();
      }
      node.sprite.setMask({ mask: node.glyphMask, channel: 'alpha' });
    } else if(element.mediaPin){
      node.sprite.mask=null;
      node.pinMesh.setMask({mask:node.mask,channel:'red'});
    }else{
      node.pinMesh.mask=null;
      node.sprite.setMask({ mask: node.mask, channel: 'red' });
    }
    // Switching mask types restores the old mask's build flags; explicitly keep the
    // inactive helper hidden so it cannot become a white rectangle on the stage.
    node.mask.visible = !textMask;
    node.glyphMask.visible = textMask;
  }

  private loadResource(element: StoryElement, asset: Asset): Promise<MediaResource> {
    const isVideo = asset.kind === 'video';
    // Video textures are per INSTANCE: the same asset can appear at two source times.
    const cache = isVideo ? this.videos : this.images;
    const key = isVideo ? element.id : asset.id;
    const existing = cache.get(key);
    if (existing?.source === asset.dataUrl) return existing.promise;
    if (existing) this.release(existing);
    const entry: CachedResource = { source: asset.dataUrl, promise: Promise.resolve({}) };
    entry.promise = (async (): Promise<MediaResource> => {
      let video: HTMLVideoElement | undefined;
      try {
        let resource: MediaResource;
        if (isVideo) {
          video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.preload = 'auto';
          video.src = asset.dataUrl;
          await mediaReady(video);
          const source = new VideoSource({ resource: video, autoPlay: false, autoLoad: false, muted: true, playsinline: true });
          source.autoUpdate = false;
          resource = { video, texture: new Texture({ source }) };
        } else {
          const image = new Image();
          image.src = asset.dataUrl;
          await image.decode();
          resource = { texture: Texture.from(image) };
        }
        entry.resource = resource;
        if (this.disposed || entry.released || cache.get(key) !== entry) this.release(entry);
        return resource;
      } catch (error) {
        if (video) { video.removeAttribute('src'); video.load(); }
        console.warn(`Hyde could not load ${asset.name}:`, error);
        const failed = { failed: true };
        entry.resource = failed;
        return failed;
      }
    })();
    cache.set(key, entry);
    return entry.promise;
  }

  private async draw(project: Project, elements: StoryElement[], time: number): Promise<void> {
    if (this.disposed) return;
    if (this.projectId !== project.id) {
      this.clear();
      this.projectId = project.id;
    }
    // Pretext measures text synchronously. Await packaged fonts before it (or
    // Pixi's canvas text renderer) can cache measurements from a fallback face.
    const fontsChanged = await this.fonts.sync(project.assets);
    if (this.disposed) return;
    if (fontsChanged) for (const node of this.nodes.values()) {
      node.preparedKey = '';
      node.textKey = '';
      node.motionKey = '';
      node.glyphKey = '';
      node.staticVisualKey = '';
    }
    this.resize(project.width, project.height);
    if(this.editorMargin){this.app.renderer.background.color=paint('#1f2933').color;this.editorBackdrop.clear().rect(0,0,project.width,project.height).fill(project.background);this.app.stage.setChildIndex(this.editorBackdrop,0);}
    else this.app.renderer.background.color = paint(project.background).color;
    const camera = evaluateCamera(project, time);
    const setCamera=(target:Container,view:ReturnType<typeof evaluateCamera>)=>{
      target.pivot.set(view.x,view.y);
      target.position.set(project.width/2,project.height/2);
      target.rotation=-view.rotation*Math.PI/180;
      target.scale.set(view.zoom);
    };
    setCamera(this.globalLayer,camera);
    this.content.setChildIndex(this.globalLayer,0);
    const scenes=project.sequences.map((scene,index)=>({scene,index})).sort((a,b)=>a.scene.start-b.scene.start||a.index-b.index);
    const sceneParents=new Map<string,Container>();
    for(const {scene} of scenes){
      const layer=this.sceneLayer(scene.id);
      layer.frame.visible=time>=scene.start&&time<scene.start+scene.duration;
      this.setSceneFrame(project,layer,scene);
      // Preserve each nested viewport, including ones frozen by Make Independent.
      let inner=layer;
      for(const viewport of sceneVisualFrames(project,scene).slice(1)){
        inner.camera.visible=false;
        inner.nested[0]??=this.createSceneLayer(inner.viewport);
        const child=inner.nested[0];
        child.frame.visible=true;
        this.setSceneFrame(project,child,viewport);
        inner=child;
      }
      inner.camera.visible=true;
      if(inner.nested[0])inner.nested[0].frame.visible=false;
      setCamera(inner.camera,evaluateCameraForScene(project,scene,time));
      sceneParents.set(scene.id,inner.camera);
      this.content.setChildIndex(layer.frame,this.content.children.length-1);
    }
    const assets = new Map(project.assets.map(asset => [asset.id, asset]));
    const elementById=new Map(elements.map(element=>[element.id,element]));
    const active = elements.filter(element => !element.hidden && element.kind !== 'audio' && element.kind !== 'group');
    const activeById=new Map(active.map(element=>[element.id,element]));
    const resources = await Promise.all(active.map(async element => {
      const asset = element.assetId ? assets.get(element.assetId) : undefined;
      if (!asset || (asset.kind !== 'image' && asset.kind !== 'video')) return undefined;
      const resource = await this.loadResource(element, asset);
      if (this.disposed) return undefined;
      if (resource.video && !resource.failed) {
        const duration = resource.video.duration;
        const target = sourceTime(element, time, Number.isFinite(duration) ? duration : undefined);
        try {
          await seekVideo(resource.video, Number.isFinite(duration) ? clamp(target, 0, Math.max(0, duration - .001)) : target);
          resource.texture?.source.update();
        } catch (error) {
          console.warn(`Hyde could not seek ${asset.name}:`, error);
          return { failed: true } satisfies MediaResource;
        }
      }
      return resource;
    }));
    if (this.disposed) return;
    for (const node of this.nodes.values()) node.root.visible = false;
    active.forEach((element, index) => {
      let node = this.nodes.get(element.id);
      const parent=element.sceneId?sceneParents.get(element.sceneId)??this.sceneLayer(element.sceneId).camera:this.globalLayer;
      if (!node) { node = this.createNode(parent); this.nodes.set(element.id, node); }
      const root = node.root;
      if(root.parent!==parent)parent.addChild(root);
      root.visible = true;
      parent.setChildIndex(root,parent.children.length-1);
      const resource=resources[index];
      const elementAsset=element.assetId?assets.get(element.assetId):undefined;
      const flowTarget=element.kind==='text'&&element.flowAroundId?activeById.get(element.flowAroundId):undefined;
      const obstacle=flowTarget?.sceneId===element.sceneId?flowTarget:undefined;
      const staticHint=effectiveRenderOptimization(element,elementById,elementAsset)==='static';
      const visualKey=staticHint?staticVisualSignature(element,obstacle):'';
      const failed=Boolean(resource?.failed);
      if(staticHint&&node.staticProject===project&&node.staticVisualKey===visualKey&&
        node.staticTexture===resource?.texture&&node.staticResourceFailed===failed)return;
      root.position.set(element.x, element.y);
      root.pivot.set(element.pivotX * element.width, element.pivotY * element.height);
      root.rotation = element.rotation * Math.PI / 180;
      root.scale.set(element.scaleX, element.scaleY);
      root.alpha = clamp(element.opacity, 0, 1);
      this.updateGeometry(node, element);
      this.updateText(node, element, obstacle);
      this.updateTextMotion(node, element, time);
      const videoDuration=resource?.video&&Number.isFinite(resource.video.duration)?resource.video.duration:elementAsset?.duration;
      const videoExpired=Boolean(resource?.video && videoVisualExpired(element,time,videoDuration??Number.NaN));
      if(videoExpired&&element.kind==='video')root.visible=false;
      node.sprite.visible = Boolean(resource?.texture) && !videoExpired && !element.mediaPin && !(element.kind==='text' && element.textAnimation && !node.motionPieces.length);
      node.pinMesh.visible=Boolean(resource?.texture&&!videoExpired&&element.mediaPin);
      node.warning.visible = Boolean(element.assetId && elementAsset?.kind !== 'font' && (!resource || resource.failed));
      if (node.warning.visible) {
        node.warning.position.set(8, 8);
        node.warning.scale.set(Math.min(1, Math.max(.25, element.width / 160)));
      }
      if (resource?.texture && (node.sprite.visible||node.pinMesh.visible)) {
        this.updateMediaMask(node, element);
        node.sprite.texture = resource.texture;
        node.sprite.alpha = clamp(element.mediaOpacity ?? 1, 0, 1);
        const sourceWidth = Math.max(1, resource.texture.width);
        const sourceHeight = Math.max(1, resource.texture.height);
        if(element.mediaPin){
          const plane=element.mediaTransform
            ? mediaPlaneRect(element.mediaFit??'fill',element.width,element.height,sourceWidth,sourceHeight)
            : null;
          const rects=plane
            ? {contentRect:{x:plane.x/element.width,y:plane.y/element.height,width:plane.width/element.width,height:plane.height/element.height},uvRect:{x:0,y:0,width:1,height:1}}
            : mediaPinRects(element.mediaFit??'fill',element.width,element.height,sourceWidth,sourceHeight);
          const key=JSON.stringify([element.mediaPin,element.width,element.height,element.mediaFit,sourceWidth,sourceHeight,element.mediaTransform]);
          if(rects&&key!==node.pinGeometryKey){
            const data=buildProjectivePinMesh(element.mediaPin,element.width,element.height,{...rects,mediaTransform:element.mediaTransform,subdivisions:16});
            if(data){const previous=node.pinMesh.geometry;node.pinMesh.geometry=new MeshGeometry(data);previous.destroy();node.pinGeometryKey=key;}
          }
          node.pinMesh.texture=resource.texture;
          node.pinMesh.alpha=clamp(element.mediaOpacity??1,0,1);
        }
        const plane=mediaPlaneRect(element.mediaFit??'fill',element.width,element.height,sourceWidth,sourceHeight)!;
        const transform=element.mediaTransform??DEFAULT_MEDIA_TRANSFORM;
        node.sprite.width=plane.width*transform.scaleX;
        node.sprite.height=plane.height*transform.scaleY;
        node.sprite.position.set(element.width/2+transform.x,element.height/2+transform.y);
        node.sprite.rotation=transform.rotation*Math.PI/180;
      }
      node.staticProject=staticHint?project:undefined;
      node.staticVisualKey=visualKey;
      node.staticTexture=resource?.texture;
      node.staticResourceFailed=failed;
    });
    if(this.editorMargin){
      this.edgeMarks.clear();
      for(const element of active){
        const a=element.rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
        const scene=project.sequences.find(item=>item.id===element.sceneId);
        const view=scene?evaluateCameraForScene(project,scene,time):camera;
        const points=[[0,0],[element.width,0],[element.width,element.height],[0,element.height]].map(([x,y])=>{const dx=(x-element.width*element.pivotX)*element.scaleX,dy=(y-element.height*element.pivotY)*element.scaleY;const point=cameraToStage({x:element.x+dx*c-dy*s,y:element.y+dx*s+dy*c},view,project);return scene?mapSceneFramePoint(project,scene,point):point;});
        const left=Math.min(...points.map(p=>p.x)),right=Math.max(...points.map(p=>p.x)),top=Math.min(...points.map(p=>p.y)),bottom=Math.max(...points.map(p=>p.y));
        if(left<0&&right>0)this.edgeMarks.moveTo(0,Math.max(0,top)).lineTo(0,Math.min(project.height,bottom));
        if(left<project.width&&right>project.width)this.edgeMarks.moveTo(project.width,Math.max(0,top)).lineTo(project.width,Math.min(project.height,bottom));
        if(top<0&&bottom>0)this.edgeMarks.moveTo(Math.max(0,left),0).lineTo(Math.min(project.width,right),0);
        if(top<project.height&&bottom>project.height)this.edgeMarks.moveTo(Math.max(0,left),project.height).lineTo(Math.min(project.width,right),project.height);
      }
      this.edgeMarks.stroke({color:'#e15f54',width:3});this.app.stage.setChildIndex(this.edgeMarks,this.app.stage.children.length-1);
    }
    // Removed objects release their display nodes; inactive project objects stay cached.
    const projectElements = new Map([...project.elements,...active].map(element => [element.id, element]));
    const ids = new Set(projectElements.keys());
    for (const [id, node] of this.nodes) {
      if (ids.has(id)) continue;
      node.root.destroy({ children: true });
      node.flowGlyphs.destroy({children:true});
      node.motionGlyphs.destroy({children:true});
      node.glyphTexture?.destroy(true);
      node.blur?.destroy();
      this.nodes.delete(id);
    }
    for (const [id, entry] of this.videos) {
      const element = projectElements.get(id);
      const asset = element?.assetId ? assets.get(element.assetId) : undefined;
      if (!asset || asset.kind !== 'video' || entry.source !== asset.dataUrl) {
        this.release(entry);
        this.videos.delete(id);
      }
    }
    for (const [id, entry] of this.images) {
      if (!assets.has(id)) { this.release(entry); this.images.delete(id); }
    }
    for(const [id,layer] of this.sceneLayers)if(!project.sequences.some(scene=>scene.id===id)){
      layer.frame.destroy({children:true});this.sceneLayers.delete(id);
    }
    this.app.render();
  }

  private release(entry: CachedResource): void {
    entry.released = true;
    const resource = entry.resource;
    if (!resource) return;
    resource.texture?.destroy(true);
    if (resource.video) {
      resource.video.pause();
      resource.video.removeAttribute('src');
      resource.video.load();
    }
    entry.resource = undefined;
  }

  private clear(): void {
    for (const node of this.nodes.values()) {
      node.root.destroy({ children: true });
      node.flowGlyphs.destroy({children:true});
      node.motionGlyphs.destroy({children:true});
      node.glyphTexture?.destroy(true);
      node.blur?.destroy();
    }
    this.nodes.clear();
    for(const layer of this.sceneLayers.values())layer.frame.destroy({children:true});
    this.sceneLayers.clear();
    for (const entry of this.images.values()) this.release(entry);
    for (const entry of this.videos.values()) this.release(entry);
    this.images.clear();
    this.videos.clear();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fonts.dispose();
    this.clear();
    this.app.destroy({ removeView: true }, { children: true });
  }
}
