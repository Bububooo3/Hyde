// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement, getDefaultLinkSpeedPitch, setDefaultLinkSpeedPitch } from './model';

describe('default audio pitch link', () => {
  afterEach(() => { localStorage.removeItem('hyde:link-speed-pitch-default'); });

  it('links new audio and video by default while older elements may omit the setting', () => {
    expect(getDefaultLinkSpeedPitch()).toBe(true);
    expect(createElement('audio').linkSpeedPitch).toBe(true);
    expect(createElement('video').linkSpeedPitch).toBe(true);
    expect(createElement('rectangle').linkSpeedPitch).toBeUndefined();
  });

  it('applies the browser preference only to subsequently created media', () => {
    const existing = createElement('audio');
    setDefaultLinkSpeedPitch(false);
    expect(getDefaultLinkSpeedPitch()).toBe(false);
    expect(createElement('audio').linkSpeedPitch).toBe(false);
    expect(createElement('video').linkSpeedPitch).toBe(false);
    expect(existing.linkSpeedPitch).toBe(true);
    setDefaultLinkSpeedPitch(true);
    expect(createElement('audio').linkSpeedPitch).toBe(true);
  });
});
