// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeAssemblyBytes, decodeProjectBytes } from './archive';
import { runCli } from './cli';

const created: string[] = [];
afterEach(async () => { await Promise.all(created.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixtureDirectory(): Promise<string> {
  const root = join(process.cwd(), 'tmp');
  await mkdir(root, { recursive: true });
  const folder = await mkdtemp(join(root, 'hyde-cli-'));
  created.push(folder);
  return folder;
}

async function call(...args: string[]) {
  let stdout = '', stderr = '';
  const code = await runCli([...args, '--json'], { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
  return { code, stdout: stdout ? JSON.parse(stdout) : undefined, stderr: stderr ? JSON.parse(stderr) : undefined };
}

describe('Hyde Node CLI workflow', () => {
  it('creates, validates, edits, diffs and exchanges a native assembly', async () => {
    const folder = await fixtureDirectory();
    const original = join(folder, 'original.hyde'), revised = join(folder, 'revised.hyde');
    const assembly = join(folder, 'part.hyproj'), imported = join(folder, 'imported.hyde');
    const commandFile = join(folder, 'commands.json');

    const made = await call('project', 'new', '--name', 'CLI story', '--output', original);
    expect(made.code, JSON.stringify(made)).toBe(0);
    expect((await call('project', 'validate', original)).stdout.result.name).toBe('CLI story');
    const first = decodeProjectBytes(await readFile(original));
    await writeFile(commandFile, JSON.stringify([
      { op: 'element.create', args: { alias: '$body', kind: 'rectangle', properties: { name: 'Body', x: 30, y: 40 } } },
      { op: 'element.create', args: { alias: '$head', kind: 'ellipse', properties: { name: 'Head', x: 0, y: -80 } } },
      { op: 'assembly.attach', args: { id: '$head', parentId: '$body', type: 'hinge', min: -30, max: 30 } },
    ]));
    const applied = await call('project', 'apply', original, '--commands', commandFile, '--output', revised);
    expect(applied.code).toBe(0);
    const body = applied.stdout.result.idMap.$body;
    expect(decodeProjectBytes(await readFile(revised)).elements).toHaveLength(2);
    expect((await call('project', 'inspect', revised, '--target', 'elements')).stdout.result.items).toHaveLength(2);
    expect((await call('project', 'diff', original, revised)).stdout.result.added).toContain(`element:${body}`);
    expect(decodeProjectBytes(await readFile(original))).toEqual(first);

    expect((await call('assembly', 'export', revised, '--root', body, '--output', assembly)).code).toBe(0);
    expect((await call('assembly', 'validate', assembly)).stdout.result.elements).toBe(2);
    expect((await call('assembly', 'inspect', assembly)).stdout.result.items).toHaveLength(2);
    expect(decodeAssemblyBytes(await readFile(assembly)).elements).toHaveLength(2);
    expect((await call('assembly', 'import', original, assembly, '--output', imported)).code).toBe(0);
    const placed = decodeProjectBytes(await readFile(imported));
    expect(placed.elements).toHaveLength(2);
    expect(placed.elements.every(item => item.sceneId === placed.sequences[0].id)).toBe(true);

    const doctor = await call('doctor');
    expect(doctor.stdout.result.capabilities.environment).toBe('node');
    expect(doctor.stdout.result.capabilities.preview.frames).toBe(false);
  }, 30_000);

  it('leaves files unchanged after rejected commands and keeps a backup on explicit replacement', async () => {
    const folder = await fixtureDirectory();
    const project = join(folder, 'story.hyde'), commands = join(folder, 'invalid.json');
    const made = await call('project', 'new', '--output', project);
    expect(made.code, JSON.stringify(made)).toBe(0);
    const before = await readFile(project);
    await writeFile(commands, JSON.stringify([{ op: 'element.create', args: { kind: 'not-a-shape' } }]));
    const failed = await call('project', 'apply', project, '--commands', commands, '--output', project);
    expect(failed.code).toBe(2);
    expect(await readFile(project)).toEqual(before);
    const replaced = await call('project', 'new', '--name', 'Replacement', '--output', project);
    expect(replaced.code).toBe(0);
    expect(replaced.stdout.result.backup).toMatch(/\.bak$/);
    expect((await readdir(folder)).some(name => name.endsWith('.bak'))).toBe(true);
    expect(decodeProjectBytes(await readFile(project)).name).toBe('Replacement');
  });
});
