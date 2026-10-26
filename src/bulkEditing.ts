import { evaluateElement } from './engine';
import { parentId, worldPoses } from './editing';
import { uid, type AnimProperty, type Project, type StoryElement } from './model';
import { resizeElementGeometry } from './shapePath';

export type BulkProperty = 'x' | 'y' | 'width' | 'height' | 'rotation' | 'scaleX' | 'scaleY' |
  'opacity' | 'fill' | 'stroke' | 'strokeWidth' | 'mediaOpacity' | 'shadowX' | 'shadowY' | 'shadowBlur' | 'shadowSize';
export type BulkMode = 'absolute' | 'relative';
export type BulkEditResult = { project: Project; applied: string[]; skipped: { id: string; reason: string }[] };

function poseKey(project: Project, element: StoryElement, property: AnimProperty, value: number | string, time: number): void {
  let track = element.tracks.find(candidate => candidate.property === property);
  if (!track) { track = { property, keyframes: [] }; element.tracks.push(track); }
  const at = Math.max(0, Math.min(element.duration, Math.round((time - element.start) * project.fps) / project.fps));
  const existing = track.keyframes.find(key => Math.abs(key.time - at) < .000001);
  if (existing) existing.value = value;
  else track.keyframes.push({ id: uid(), time: at, value, easing: 'linear', direction: 'inOut', mode: 'smooth' });
  track.keyframes.sort((a, b) => a.time - b.time);
}

function setPoseValue(project: Project, element: StoryElement, property: AnimProperty, value: number | string, time: number, recordKeys: boolean): void {
  if (recordKeys || element.tracks.some(track => track.property === property && track.keyframes.length)) poseKey(project, element, property, value, time);
  else Object.assign(element, { [property]: value });
}

function numberValue(value: number | string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new RangeError('Choose a finite value.');
  return numeric;
}

/** A single project transaction for compatible members of a selection.
 * Relative position uses stage coordinates even inside a rotated assembly. */
export function applyBulkProperty(project: Project, ids: readonly string[], property: BulkProperty, value: number | string, mode: BulkMode, time: number, recordKeys = false): BulkEditResult {
  const next = structuredClone(project), applied: string[] = [], skipped: BulkEditResult['skipped'] = [];
  const selected = new Set(ids);
  const poses = worldPoses(project, time);
  const numeric = property === 'fill' || property === 'stroke' ? 0 : numberValue(value);
  for (const element of next.elements) {
    if (!selected.has(element.id)) continue;
    if (element.locked) { skipped.push({ id: element.id, reason: 'locked' }); continue; }
    if (['fill','stroke','strokeWidth','opacity','mediaOpacity','shadowX','shadowY','shadowBlur','shadowSize'].includes(property) && ['audio','group'].includes(element.kind)) {
      skipped.push({ id: element.id, reason: 'no visual appearance' }); continue;
    }
    if (['width','height','scaleX','scaleY'].includes(property) && ['audio','group'].includes(element.kind)) {
      skipped.push({ id: element.id, reason: 'no editable dimensions' }); continue;
    }
    if ((property === 'x' || property === 'y') && element.attachment) {
      skipped.push({ id: element.id, reason: 'position constrained by attachment' }); continue;
    }
    if (property === 'rotation' && element.attachment && element.attachment.type !== 'hinge') {
      skipped.push({ id: element.id, reason: 'rotation constrained by attachment' }); continue;
    }
    const local = evaluateElement(element, time) ?? element;
    const world = poses.get(element.id) ?? local;
    if (property === 'x' || property === 'y') {
      const dx = property === 'x' ? (mode === 'relative' ? numeric : numeric - world.x) : 0;
      const dy = property === 'y' ? (mode === 'relative' ? numeric : numeric - world.y) : 0;
      const parent = parentId(element) ? poses.get(parentId(element)!) : undefined;
      const r = -(parent?.rotation ?? 0) * Math.PI / 180;
      const lx = parent ? (dx * Math.cos(r) - dy * Math.sin(r)) / parent.scaleX : dx;
      const ly = parent ? (dx * Math.sin(r) + dy * Math.cos(r)) / parent.scaleY : dy;
      if (!Number.isFinite(lx) || !Number.isFinite(ly)) { skipped.push({ id: element.id, reason: 'invalid parent transform' }); continue; }
      setPoseValue(next, element, 'x', local.x + lx, time, recordKeys);
      setPoseValue(next, element, 'y', local.y + ly, time, recordKeys);
    } else if (property === 'width' || property === 'height') {
      const size = Math.max(1, mode === 'relative' ? element[property] + numeric : numeric);
      resizeElementGeometry(element, property === 'width' ? size : element.width, property === 'height' ? size : element.height);
    } else if (property === 'rotation') {
      let angle = mode === 'relative' ? local.rotation + numeric : numeric;
      if (element.attachment?.type === 'hinge') angle = Math.max(element.attachment.min ?? -180, Math.min(element.attachment.max ?? 180, angle));
      setPoseValue(next, element, 'rotation', angle, time, recordKeys);
    } else if (property === 'scaleX' || property === 'scaleY') {
      const scale = mode === 'relative' ? local[property] + numeric : numeric;
      if (Math.abs(scale) < .01) { skipped.push({ id: element.id, reason: 'scale too small' }); continue; }
      setPoseValue(next, element, property, scale, time, recordKeys);
    } else if (property === 'opacity' || property === 'mediaOpacity') {
      const current = property === 'opacity' ? local.opacity : element.mediaOpacity ?? 1;
      const opacity = Math.max(0, Math.min(1, mode === 'relative' ? current + numeric : numeric));
      if (property === 'opacity') setPoseValue(next, element, property, opacity, time, recordKeys);
      else element.mediaOpacity = opacity;
    } else if (property === 'fill') setPoseValue(next, element, 'fill', String(value), time, recordKeys);
    else if (property === 'stroke') element.stroke = String(value);
    else if (property === 'strokeWidth') element.strokeWidth = Math.max(0, mode === 'relative' ? element.strokeWidth + numeric : numeric);
    else if (property === 'shadowSize') element.shadow.size = mode === 'relative' ? (element.shadow.size ?? 0) + numeric : numeric;
    else {
      const key = property === 'shadowX' ? 'x' : property === 'shadowY' ? 'y' : 'blur';
      element.shadow[key] = key === 'blur' ? Math.max(0, mode === 'relative' ? element.shadow[key] + numeric : numeric) : mode === 'relative' ? element.shadow[key] + numeric : numeric;
    }
    applied.push(element.id);
  }
  return { project: applied.length ? next : project, applied, skipped };
}
