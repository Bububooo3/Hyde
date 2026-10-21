export interface HydeFileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }>;
}

type PickerWindow = Window & {
  showOpenFilePicker?: (options?: unknown) => Promise<HydeFileHandle[]>;
  showSaveFilePicker?: (options?: unknown) => Promise<HydeFileHandle>;
};

export function canWriteProjectFile(): boolean {
  return typeof (window as PickerWindow).showSaveFilePicker === 'function';
}

export async function chooseProjectToOpen(): Promise<HydeFileHandle | null> {
  const picker = (window as PickerWindow).showOpenFilePicker;
  if (!picker) return null;
  const [handle] = await picker({ multiple: false, types: [{ description: 'Hyde project', accept: { 'application/octet-stream': ['.hyde', '.hy'] } }] });
  return handle ?? null;
}

export async function chooseProjectSaveFile(name: string): Promise<HydeFileHandle | null> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (!picker) return null;
  return picker({ suggestedName: name, types: [{ description: 'Hyde project', accept: { 'application/octet-stream': ['.hyde', '.hy'] } }] });
}

export async function writeProjectFile(handle: HydeFileHandle, data: Blob): Promise<void> {
  const stream = await handle.createWritable();
  try { await stream.write(data); await stream.close(); }
  catch (error) { await stream.abort?.(); throw error; }
}
