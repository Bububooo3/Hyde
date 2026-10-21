import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import { uid } from './model';

export interface BrowserAssetRef {
  assetId: string;
  key: string;
  backend: 'opfs' | 'indexeddb';
  createdAt: number;
  digest?: string;
}

interface AssetSchema extends DBSchema {
  assets: { key: string; value: { dataUrl: string; createdAt: number } };
}

const DIRECTORY = 'hyde-recovery-assets';
const KEY_PATTERN = /^a-[0-9a-f-]{36}$/;

async function database(): Promise<IDBPDatabase<AssetSchema>> {
  let connection: IDBPDatabase<AssetSchema> | undefined;
  connection = await openDB<AssetSchema>('hyde-recovery-assets', 1, {
    upgrade(db) { if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets'); },
    blocking() { connection?.close(); },
  });
  return connection;
}

async function directory(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const storage = globalThis.navigator?.storage;
  if (!storage?.getDirectory) return null;
  return (await storage.getDirectory()).getDirectoryHandle(DIRECTORY, { create });
}

/** A digest lets unchanged assets keep their private-store key across edits. */
export async function browserAssetDigest(dataUrl: string): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dataUrl));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function readBrowserAsset(ref: BrowserAssetRef): Promise<string> {
  if (ref.backend === 'opfs') {
    const folder = await directory(false);
    if (!folder) throw new Error('Hyde: Browser recovery needs file storage that is unavailable in this browser.');
    try { return await (await (await folder.getFileHandle(ref.key)).getFile()).text(); }
    catch { throw new Error('Hyde: A browser recovery asset is missing or unreadable.'); }
  }
  const db = await database();
  try {
    const value = await db.get('assets', ref.key);
    if (!value || typeof value.dataUrl !== 'string') throw new Error('Hyde: A browser recovery asset is missing.');
    return value.dataUrl;
  } finally { db.close(); }
}

export async function writeBrowserAsset(assetId: string, dataUrl: string, digest?: string): Promise<BrowserAssetRef> {
  const ref: BrowserAssetRef = { assetId, key: `a-${uid()}`, backend: 'indexeddb', createdAt: Date.now(), digest };
  let folder: FileSystemDirectoryHandle | null = null;
  try {
    folder = await directory(true);
    if (folder) {
      const handle = await folder.getFileHandle(ref.key, { create: true });
      const writable = await handle.createWritable();
      try { await writable.write(dataUrl); await writable.close(); }
      catch (error) { await writable.abort().catch(() => {}); throw error; }
      ref.backend = 'opfs';
      return ref;
    }
  } catch {
    // Some browsers expose OPFS but deny writes (including private modes).
    if (folder) await folder.removeEntry(ref.key).catch(() => {});
  }
  const db = await database();
  try { await db.put('assets', { dataUrl, createdAt: ref.createdAt }, ref.key); return ref; }
  finally { db.close(); }
}

export async function removeBrowserAsset(ref: BrowserAssetRef): Promise<void> {
  if (ref.backend === 'opfs') {
    const folder = await directory(false);
    if (!folder) return;
    try { await folder.removeEntry(ref.key); }
    catch (error) { if ((error as DOMException)?.name !== 'NotFoundError') throw error; }
  } else {
    const db = await database();
    try { await db.delete('assets', ref.key); } finally { db.close(); }
  }
}

/** A grace period protects another tab that is reading a former snapshot or
 * preparing an edit from it. Keys are never reused once they reach this age. */
export async function pruneBrowserAssets(live: ReadonlySet<string>, cutoff: number): Promise<void> {
  const db = await database();
  try {
    const tx = db.transaction('assets', 'readwrite');
    const [keys, values] = await Promise.all([tx.store.getAllKeys(), tx.store.getAll()]);
    for (let i = 0; i < keys.length; i++) if (!live.has(keys[i]) && values[i].createdAt < cutoff) await tx.store.delete(keys[i]);
    await tx.done;
  } finally { db.close(); }
  const folder = await directory(false).catch(() => null);
  if (!folder) return;
  const iterable = folder as FileSystemDirectoryHandle & AsyncIterable<[string, FileSystemHandle]>;
  if (!iterable[Symbol.asyncIterator]) return;
  for await (const [name, handle] of iterable) {
    if (!KEY_PATTERN.test(name) || handle.kind !== 'file' || live.has(name)) continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    if (file.lastModified < cutoff) await folder.removeEntry(name).catch(error => {
      if ((error as DOMException)?.name !== 'NotFoundError') throw error;
    });
  }
}

export function validBrowserAssetRef(value: unknown): value is BrowserAssetRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Partial<BrowserAssetRef>;
  return typeof ref.assetId === 'string' && !!ref.assetId && typeof ref.key === 'string' && KEY_PATTERN.test(ref.key) &&
    (ref.backend === 'opfs' || ref.backend === 'indexeddb') &&
    typeof ref.createdAt === 'number' && Number.isFinite(ref.createdAt) && ref.createdAt >= 0 &&
    (ref.digest === undefined || (typeof ref.digest === 'string' && /^[0-9a-f]{64}$/.test(ref.digest)));
}
