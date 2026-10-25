import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import { uid } from './model';
import type { Assembly, Asset, Project, StoryElement } from './model';
import { remapAnimationAssetIds, remapAssemblyClipReferences } from './assemblyClips';
import { rekeyMotionBehaviors } from './motion';
import { browserAssetDigest, pruneBrowserAssets, readBrowserAsset, removeBrowserAsset, validBrowserAssetRef, writeBrowserAsset } from './browserRecoveryAssets';
import type { BrowserAssetRef } from './browserRecoveryAssets';
import { check, decodeAssemblyBytes, decodeProjectBytes, encodeAssemblyBytes, encodeProjectBytes, number, record, string, validateDocument as validate } from './archive';
import type { RecordValue } from './archive';

async function readBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.')); reader.readAsArrayBuffer(blob);
  });
}
export async function saveProjectBlob(project: Project): Promise<Blob> { return new Blob([encodeProjectBytes(project).buffer as ArrayBuffer], { type: 'application/zip' }); }
export async function loadProjectFile(file: File): Promise<Project> { if (!/\.(hyde|hy)$/i.test(file.name)) throw new Error('Hyde: Choose a .hyde or .hy project file.'); return decodeProjectBytes(await readBytes(file)); }
export async function saveAssemblyBlob(assembly: Assembly): Promise<Blob> { return new Blob([encodeAssemblyBytes(assembly).buffer as ArrayBuffer], { type: 'application/zip' }); }
export async function loadAssemblyFile(file: File): Promise<Assembly> { if (!/\.hyproj$/i.test(file.name)) throw new Error('Hyde: Choose a .hyproj assembly file.'); return decodeAssemblyBytes(await readBytes(file)); }

/** Import is intentionally a local independent copy. Reuse an asset only when
 * its bytes and playback/license meaning are identical. */
export function importAssembly(project: Project, assembly: Assembly): Project {
  validate(project, false); validate(assembly, true);
  const assetIds = new Map<string, string>(), elementIds = new Map(assembly.elements.map(element => [element.id, uid()]));
  const assets: Asset[] = [...project.assets];
  for (const asset of assembly.assets) {
    const existing = assets.find(candidate => candidate.kind === asset.kind && candidate.mime === asset.mime &&
      candidate.dataUrl === asset.dataUrl && candidate.duration === asset.duration && candidate.licenseNotice === asset.licenseNotice);
    if (existing) assetIds.set(asset.id, existing.id);
    else { const next = { ...structuredClone(asset), id: uid() }; assets.push(next); assetIds.set(asset.id, next.id); }
  }
  const elements = assembly.elements.map(element => {
    const next = structuredClone(element);
    next.id = elementIds.get(element.id)!;
    delete next.folderId;
    delete next.sceneId;
    if (next.parentId) next.parentId = elementIds.get(next.parentId)!;
    if (next.attachment) next.attachment.parentId = elementIds.get(next.attachment.parentId)!;
    if (next.assetId) next.assetId = assetIds.get(next.assetId)!;
    remapAnimationAssetIds(next,assetIds);
    if (next.flowAroundId) next.flowAroundId = elementIds.get(next.flowAroundId)!;
    for (const track of next.tracks) for (const key of track.keyframes) key.id = uid();
    rekeyMotionBehaviors(next.motionBehaviors);
    remapAssemblyClipReferences(next, elementIds);
    return next;
  });
  return { ...project, assets, elements: [...project.elements, ...elements], updatedAt: new Date().toISOString() };
}

