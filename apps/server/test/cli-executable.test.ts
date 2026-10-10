import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findDshExecutable } from '../src/harness/dsh/executable.js';
import { windowsInstallDirectories } from '../src/harness/dsh/desktop.js';
import { findOpenCodeExecutable } from '../src/harness/opencode/executable.js';
import { findCliExecutable } from '../src/harness/shared/executable.js';

vi.mock('../src/harness/dsh/desktop.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/harness/dsh/desktop.js')>()),
  windowsInstallDirectories: vi.fn(),
}));

const roots: string[] = [];
beforeEach(() => {
  vi.mocked(windowsInstallDirectories).mockReset().mockResolvedValue([]);
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isles-cli-discovery-'));
  roots.push(root);
  const file = async (path: string, contents = '') => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, { mode: 0o755 });
    return path;
  };
  const options = {
    home: root,
    platform: 'win32' as const,
    environment: { Path: '', APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local') },
  };
  return { root, file, options };
}
const opencodeVersion = async () => 'opencode v2.0.26';
const dshVersion = async () => '0.2.0-rc.2';

it('includes the native carrier environment in the real version probe', async () => {
  const f = await fixture();
  const script = await f.file(
    join(f.root, 'carrier.mjs'),
    'if (process.env.ISLES_DISCOVERY_CARRIER !== "enabled") process.exit(1);\nconsole.log("carrier 1.0");\n',
  );
  expect(
    await findCliExecutable(
      {
        name: 'carrier',
        displayName: 'Carrier',
        npmEntry: 'carrier/cli.js',
        versionPattern: /^carrier 1\.0$/,
        resolveCommand: async () => ({
          file: process.execPath,
          args: [script],
          env: { ISLES_DISCOVERY_CARRIER: 'enabled' },
        }),
      },
      { ...f.options, binary: script },
    ),
  ).toMatchObject({ version: 'carrier 1.0' });
});

describe('OpenCode v2 executable discovery', () => {
  it.each(['cmd', 'ps1'])(
    'runs the native npm entry behind a .%s launcher without Node',
    async (ext) => {
      const { file, options } = await fixture();
      const npm = join(options.environment.APPDATA, 'npm');
      const binary = await file(
        join(npm, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
      );
      const launcher = await file(join(npm, `opencode.${ext}`));
      expect(await findOpenCodeExecutable(options, opencodeVersion)).toEqual({
        file: binary,
        args: [],
        path: launcher,
        version: 'opencode v2.0.26',
      });
    },
  );

  it('resolves pnpm launchers with a relative native entry and spaces in the path', async () => {
    const { root, file, options } = await fixture();
    const bin = join(root, 'custom pnpm');
    const binary = await file(join(bin, '.pnpm', '@opencode', 'cli', 'bin', 'opencode.exe'));
    const launcher = await file(
      join(bin, 'opencode.cmd'),
      '@echo off\n"%~dp0.pnpm/@opencode/cli/bin/opencode.exe" %*\n',
    );
    expect(
      await findOpenCodeExecutable({ ...options, binary: `"${launcher}"` }, opencodeVersion),
    ).toMatchObject({ file: binary, args: [], path: launcher });
  });

  it('honors an invalid explicit path even when a working native executable is on PATH', async () => {
    const { root, file, options } = await fixture();
    await file(join(root, 'opencode.exe'));
    await expect(
      findOpenCodeExecutable(
        { ...options, binary: join(root, 'missing.exe'), environment: { Path: root } },
        opencodeVersion,
      ),
    ).rejects.toThrow('找不到配置的 OpenCode');
  });
});

describe('DSH desktop executable discovery', () => {
  async function desktopFixture() {
    const f = await fixture();
    const install = join(f.root, '自定义 DeepSeek Harness');
    const binary = await f.file(join(install, 'DeepSeek Harness.exe'));
    const archive = await f.file(join(install, 'resources', 'app.asar'));
    const bin = join(install, 'resources', 'runtime', 'cli', 'bin');
    const launcher = await f.file(join(bin, 'dsh.cmd'));
    return { ...f, bin, launcher, binary, archive };
  }

  it('discovers a registered custom Windows install and preserves its Electron runtime', async () => {
    const f = await desktopFixture();
    vi.mocked(windowsInstallDirectories).mockResolvedValue([f.bin]);
    expect(await findDshExecutable(f.options, dshVersion)).toEqual({
      file: f.binary,
      args: [
        '--expose-internals',
        join(f.archive, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
      ],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      path: f.launcher,
      version: '0.2.0-rc.2',
    });
  });

  it('runs a configured desktop launcher without searching registered installations', async () => {
    const f = await desktopFixture();
    expect(await findDshExecutable({ ...f.options, binary: f.launcher }, dshVersion)).toMatchObject(
      { file: f.binary, env: { ELECTRON_RUN_AS_NODE: '1' } },
    );
    expect(windowsInstallDirectories).not.toHaveBeenCalled();
  });

  it('skips an incomplete desktop installation and uses the npm CLI', async () => {
    const f = await fixture();
    const desktopBin = join(f.root, 'desktop', 'resources', 'runtime', 'cli', 'bin');
    await f.file(join(desktopBin, 'dsh.cmd'));
    vi.mocked(windowsInstallDirectories).mockResolvedValue([desktopBin]);
    const npm = join(f.options.environment.APPDATA, 'npm');
    const script = await f.file(join(npm, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    const launcher = await f.file(join(npm, 'dsh.cmd'));
    expect(await findDshExecutable(f.options, dshVersion)).toMatchObject({
      file: process.execPath,
      args: [script],
      path: launcher,
    });
  });

  it('keeps macOS user Applications discovery', async () => {
    const f = await fixture();
    const binary = await f.file(
      join(
        f.root,
        'Applications',
        'DeepSeek Harness.app',
        'Contents',
        'Resources',
        'runtime',
        'cli',
        'bin',
        'dsh',
      ),
    );
    expect(await findDshExecutable({ ...f.options, platform: 'darwin' }, dshVersion)).toMatchObject(
      {
        file: binary,
        args: [],
        path: binary,
      },
    );
    expect(windowsInstallDirectories).not.toHaveBeenCalled();
  });
});
