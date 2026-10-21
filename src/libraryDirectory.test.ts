// @vitest-environment jsdom
import {describe,expect,it} from 'vitest';
import {scanLibraryDirectory,type LibraryDirectoryHandle,type LibraryFileHandle} from './libraryDirectory';
import {buildLibraryTree,libraryPath} from './libraryTree';

function file(name:string,type=''):LibraryFileHandle{
  return {kind:'file',name,async getFile(){return new File(['fixture'],name,{type});}};
}
function folder(name:string,children:(LibraryFileHandle|LibraryDirectoryHandle)[]):LibraryDirectoryHandle{
  return {kind:'directory',name,async *entries(){for(const child of children)yield [child.name,child] as [string,LibraryFileHandle|LibraryDirectoryHandle];}};
}

describe('session directory handle libraries',()=>{
  it('retains the directory tree and only exposes assemblies and audio',async()=>{
    const root=folder('Story pack',[file('readme.txt'),folder('Characters',[file('hero.hyproj'),folder('Voices',[file('line.wav','audio/wav'),file('sketch.png','image/png')])])]);
    const files=await scanLibraryDirectory(root);
    expect(files.map(libraryPath)).toEqual(['Story pack/Characters/hero.hyproj','Story pack/Characters/Voices/line.wav']);
    const tree=buildLibraryTree(files);
    expect(tree.fileCount).toBe(2);
    expect(tree.folders[0].folders[0].folders[0].files[0].name).toBe('line.wav');
  });
  it('uses newly scanned files after refresh without persisting a handle',async()=>{
    const entries:(LibraryFileHandle|LibraryDirectoryHandle)[]=[file('first.wav','audio/wav')];
    const root=folder('Library',entries);
    expect((await scanLibraryDirectory(root)).map(libraryPath)).toEqual(['Library/first.wav']);
    entries.push(file('second.hyproj'));
    expect((await scanLibraryDirectory(root)).map(libraryPath)).toEqual(['Library/first.wav','Library/second.hyproj']);
  });
});
