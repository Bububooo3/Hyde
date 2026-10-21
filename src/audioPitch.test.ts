import {describe,expect,it} from 'vitest';
import {audioPitchPlan,preparedSourceTime} from './audioPitch';

describe('audio speed and pitch linking',()=>{
  it('retains the original Web Audio rate for older clips',()=>{
    expect(audioPitchPlan({speed:2})).toEqual({processSpeed:1,playbackRate:2,pitchSemitones:0,processed:false});
  });
  it('adds independent pitch on top of a linked speed',()=>{
    expect(audioPitchPlan({speed:2,pitchSemitones:7,linkSpeedPitch:true})).toEqual({processSpeed:1,playbackRate:2,pitchSemitones:7,processed:true});
  });
  it('preserves pitch when speed is unlinked and maps source offsets',()=>{
    const plan=audioPitchPlan({speed:2,pitchSemitones:-3,linkSpeedPitch:false});
    expect(plan).toEqual({processSpeed:2,playbackRate:1,pitchSemitones:-3,processed:true});
    expect(preparedSourceTime(8,plan)).toBe(4);
  });
});
