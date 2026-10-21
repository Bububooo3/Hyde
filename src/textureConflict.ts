import type { AssemblyTextureOverlap } from './model';

export const DEFAULT_TEXTURE_CONFLICT: Readonly<Omit<AssemblyTextureOverlap,'elementId'>> = {
  mode: 'alternate', switchesPerSecond: 4, switchPoint: .5,
};

/** Choose one asset ID during a placed-clip overlap. The alternating cadence
 * uses absolute project time, so seeks and sampled exports resolve to the same
 * texture without retaining playback state or resetting at clip boundaries. */
export function textureDuringOverlap(
  outgoing: string,
  incoming: string,
  projectTime: number,
  overlapStart: number,
  overlapEnd: number,
  setting: Pick<AssemblyTextureOverlap,'mode'|'switchesPerSecond'|'switchPoint'> = DEFAULT_TEXTURE_CONFLICT,
): string {
  if (outgoing === incoming) return outgoing;
  if (setting.mode === 'holdOutgoing') return outgoing;
  if (setting.mode === 'useIncoming') return incoming;
  const progress = Math.max(0, Math.min(1, (projectTime - overlapStart) / (overlapEnd - overlapStart)));
  if (setting.mode === 'single') return progress < setting.switchPoint ? outgoing : incoming;
  const phase = Math.floor(projectTime * setting.switchesPerSecond + 1e-9);
  return phase % 2 === 0 ? outgoing : incoming;
}
