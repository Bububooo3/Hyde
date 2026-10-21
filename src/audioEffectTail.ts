import type { AudioEffect } from './model';
import { AUDIO_EFFECT_BOUNDS, boundedAudioEffect, MAX_AUDIO_EFFECTS, MAX_EFFECT_TAIL } from './audioEffects';

/** The finite audible history used by export and seek reconstruction matches
 * the bounds and chain limit of the live Web Audio effect graph. */
export function clipEffectTail(effects: readonly AudioEffect[] | undefined): number {
  let tail = 0;
  for (const raw of (effects ?? []).slice(0, MAX_AUDIO_EFFECTS)) {
    if (!raw?.enabled || !Object.hasOwn(AUDIO_EFFECT_BOUNDS, raw.type)) continue;
    const effect = boundedAudioEffect(raw);
    switch (effect.type) {
      case 'echo': {
        const repeats = effect.feedback > 0 ? Math.ceil(Math.log(.025) / Math.log(effect.feedback)) : 1;
        tail += effect.delay * Math.max(1, repeats);
        break;
      }
      case 'chorus': tail += effect.delay + effect.depth; break;
      case 'reverb': tail += effect.seconds; break;
    }
    tail = Math.min(MAX_EFFECT_TAIL, tail);
  }
  return tail;
}
