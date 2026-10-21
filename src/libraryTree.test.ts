import { describe, expect, it } from 'vitest';
import { buildLibraryTree, folderDepth, libraryPath, supportedLibraryFile } from './libraryTree';

function file(path: string, type: string): File {
  return { name: path.split('/').at(-1), webkitRelativePath: path, type } as File;
}

describe('component library tree', () => {
  it('keeps the selected directory structure, folders first, and only relevant files', () => {
    const files = [
      file('Pack/Sounds/10.wav', 'audio/wav'),
      file('Pack/Characters/Zed.hyproj', 'application/octet-stream'),
      file('Pack/Sounds/2.wav', 'audio/wav'),
      file('Pack/Characters/Ada.hyproj', 'application/octet-stream'),
      file('Pack/Notes.txt', 'text/plain'),
    ];
    const tree = buildLibraryTree(files);
    expect(tree.fileCount).toBe(4);
    expect(tree.folders.map(folder => folder.name)).toEqual(['Pack']);
    expect(tree.folders[0].folders.map(folder => folder.name)).toEqual(['Characters', 'Sounds']);
    expect(tree.folders[0].folders[0].files.map(entry => entry.name)).toEqual(['Ada.hyproj', 'Zed.hyproj']);
    expect(tree.folders[0].folders[1].files.map(entry => entry.name)).toEqual(['2.wav', '10.wav']);
    expect(tree.folders[0].files).toEqual([]);
    expect(supportedLibraryFile(files[4])).toBe(false);
    expect(supportedLibraryFile(file('Pack/recording.flac', ''))).toBe(true);
  });

  it('counts folder depth without treating the filename as a folder', () => {
    expect(folderDepth(file('Pack/one.hyproj', 'application/octet-stream'))).toBe(1);
    expect(folderDepth(file('Pack/A/B/C/four.wav', 'audio/wav'))).toBe(4);
    expect(libraryPath(file('Pack/A/clip.wav', 'audio/wav'))).toBe('Pack/A/clip.wav');
  });
});
