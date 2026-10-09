import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export interface NativeCommand {
  file: string;
  args: string[];
}
export interface CodexExecutable extends NativeCommand {
  /** The executable or npm launcher the user can configure. */
  path: string;
  version: string;
}
export interface DiscoveryOptions {
  binary?: string | null;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}
type VersionProbe = (command: NativeCommand) => Promise<string>;
const exec = promisify(execFile);

async function commandAt(path: string, platform: NodeJS.Platform): Promise<NativeCommand> {
  if (!(await stat(path)).isFile()) throw new Error('路径不是文件');
  const extension = extname(path).toLowerCase();
  if (platform === 'win32' && ['.cmd', '.bat', '.ps1'].includes(extension)) {
    // npm/pnpm launchers cannot be passed to spawn directly on Windows. Run their
    // Codex JS entry with this server's Node, without invoking a command shell.
    let script = join(dirname(path), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    try {
      await access(script);
    } catch {
      const launcher = await readFile(path, 'utf8');
      const reference = launcher.match(
        /"([^"\r\n]*[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js)"/i,
      )?.[1];
      if (!reference) throw new Error('无法解析 npm/pnpm 的 Codex 启动文件');
      const relative = reference.replace(/^(?:%~dp0|%dp0%|\$basedir|\$PSScriptRoot)[\\/]?/i, '');
      if (/[$%]/.test(relative)) throw new Error('Codex 启动文件包含无法解析的路径');
      script = isAbsolute(relative) ? relative : resolve(dirname(path), relative);
      await access(script);
    }
    return { file: process.execPath, args: [script] };
  }
  const target = await realpath(path);
  if (['.js', '.mjs', '.cjs'].includes(extname(target).toLowerCase()))
    return { file: process.execPath, args: [target] };
  await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
  return { file: path, args: [] };
}

function pathsIn(directory: string, platform: NodeJS.Platform, name = 'codex') {
  const names =
    platform === 'win32' && !extname(name)
      ? [`${name}.exe`, `${name}.cmd`, `${name}.ps1`, name]
      : [name];
  return names.map((file) => resolve(directory, file));
}

function pathDirectories(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const key = Object.keys(environment)
    .sort()
    .find((name) => (platform === 'win32' ? name.toUpperCase() === 'PATH' : name === 'PATH'));
  return (environment[key ?? 'PATH'] ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .map((directory) => directory.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

async function desktopPaths(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
) {
  if (platform === 'win32') {
    const bin = join(
      environment.LOCALAPPDATA ?? join(home, 'AppData', 'Local'),
      'OpenAI',
      'Codex',
      'bin',
    );
    const installs: { path: string; modified: number }[] = [];
    try {
      for (const entry of await readdir(bin, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(bin, entry.name, 'codex.exe');
        try {
          installs.push({ path, modified: (await stat(path)).mtimeMs });
        } catch {
          /* An incomplete or removed installation is not a candidate. */
        }
      }
    } catch {
      /* The desktop app is optional. */
    }
    installs.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
    return [...installs.map((installation) => installation.path), join(bin, 'codex.exe')];
  }
  if (platform === 'darwin')
    return ['/Applications', join(home, 'Applications')].map((directory) =>
      join(directory, 'Codex.app', 'Contents', 'Resources', 'codex'),
    );
  return [];
}

export async function findCodexExecutable(
  options: DiscoveryOptions = {},
  probe?: VersionProbe,
): Promise<CodexExecutable> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const configured = options.binary?.trim().replace(/^(["'])(.*)\1$/, '$2');
  const directories = pathDirectories(environment, platform);
  let paths: string[];
  if (configured) {
    paths =
      isAbsolute(configured) || /[\\/]/.test(configured)
        ? [resolve(configured)]
        : directories.flatMap((directory) => pathsIn(directory, platform, configured));
  } else {
    const standard =
      platform === 'win32'
        ? [
            environment.PNPM_HOME,
            join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm'),
            join(environment.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'pnpm'),
          ]
        : [
            join(home, '.local', 'bin'),
            join(home, '.npm-global', 'bin'),
            join(home, '.volta', 'bin'),
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/usr/bin',
          ];
    paths = [
      ...directories.flatMap((directory) => pathsIn(directory, platform)),
      ...(await desktopPaths(environment, platform, home)),
      ...standard
        .filter((directory): directory is string => Boolean(directory))
        .flatMap((directory) => pathsIn(directory, platform)),
    ];
  }
  const checkVersion =
    probe ??
    (async (command: NativeCommand) =>
      (
        await exec(command.file, [...command.args, '--version'], {
          env: environment,
          timeout: 10_000,
          maxBuffer: 64_000,
          windowsHide: true,
        })
      ).stdout.trim());
  let found = false;
  for (const path of new Set(paths)) {
    try {
      await stat(path);
      found = true;
      const command = await commandAt(path, platform);
      const version = (await checkVersion(command)).trim();
      if (!/^codex-cli\s+\S+/.test(version)) throw new Error('程序不是 Codex CLI');
      return { ...command, path, version };
    } catch (error) {
      if (configured && (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          `配置的 Codex 无法运行：${configured}。请检查路径、文件权限与安装是否完整。`,
          { cause: error },
        );
    }
  }
  if (configured)
    throw new Error(`找不到配置的 Codex：${configured}。请修改 Codex 路径设置；留空可以自动发现。`);
  throw new Error(
    found
      ? '检测到 Codex 安装，但无法运行。请检查安装是否完整，或在 Codex 路径设置中指定可执行文件。'
      : '未找到本机 Codex。请在 Codex 路径设置中指定可执行文件，或安装 Codex CLI 后重新检测。',
  );
}
