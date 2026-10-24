import { randomUUID } from 'node:crypto';
import { copyFile, link, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Commit a complete file, retaining the previous destination as a recoverable backup. */
export async function atomicWrite(destination: string, bytes: Uint8Array, overwrite: 'backup' | 'fail' = 'backup',
  hooks?: { beforeCommit?: () => Promise<void> | void }): Promise<{ output: string; backup?: string }> {
  const target = resolve(destination), folder = dirname(target);
  const temporary = resolve(folder, `.${basename(target)}.${randomUUID()}.tmp`);
  let backup: string | undefined;
  try {
    if (overwrite === 'fail' && await exists(target)) throw new Error(`OUTPUT_EXISTS: ${basename(target)} already exists.`);
    await writeFile(temporary, bytes, { flag: 'wx' });
    if (overwrite === 'fail') {
      // A hard link commits the finished temporary file without an overwrite race.
      try { await link(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`OUTPUT_EXISTS: ${basename(target)} already exists.`);
        if (!['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        // Some restricted Windows filesystems disallow links. Exclusive copy
        // preserves the no-clobber guarantee in that environment.
        try { await copyFile(temporary, target, constants.COPYFILE_EXCL); }
        catch (copyError) {
          if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`OUTPUT_EXISTS: ${basename(target)} already exists.`);
          throw copyError;
        }
      }
      return { output: basename(target) };
    }
    if (await exists(target)) {
      backup = resolve(folder, `${basename(target)}.${randomUUID()}.bak`);
      // Copy first so an interrupted write leaves the previous document at its
      // ordinary path. The final rename replaces it only after the new bytes
      // and recoverable backup are complete.
      await copyFile(target, backup, constants.COPYFILE_EXCL);
    }
    await hooks?.beforeCommit?.();
    try { await rename(temporary, target); }
    catch (error) {
      // Windows filesystems can reject rename-over-existing. Keep the copied
      // backup and use a short guarded replacement only on those filesystems.
      if (!backup || !['EPERM', 'EACCES', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '') || !await exists(target)) throw error;
      const displaced = resolve(folder, `.${basename(target)}.${randomUUID()}.previous`);
      await rename(target, displaced);
      try { await rename(temporary, target); }
      catch (commitError) {
        try { await rename(displaced, target); } catch { /* The backup and displaced file remain recoverable. */ }
        throw commitError;
      }
      await rm(displaced, { force: true }).catch(() => undefined);
    }
    return { output: basename(target), ...(backup ? { backup: basename(backup) } : {}) };
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

export async function readLimitedFile(path: string, maxBytes: number): Promise<Uint8Array> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error(`RESOURCE_LIMIT: ${basename(path)} exceeds the file size limit.`);
  return readFile(path);
}
