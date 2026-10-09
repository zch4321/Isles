import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findClaudeExecutable } from '../src/harness/claude/executable.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isles-claude-discovery-'));
  roots.push(root);
  const file = async (path: string, contents = '') => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, { mode: 0o755 });
    return path;
  };
  return { root, file };
}
const version = async () => '2.1.285 (Claude Code)';

describe('Claude executable discovery', () => {
  it('discovers native local installs when PATH does not contain Claude', async () => {
    const { root, file } = await fixture();
    const binary = await file(join(root, '.local', 'bin', 'claude'));
    expect(
      (
        await findClaudeExecutable(
          { home: root, platform: 'darwin', environment: { PATH: '' } },
          version,
        )
      ).path,
    ).toBe(binary);
  });
  it('honors explicit quoted paths and never falls back from an invalid explicit installation', async () => {
    const { root, file } = await fixture();
    const good = await file(join(root, 'bin', 'claude'));
    const bad = await file(join(root, 'bad'));
    expect(
      (await findClaudeExecutable({ binary: `"${good}"`, environment: { PATH: '' } }, version))
        .path,
    ).toBe(good);
    await expect(
      findClaudeExecutable(
        { binary: bad, environment: { PATH: join(root, 'bin') } },
        async (command) => (command.file === bad ? 'another-program 1.0' : version()),
      ),
    ).rejects.toThrow('配置的 Claude Code 无法运行');
  });
  it('runs JS installs with Node and Windows npm launchers through their package entry without a shell', async () => {
    const { root, file } = await fixture();
    const script = await file(join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
    const launcher = await file(join(root, 'claude.cmd'), '@echo off');
    const executable = await findClaudeExecutable({ binary: launcher, platform: 'win32' }, version);
    expect(executable).toMatchObject({ file: process.execPath, args: [script], path: launcher });
    expect((await findClaudeExecutable({ binary: script }, version)).args).toEqual([
      await realpath(script),
    ]);
  });
  it('rejects Windows launchers whose JS path cannot be resolved safely', async () => {
    const { root, file } = await fixture();
    const launcher = await file(
      join(root, 'claude.cmd'),
      'node "%UNKNOWN%\\@anthropic-ai\\claude-code\\cli.js"',
    );
    await expect(
      findClaudeExecutable({ binary: launcher, platform: 'win32' }, version),
    ).rejects.toThrow('无法运行');
  });
});
