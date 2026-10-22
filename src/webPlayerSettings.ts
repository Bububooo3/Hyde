import type {Project, WebPlayerSettings} from './model';

/** Existing projects use these defaults without a migration or modified archive. */
export const DEFAULT_WEB_PLAYER_SETTINGS: WebPlayerSettings = {
  posterTime: 0,
  loop: false,
  controlsVisible: true,
  showSeek: true,
  showVolume: true,
  showFullscreen: true,
  showCaptions: true,
  showLoop: true,
};

export function webPlayerSettings(project: Project): WebPlayerSettings {
  return {
    ...DEFAULT_WEB_PLAYER_SETTINGS,
    ...project.webPlayer,
    posterTime: Math.min(finalPlayerFrameTime(project), Math.max(0, project.webPlayer?.posterTime ?? 0)),
  };
}

export function finalPlayerFrameTime(project: Pick<Project,'duration'|'fps'>): number {
  return Math.max(0, project.duration - 1 / project.fps);
}
