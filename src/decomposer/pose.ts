import type { Project } from '../model';
import type { HydeDecompositionExport } from './export';

export interface TemporaryPartPose {
  /** Offset from the construction pose: degrees for a hinge, parent-local X pixels for a slider. */
  value: number;
  appliedValue: number;
  project: Project;
}

/** Produce a disposable Hyde render input. The source document and exported construction pose never change. */
export function poseNativeDecomposition(exported: Pick<HydeDecompositionExport, 'project' | 'mapping'>, partId: string, value: number): TemporaryPartPose {
  if (!Number.isFinite(value) || Math.abs(value) > 10_000) throw new Error('Temporary joint pose must be a finite value within 10,000 units.');
  const nativeId = exported.mapping.partIds[partId];
  if (!nativeId) throw new Error(`Part ${partId} has no native Hyde group.`);
  const project = structuredClone(exported.project);
  const group = project.elements.find(element => element.id === nativeId);
  if (!group || group.kind !== 'group' || !group.attachment) throw new Error(`Part ${partId} has no attached native Hyde group.`);
  const { type, min, max } = group.attachment;
  if (type === 'fixed') throw new Error('A Fixed attachment has no temporary joint degree of freedom.');
  const lower = min ?? -Infinity, upper = max ?? Infinity;
  if (type === 'hinge') {
    const rotation = Math.min(upper, Math.max(lower, group.rotation + value));
    const appliedValue = rotation - group.rotation;
    group.rotation = rotation;
    return { project, value, appliedValue };
  }
  const appliedValue = Math.min(upper, Math.max(lower, value));
  group.x += appliedValue;
  return { project, value, appliedValue };
}
