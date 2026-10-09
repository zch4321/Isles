import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StdioClient } from '../src/harness/codex/client.js';
import { NativeEnvironment } from '../src/harness/codex/environment.js';
import { AgentWorkspace } from '../src/runtime/workspace.js';
import { findCodexExecutable, type NativeCommand } from '../src/harness/codex/executable.js';
import { Redactor } from '../src/errors.js';
import { silentLogger } from '../src/logging.js';
import { testConfig } from './helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.unstubAllEnvs();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isles-executable-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'path');
  await mkdir(bin);
  return {
    root,
    bin,
    options: {
      platform: 'win32' as const,
      home: root,
      environment: {
        Path: bin,
        LOCALAPPDATA: join(root, 'local'),
        APPDATA: join(root, 'roaming'),
      },
    },
  };
}
async function file(path: string, content = '') {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}
const version = async () => 'codex-cli 0.159.2';

function environmentAt(root: string, environment: NodeJS.ProcessEnv = {}) {
  const config = testConfig(root, environment);
  return new NativeEnvironment(config, new AgentWorkspace(config));
}

describe('Codex executable discovery', () => {
  it.skipIf(process.platform !== 'win32')(
    'closes the owned app-server tree behind a Windows Node launcher',
    async () => {
      const { bin } = await fixture();
      const worker = await file(
        join(bin, 'worker.cjs'),
        `
require('node:readline').createInterface({input:process.stdin}).on('line', line=>{
 const frame=JSON.parse(line);
 if(frame.id) process.stdout.write(JSON.stringify({id:frame.id,result:{pid:process.pid}})+'\\n');
});
setInterval(()=>{},1000);
`,
      );
      const launcher = await file(
        join(bin, 'launcher.cjs'),
        `
const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(worker)}],{stdio:'inherit'});
child.on('exit',code=>process.exit(code || 0));
`,
      );
      const client = new StdioClient(
        { file: process.execPath, args: [launcher] },
        bin,
        {},
        {
          notification: () => {},
          request: () => {},
          exit: () => {},
        },
        new Redactor(),
        silentLogger,
      );
      cleanups.push(() => client.close());
      await client.initialize();
      const { pid } = await client.request<{ pid: number }>('pid', {});
      await client.close();
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    },
  );

  it('honors an explicit path and does not replace invalid configuration with a PATH installation', async () => {
    const { root, bin, options } = await fixture();
    const configured = await file(join(root, 'configured.exe'));
    await file(join(bin, 'codex.exe'));
    const probe = vi.fn(version);
    expect((await findCodexExecutable({ ...options, binary: configured }, probe)).path).toBe(
      configured,
    );
    expect(probe).toHaveBeenCalledTimes(1);
    await expect(
      findCodexExecutable({ ...options, binary: join(root, 'missing.exe') }, probe),
    ).rejects.toThrow('找不到配置的 Codex');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('prefers PATH and falls back to the newest working desktop installation without PATH', async () => {
    const { bin, options } = await fixture();
    const onPath = await file(join(bin, 'codex.exe'));
    const old = await file(
      join(options.environment.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', 'old', 'codex.exe'),
    );
    const newest = await file(
      join(options.environment.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', 'new', 'codex.exe'),
    );
    await utimes(old, 100, 100);
    await utimes(newest, 200, 200);
    expect((await findCodexExecutable(options, version)).path).toBe(onPath);
    const noPath = { ...options, environment: { ...options.environment, Path: '' } };
    expect((await findCodexExecutable(noPath, version)).path).toBe(newest);
    const probe = async (command: NativeCommand) =>
      command.file === newest ? 'another-program 1.0' : version();
    expect((await findCodexExecutable(noPath, probe)).path).toBe(old);
  });

  it('discovers a user-installed macOS desktop app outside PATH', async () => {
    const { root } = await fixture();
    const binary = await file(
      join(root, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
    );
    const { chmod } = await import('node:fs/promises');
    await chmod(binary, 0o755);
    const probe = async (command: NativeCommand) =>
      command.file === binary ? version() : 'not-codex';
    expect(
      (
        await findCodexExecutable(
          { platform: 'darwin', home: root, environment: { PATH: '' } },
          probe,
        )
      ).path,
    ).toBe(binary);
  });

  it('runs a Windows npm launcher through its JS entry for both version and app-server', async () => {
    const { bin, options } = await fixture();
    const launcher = await file(join(bin, 'codex.cmd'), '@echo off');
    const script = await file(
      join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
      `
if(process.argv.includes('--version')) console.log('codex-cli 0.159.2');
else require('node:readline').createInterface({input:process.stdin}).on('line', line=>{
 const frame=JSON.parse(line);
 if(frame.id) process.stdout.write(JSON.stringify({id:frame.id,result:{ok:true}})+'\\n');
});
`,
    );
    const executable = await findCodexExecutable({
      ...options,
      binary: launcher,
      environment: process.env,
    });
    expect(executable).toMatchObject({
      path: launcher,
      file: process.execPath,
      args: [script],
      version: 'codex-cli 0.159.2',
    });
    const client = new StdioClient(
      executable,
      bin,
      {},
      {
        notification: () => {},
        request: () => {},
        exit: () => {},
      },
      new Redactor(),
      silentLogger,
    );
    cleanups.push(() => client.close());
    await client.initialize();
    expect(await client.request('check', {})).toEqual({ ok: true });
  });

  it('resolves a pnpm launcher with its package outside the launcher directory', async () => {
    const { root, bin, options } = await fixture();
    const script = await file(
      join(root, 'global', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    );
    const launcher = await file(
      join(bin, 'codex.cmd'),
      `"%~dp0../global/node_modules/@openai/codex/bin/codex.js"`,
    );
    expect(await findCodexExecutable({ ...options, binary: launcher }, version)).toMatchObject({
      file: process.execPath,
      args: [script],
    });
  });

  it('reports a useful configuration action when automatic discovery finds nothing', async () => {
    const { options } = await fixture();
    await expect(findCodexExecutable(options, version)).rejects.toThrow('Codex 路径设置');
  });

  it('persists the UI path and restores discovery when cleared, with startup overrides taking priority', async () => {
    const { root } = await fixture();
    const script = await file(join(root, 'codex.js'), "console.log('codex-cli 0.159.2');");
    const first = environmentAt(root);
    await first.configure(script);
    const restored = environmentAt(root);
    expect((await restored.executable()).path).toBe(script);
    const overridden = environmentAt(root, { ISLES_CODEX_BIN: script });
    await overridden.configure(join(root, 'missing.exe'));
    expect((await overridden.executable()).path).toBe(script);
    expect((await overridden.configuration()).environmentBinaryPath).toBe(script);
    await overridden.configure(null);
    expect(environmentAt(root).configuration().binaryPath).toBeNull();
  });
});