const RECOVERY_LIMIT = 10;
const EXTERNAL_ASSET_LENGTH = 256 * 1024;
const ASSET_GRACE_MS = 24 * 60 * 60 * 1000;
interface RecoveryEntryBase { format: 'hyde-recovery'; order: number; savedAt: number; project: Project }
interface RecoveryEntryV1 extends RecoveryEntryBase { version: 1 }
interface RecoveryEntryV2 extends RecoveryEntryBase { version: 2; assetRefs: BrowserAssetRef[] }
type RecoveryEntry = RecoveryEntryV1 | RecoveryEntryV2;
interface RecoverySchema extends DBSchema {
  recovery: { key: string; value: RecoveryEntry | Project };
}
const recoveryKey = (id: string) => `project:${id}`;
const recoveryRefs = (entry: RecoveryEntry): BrowserAssetRef[] => entry.version === 2 ? entry.assetRefs : [];
function validateRecoveryEntry(value: unknown): RecoveryEntry {
  check(record(value) && value.format === 'hyde-recovery' && (value.version === 1 || value.version === 2), 'Invalid browser recovery entry.');
  check(Number.isSafeInteger(value.order) && Number(value.order) > 0, 'Invalid browser recovery order.');
  number(value.savedAt, 'Recovery save time', 0);
  if (value.version === 1) { validate(value.project, false); return value as unknown as RecoveryEntryV1; }
  check(record(value.project) && Array.isArray(value.project.assets) && Array.isArray(value.assetRefs), 'Invalid browser recovery asset references.');
  const refs = value.assetRefs as unknown[];
  const ids = new Set<string>(), keys = new Set<string>();
  for (const ref of refs) {
    check(validBrowserAssetRef(ref), 'Invalid browser recovery asset reference.');
    check(!ids.has(ref.assetId) && !keys.has(ref.key), 'Repeated browser recovery asset reference.');
    ids.add(ref.assetId); keys.add(ref.key);
  }
  const project = value.project as RecordValue;
  const assets = project.assets as unknown[];
  const validatedAssets = assets.map(asset => {
    if (!record(asset) || !ids.has(String(asset.id))) return asset;
    check(asset.dataUrl === '', 'External browser recovery asset must have an empty inline value.');
    return { ...asset, dataUrl: 'data:application/octet-stream;base64,' };
  });
  for (const id of ids) check(assets.some(asset => record(asset) && asset.id === id), 'Browser recovery asset refers to a missing asset.');
  validate({ ...project, assets: validatedAssets }, false);
  return value as unknown as RecoveryEntryV2;
}
function recoveryEntries(values: unknown[]): RecoveryEntry[] {
  return values.map(validateRecoveryEntry).sort((a, b) => b.order - a.order || b.savedAt - a.savedAt || a.project.id.localeCompare(b.project.id));
}
async function database(): Promise<IDBPDatabase<RecoverySchema>> {
  let connection: IDBPDatabase<RecoverySchema> | undefined;
  connection = await openDB<RecoverySchema>('hyde-local', 2, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      // openDB rejects on an aborted upgrade; consume the separate transaction
      // completion promise as well, so the same failure is not unhandled.
      void transaction.done.catch(() => {});
      if (!db.objectStoreNames.contains('recovery')) db.createObjectStore('recovery');
      if (oldVersion === 1) {
        // A versionchange transaction makes legacy migration all-or-nothing.
        // Keep the existing store, so an aborted upgrade leaves v1 recovery safe.
        void transaction.objectStore('recovery').get('latest').then(async legacy => {
          if (!legacy) return;
          validate(legacy, false);
          const project = legacy as Project;
          const savedAt = Date.parse(project.updatedAt);
          await transaction.objectStore('recovery').put({ format: 'hyde-recovery', version: 1, order: 1, savedAt: Number.isFinite(savedAt) ? Math.max(0, savedAt) : Date.now(), project }, recoveryKey(project.id));
          await transaction.objectStore('recovery').delete('latest');
        }).catch(() => { try { transaction.abort(); } catch { /* already aborted */ } });
      }
    },
    blocking() { connection?.close(); },
  });
  return connection;
}

/** Save and retention share one readwrite transaction. Failed/quota-limited
 * saves cannot evict older recovery copies or leave a partial recent list.
 * A transactional order, rather than project.updatedAt or wall time, makes
 * concurrent saves and projects imported from another device sort reliably. */
