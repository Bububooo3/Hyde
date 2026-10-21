import type {StoryElement} from './model';
import {audioBufferFromPcm,pcmFromAudioBuffer,processPitchTime} from './pitchTime';

export interface AudioPitchPlan {
  /** Source seconds consumed for one second of rendered PCM. */
  processSpeed:number;
  /** Web Audio playback rate after optional processing. */
  playbackRate:number;
  pitchSemitones:number;
  processed:boolean;
}

/** One plan drives editor playback, standalone playback, and video export audio. */
export function audioPitchPlan(element:Pick<StoryElement,'speed'|'pitchSemitones'|'linkSpeedPitch'>):AudioPitchPlan {
  const speed=Math.min(4,Math.max(.25,element.speed??1));
  const pitchSemitones=Math.min(24,Math.max(-24,element.pitchSemitones??0));
  const linked=element.linkSpeedPitch!==false;
  const processSpeed=linked?1:speed;
  return {processSpeed,playbackRate:linked?speed:1,pitchSemitones,processed:processSpeed!==1||pitchSemitones!==0};
}

/** Convert original source seconds to seconds in the prepared AudioBuffer. */
export function preparedSourceTime(originalSeconds:number,plan:AudioPitchPlan):number {
  return originalSeconds/plan.processSpeed;
}

export async function prepareAudioBuffer(context:BaseAudioContext,source:AudioBuffer,plan:AudioPitchPlan,signal?:AbortSignal):Promise<AudioBuffer> {
  if(!plan.processed)return source;
  const pcm=await processPitchTime(pcmFromAudioBuffer(source),{speed:plan.processSpeed,pitchSemitones:plan.pitchSemitones,signal});
  return audioBufferFromPcm(context,pcm);
}
