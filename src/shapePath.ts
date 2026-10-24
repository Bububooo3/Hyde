import type { PathPoint, ShapeContour, ShapePath, StoryElement } from './model';

export type PathCommand =
  | { type: 'move' | 'line'; x: number; y: number }
  | { type: 'cubic'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'close' };

const ellipseHandle = 0.5522847498307936 / 2;
const mix = (a: Pick<PathPoint, 'x' | 'y'>, b: Pick<PathPoint, 'x' | 'y'>, t: number) =>
  ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Convert a primitive to a closed editable path without changing its visible
 * dimensions. Existing polygon vertices are local pixels; path points are
 * normalized so the path follows later width/height changes. */
export function editablePathForElement(element: Pick<StoryElement, 'kind' | 'width' | 'height' | 'points' | 'shapePath'>): ShapePath {
  if (element.shapePath) return structuredClone(element.shapePath);
  if (element.kind === 'ellipse') return { points: [
    { x: .5, y: 0, in: { x: .5 - ellipseHandle, y: 0 }, out: { x: .5 + ellipseHandle, y: 0 } },
    { x: 1, y: .5, in: { x: 1, y: .5 - ellipseHandle }, out: { x: 1, y: .5 + ellipseHandle } },
    { x: .5, y: 1, in: { x: .5 + ellipseHandle, y: 1 }, out: { x: .5 - ellipseHandle, y: 1 } },
    { x: 0, y: .5, in: { x: 0, y: .5 + ellipseHandle }, out: { x: 0, y: .5 - ellipseHandle } },
  ] };
  if (element.kind === 'polygon') {
    const points = element.points?.length && element.points.length >= 3
      ? element.points : [{ x: element.width / 2, y: 0 }, { x: element.width, y: element.height }, { x: 0, y: element.height }];
    return { points: points.map(point => ({ x: point.x / element.width, y: point.y / element.height })) };
  }
  if (element.kind === 'rectangle' || element.kind === 'image' || element.kind === 'video') return { points: [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
  ] };
  throw new Error('Only shapes and visual media have editable paths.');
}

/** A pure operation suitable for editor commands, undo/redo, and future
 * programmatic authoring. No primitive vertices or source object are changed. */
export function withEditablePath(element: StoryElement): StoryElement {
  return { ...element, shapePath: editablePathForElement(element) };
}

/** Moving an anchor carries its handles, preserving its local tangent shape. */
function selectedContour(path: ShapePath, contourIndex: number): ShapeContour {
  const contour = contourIndex === 0 ? path : path.holes?.[contourIndex - 1];
  if (!Number.isSafeInteger(contourIndex) || contourIndex < 0 || !contour) throw new RangeError('Path contour does not exist.');
  return contour;
}

export function movePathAnchor(path: ShapePath, index: number, x: number, y: number, contourIndex = 0): ShapePath {
  const next = structuredClone(path), contour = selectedContour(next, contourIndex), point = contour.points[index];
  if (!point) throw new RangeError('Path point does not exist.');
  const dx = x - point.x, dy = y - point.y;
  point.x = x; point.y = y;
  if (point.in) { point.in.x += dx; point.in.y += dy; }
  if (point.out) { point.out.x += dx; point.out.y += dy; }
  return next;
}

/** Setting a handle curves the adjacent edge; removing it can restore a line. */
export function setPathHandle(path: ShapePath, index: number, side: 'in' | 'out', position?: {x:number;y:number}, contourIndex = 0): ShapePath {
  const next = structuredClone(path), contour = selectedContour(next, contourIndex);
  if (!contour.points[index]) throw new RangeError('Path point does not exist.');
  if (position) contour.points[index][side] = { ...position };
  else delete contour.points[index][side];
  return next;
}

/** Insert a point on a closed edge. Cubic edges use de Casteljau subdivision,
 * so the visible curve is unchanged until the new handles are edited. */
export function splitPathSegment(path: ShapePath, index: number, fraction = .5, contourIndex = 0): ShapePath {
  if (!(fraction > 0 && fraction < 1)) throw new RangeError('Split fraction must be inside the segment.');
  const next = structuredClone(path), contour = selectedContour(next, contourIndex), from = contour.points[index], to = contour.points[(index + 1) % contour.points.length];
  if (!from) throw new RangeError('Path segment does not exist.');
  if (!from.out && !to.in) {
    contour.points.splice(index + 1, 0, mix(from, to, fraction));
    return next;
  }
  const a = mix(from, from.out ?? from, fraction);
  const b = mix(from.out ?? from, to.in ?? to, fraction);
  const c = mix(to.in ?? to, to, fraction);
  const d = mix(a, b, fraction), e = mix(b, c, fraction), midpoint = mix(d, e, fraction);
  from.out = a; to.in = c;
  contour.points.splice(index + 1, 0, { ...midpoint, in: d, out: e });
  return next;
}

