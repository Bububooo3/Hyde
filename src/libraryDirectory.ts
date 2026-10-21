import {registerLibraryPath,supportedLibraryFile} from './libraryTree';

export interface LibraryFileHandle {kind:'file';name:string;getFile():Promise<File>}
export interface LibraryDirectoryHandle {
  kind:'directory';name:string;
  entries():AsyncIterable<[string,LibraryFileHandle|LibraryDirectoryHandle]>;
}

/** Scan only metadata until a candidate is found; files are read when the
 * author previews or inserts them. The handle and paths live for this session. */
export async function scanLibraryDirectory(root:LibraryDirectoryHandle):Promise<File[]> {
  const files:File[]=[];
  async function visit(directory:LibraryDirectoryHandle,path:string,depth:number):Promise<void>{
    if(depth>64)throw new Error('The component library has too many nested folders.');
    for await(const [name,entry] of directory.entries()){
      const next=path?`${path}/${name}`:name;
      if(entry.kind==='directory')await visit(entry,next,depth+1);
      else {
        const file=await entry.getFile();
        if(!supportedLibraryFile(file))continue;
        if(files.length>=10_000)throw new Error('This library exceeds the 10,000 supported-file limit.');
        registerLibraryPath(file,next);files.push(file);
      }
    }
  }
  await visit(root,root.name,0);
  return files;
}
