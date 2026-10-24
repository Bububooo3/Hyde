// @vitest-environment node
import { expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './atomicFile';
import { encodePng } from './decomposer/image';
import { DecompositionSession } from './decomposer/session';

it('keeps the previous .hydecomp at its path if replacement stops before commit', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.hyde-atomic-document-'));
  try {
    const width = 16, height = 16, rgba = new Uint8Array(width * height * 4);
    for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) rgba.set([180, 65, 42, 255], (y * width + x) * 4);
    const session = await DecompositionSession.importSources([{ bytes: encodePng({ width, height, rgba }), name: 'tile.png', mime: 'image/png' }]);
    await session.analyze();
    const path = join(directory, 'drawing.hydecomp'), previous = await session.saveDocument();
    await writeFile(path, previous);
    const partId = session.snapshot().parts[0].id;
    expect((await session.execute({ expectedRevision: session.revision, edits: [{ op: 'part.rename', partId, name: 'Renamed part' }] })).ok).toBe(true);
    const next = await session.saveDocument();
    await expect(atomicWrite(path, next, 'backup', { beforeCommit: () => { throw new Error('simulated interruption'); } })).rejects.toThrow('simulated interruption');
    expect(new Uint8Array(await readFile(path))).toEqual(previous);
    const interruptedFiles = await readdir(directory);
    expect(interruptedFiles.filter(name => name.endsWith('.tmp'))).toHaveLength(0);
    const firstBackup = interruptedFiles.find(name => name.endsWith('.bak'))!;
    expect(new Uint8Array(await readFile(join(directory, firstBackup)))).toEqual(previous);
    const recovered = await DecompositionSession.openDocument(new Uint8Array(await readFile(path)));
    expect(recovered.snapshot().parts[0].name).not.toBe('Renamed part');
    await recovered.close();
    const result = await atomicWrite(path, next, 'backup');
    expect(result.backup).toMatch(/\.bak$/);
    const committed = await DecompositionSession.openDocument(new Uint8Array(await readFile(path)));
    expect(committed.snapshot().parts[0].name).toBe('Renamed part');
    await committed.close();
    await session.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