export function removePathPoint(path:ShapePath,index:number,contourIndex=0):ShapePath{
  const next=structuredClone(path), contour=selectedContour(next,contourIndex);
  if(contour.points.length<=3)throw new Error('A closed path needs at least three points.');
  if(!contour.points[index])throw new RangeError('Path point does not exist.');
  contour.points.splice(index,1);
  return next;
}

/** The stage overlays and editor gestures use evaluated world poses. These
 * inverses keep handle dragging aligned under rotation, scale, and pivots. */
export function pathPointToWorld(element: Pick<StoryElement, 'x' | 'y' | 'width' | 'height' | 'pivotX' | 'pivotY' | 'scaleX' | 'scaleY' | 'rotation'>, point: {x:number;y:number}): {x:number;y:number} {
  const angle = element.rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const dx = (point.x - element.pivotX) * element.width * element.scaleX;
  const dy = (point.y - element.pivotY) * element.height * element.scaleY;
  return { x: element.x + dx * c - dy * s, y: element.y + dx * s + dy * c };
}

export function worldToPathPoint(element: Pick<StoryElement, 'x' | 'y' | 'width' | 'height' | 'pivotX' | 'pivotY' | 'scaleX' | 'scaleY' | 'rotation'>, point: {x:number;y:number}): {x:number;y:number} {
  if (!element.width || !element.height || !element.scaleX || !element.scaleY) throw new RangeError('A zero-size shape cannot have editable handles.');
  const angle = element.rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const dx = point.x - element.x, dy = point.y - element.y;
  return {
    x: (dx * c + dy * s) / (element.width * element.scaleX) + element.pivotX,
    y: (-dx * s + dy * c) / (element.height * element.scaleY) + element.pivotY,
  };
}

/** One coordinate mapping feeds the Pixi renderer and SVG editor guides. */
export function shapePathCommands(path: ShapeContour, width: number, height: number): PathCommand[] {
  const points = path.points;
  if (points.length < 3) return [];
  const scaled = (point: Pick<PathPoint, 'x' | 'y'>) => ({ x: point.x * width, y: point.y * height });
  const first = scaled(points[0]);
  const commands: PathCommand[] = [{ type: 'move', ...first }];
  for (let index = 0; index < points.length; index++) {
    const from = points[index], to = points[(index + 1) % points.length];
    const destination = scaled(to);
    if (from.out || to.in) {
      const control1 = scaled(from.out ?? from), control2 = scaled(to.in ?? to);
      commands.push({ type: 'cubic', x1: control1.x, y1: control1.y, x2: control2.x, y2: control2.y, ...destination });
    } else commands.push({ type: 'line', ...destination });
  }
  commands.push({ type: 'close' });
  return commands;
}

export function shapePathSvg(path: ShapePath, width: number, height: number): string {
  return [path, ...(path.holes ?? [])].flatMap(contour => shapePathCommands(contour, width, height)).map(command => {
    if (command.type === 'close') return 'Z';
    if (command.type === 'cubic') return `C ${command.x1} ${command.y1} ${command.x2} ${command.y2} ${command.x} ${command.y}`;
    return `${command.type === 'move' ? 'M' : 'L'} ${command.x} ${command.y}`;
  }).join(' ');
}

/** Hit testing shares the renderer's path commands, including curved edges.
 * Subdivision is limited to the local edge rather than depending on canvas state. */
function pointInContour(path: ShapeContour, width: number, height: number, x: number, y: number): boolean {
  const outline:{x:number;y:number}[]=[];
  let previous={x:0,y:0};
  for(const command of shapePathCommands(path,width,height)){
    if(command.type==='move'||command.type==='line'){
      previous={x:command.x,y:command.y};outline.push(previous);
    }else if(command.type==='cubic'){
      const from=previous;
      for(let step=1;step<=16;step++){
        const t=step/16,u=1-t;
        outline.push({x:u*u*u*from.x+3*u*u*t*command.x1+3*u*t*t*command.x2+t*t*t*command.x,y:u*u*u*from.y+3*u*u*t*command.y1+3*u*t*t*command.y2+t*t*t*command.y});
      }
      previous={x:command.x,y:command.y};
    }
  }
  let inside=false;
  for(let index=0,j=outline.length-1;index<outline.length;j=index++){
    const a=outline[index],b=outline[j];
    if((a.y>y)!==(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)inside=!inside;
  }
  return inside;
}

export function pointInShapePath(path:ShapePath,width:number,height:number,x:number,y:number):boolean{
  return pointInContour(path,width,height,x,y) && !(path.holes ?? []).some(hole=>pointInContour(hole,width,height,x,y));
}