export async function saveAutosave(project: Project): Promise<void> {
  validate(project, false);
  const snapshot = structuredClone(project);
  const db = await database();
  const created: BrowserAssetRef[] = [];
  try {
    const priorValue = await db.get('recovery', recoveryKey(snapshot.id));
    const prior = priorValue ? validateRecoveryEntry(priorValue) : null;
    const refs: BrowserAssetRef[] = [];
    for (const asset of snapshot.assets) {
      if (asset.dataUrl.length < EXTERNAL_ASSET_LENGTH) continue;
      const dataUrl = asset.dataUrl;
      const digest = await browserAssetDigest(dataUrl).catch(() => undefined);
      const old = prior && recoveryRefs(prior).find(ref => ref.assetId === asset.id);
      let ref: BrowserAssetRef | undefined;
      // A one-day reuse limit keeps a concurrent tab from reviving a key that
      // another tab is eligible to remove as an orphan.
      if (old && old.createdAt >= Date.now() - ASSET_GRACE_MS) {
        if (digest && old.digest === digest) ref = old;
        else if (await readBrowserAsset(old).then(saved => saved === dataUrl).catch(() => false)) ref = old;
      }
      if (!ref) { ref = await writeBrowserAsset(asset.id, dataUrl, digest); created.push(ref); }
      refs.push(ref);
      asset.dataUrl = '';
    }
    const transaction = db.transaction('recovery', 'readwrite');
    const completion = transaction.done;
    void completion.catch(() => {});
    try {
      const existing = recoveryEntries(await transaction.store.getAll());
      const order = (existing[0]?.order ?? 0) + 1;
      check(Number.isSafeInteger(order), 'Browser recovery order exceeded its supported range.');
      const entry: RecoveryEntry = refs.length
        ? { format: 'hyde-recovery', version: 2, order, savedAt: Date.now(), project: snapshot, assetRefs: refs }
        : { format: 'hyde-recovery', version: 1, order, savedAt: Date.now(), project: snapshot };
      const retained = [entry, ...existing.filter(value => value.project.id !== snapshot.id)];
      await transaction.store.put(entry, recoveryKey(snapshot.id));
      for (const expired of retained.slice(RECOVERY_LIMIT)) await transaction.store.delete(recoveryKey(expired.project.id));
      await completion;
    } catch (error) {
      try { transaction.abort(); } catch { /* transaction may already have aborted */ }
      await completion.catch(() => {});
      throw error;
    }
  } catch (error) {
    await Promise.allSettled(created.map(removeBrowserAsset));
    throw error;
  } finally { db.close(); }
  await schedulePrune();
}
async function hydrateRecovery(entry: RecoveryEntry): Promise<Project> {
  if (entry.version === 1) return entry.project;
  const project = structuredClone(entry.project);
  for (const ref of entry.assetRefs) {
    const asset = project.assets.find(candidate => candidate.id === ref.assetId);
    check(asset, 'Browser recovery asset refers to a missing asset.');
    asset.dataUrl = await readBrowserAsset(ref);
    if (ref.digest) {
      const actual = await browserAssetDigest(asset.dataUrl).catch(() => undefined);
      check(!actual || actual === ref.digest, 'A browser recovery asset failed its integrity check.');
    }
  }
  validate(project, false);
  return project;
}
/** Newest first; callers receive detached snapshots, never a mutable cache. */
export async function listAutosaves(): Promise<Project[]> {
  const db = await database();
  let entries: RecoveryEntry[];
  try { entries = recoveryEntries(await db.getAll('recovery')); }
  finally { db.close(); }
  return Promise.all(entries.map(hydrateRecovery));
}
export async function loadAutosave(): Promise<Project | null> {
  return (await listAutosaves())[0] ?? null;
}
/** Remove browser recovery only. Explicitly downloaded project files are not
 * touched; subsequent edits to the same project may create a new autosave. */
export async function deleteAutosave(id: string): Promise<void> {
  string(id, 'Project ID');
  const db = await database();
  try { await db.delete('recovery', recoveryKey(id)); }
  finally { db.close(); }
  await schedulePrune();
}
/** Remove orphaned payloads after a grace period, never touching data still
 * referenced by a recovery snapshot. Safe to call during ordinary editor use. */
export async function pruneAutosaveAssets(): Promise<void> {
  const db = await database();
  let entries: RecoveryEntry[];
  try { entries = recoveryEntries(await db.getAll('recovery')); }
  finally { db.close(); }
  const live = new Set(entries.flatMap(entry => recoveryRefs(entry).map(ref => ref.key)));
  await pruneBrowserAssets(live, Date.now() - ASSET_GRACE_MS);
}
let lastPrune = 0;
async function schedulePrune(): Promise<void> {
  if (Date.now() - lastPrune < 60_000) return;
  lastPrune = Date.now();
  await pruneAutosaveAssets().catch(() => { lastPrune = 0; });
}
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
