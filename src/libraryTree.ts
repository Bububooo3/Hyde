export interface LibraryFile {
  file: File;
  name: string;
  path: string;
}

export interface LibraryFolder {
  name: string;
  path: string;
  folders: LibraryFolder[];
  files: LibraryFile[];
  fileCount: number;
}

const handlePaths = new WeakMap<File,string>();

/** Directory handles do not populate webkitRelativePath. Keep the path only
 * for this browser session so imported files remain ordinary File objects. */
export function registerLibraryPath(file:File,path:string):void {
  handlePaths.set(file,path.replaceAll('\\','/'));
}

export function libraryPath(file: File): string {
  return (handlePaths.get(file) || file.webkitRelativePath || file.name).replaceAll('\\', '/');
}

export function supportedLibraryFile(file: File): boolean {
  return /\.(hyproj|mp3|m4a|aac|wav|wave|ogg|oga|opus|flac)$/i.test(file.name) || file.type.toLowerCase().startsWith('audio/');
}

export function folderDepth(file: File): number {
  return Math.max(0, libraryPath(file).split('/').filter(Boolean).length - 1);
}

export function buildLibraryTree(files: readonly File[]): LibraryFolder {
  const root: LibraryFolder = { name: '', path: '', folders: [], files: [], fileCount: 0 };
  const folders = new Map<string, LibraryFolder>([['', root]]);

  for (const file of files.filter(supportedLibraryFile)) {
    const parts = libraryPath(file).split('/').filter(Boolean);
    if (!parts.length) continue;
    let parent = root;
    for (const name of parts.slice(0, -1)) {
      const path = parent.path ? `${parent.path}/${name}` : name;
      let folder = folders.get(path);
      if (!folder) {
        folder = { name, path, folders: [], files: [], fileCount: 0 };
        parent.folders.push(folder);
        folders.set(path, folder);
      }
      parent = folder;
    }
    parent.files.push({ file, name: parts.at(-1)!, path: libraryPath(file) });
  }

  const compareNames = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  function sort(folder: LibraryFolder) {
    folder.folders.sort(compareNames).forEach(sort);
    folder.files.sort(compareNames);
    folder.fileCount = folder.files.length + folder.folders.reduce((count, child) => count + child.fileCount, 0);
  }
  sort(root);
  return root;
}
