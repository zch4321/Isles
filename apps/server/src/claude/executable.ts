import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export interface ClaudeCommand {
  file: string;
  args: string[];
}
export interface ClaudeExecutable extends ClaudeCommand {
  path: string;
  version: string;
}
export interface ClaudeDiscoveryOptions {
  binary?: string | null;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}
const exec = promisify(execFile);

async function commandAt(path: string, platform: NodeJS.Platform): Promise<ClaudeCommand> {
  if (!(await stat(path)).isFile()) throw new Error('路径不是文件');
  if (platform === 'win32' && ['.cmd', '.bat', '.ps1'].includes(extname(path).toLowerCase())) {
    let script = join(dirname(path), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    try {
      await access(script);
    } catch {
      const launcher = await readFile(path, 'utf8');
      const reference = launcher.match(
        /"([^"\r\n]*[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js)"/i,
      )?.[1];
      if (!reference) throw new Error('无法解析 Claude npm/pnpm 启动文件');
      const relative = reference.replace(/^(?:%~dp0|%dp0%|\$basedir|\$PSScriptRoot)[\\/]?/i, '');
      if (/[$%]/.test(relative)) throw new Error('Claude 启动文件包含无法解析的路径');
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

export async function findClaudeExecutable(
  options: ClaudeDiscoveryOptions = {},
  probe?: (command: ClaudeCommand) => Promise<string>,
): Promise<ClaudeExecutable> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const configured = options.binary?.trim().replace(/^(["'])(.*)\1$/, '$2');
  const pathKey =
    Object.keys(environment).find((key) =>
      platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH',
    ) ?? 'PATH';
  const directories = (environment[pathKey] ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .map((path) => path.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const pathsIn = (directory: string, name = 'claude') =>
    (platform === 'win32' && !extname(name)
      ? [`${name}.exe`, `${name}.cmd`, `${name}.ps1`, name]
      : [name]
    ).map((name) => resolve(directory, name));
  const standard = [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.claude', 'local', 'node_modules', '.bin'),
    ...(platform === 'win32'
      ? [
          environment.PNPM_HOME,
          join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm'),
          join(environment.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'pnpm'),
        ]
      : [
          join(home, '.npm-global', 'bin'),
          join(home, '.volta', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
        ]),
  ].filter((path): path is string => Boolean(path));
  const paths = configured
    ? isAbsolute(configured) || /[\\/]/.test(configured)
      ? [resolve(configured)]
      : directories.flatMap((directory) => pathsIn(directory, configured))
    : [...directories, ...standard].flatMap((directory) => pathsIn(directory));
  let found = false;
  for (const path of new Set(paths)) {
    try {
      await stat(path);
      found = true;
      const command = await commandAt(path, platform);
      const version = (
        probe
          ? await probe(command)
          : (
              await exec(command.file, [...command.args, '--version'], {
                env: environment,
                timeout: 10_000,
                maxBuffer: 64_000,
                windowsHide: true,
              })
            ).stdout
      ).trim();
      if (!/^\d+\.\d+\.\d+[^\r\n]*\(Claude Code\)/.test(version))
        throw new Error('程序不是 Claude Code CLI');
      return { ...command, path, version };
    } catch (error) {
      if (configured && (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          `配置的 Claude Code 无法运行：${configured}。请检查路径、文件权限与安装是否完整。`,
          { cause: error },
        );
    }
  }
  if (configured)
    throw new Error(`找不到配置的 Claude Code：${configured}。请修改路径设置；留空恢复自动发现。`);
  throw new Error(
    found
      ? '检测到 Claude Code 安装，但无法运行。请检查安装或指定可执行文件。'
      : '未找到本机 Claude Code。请安装 CLI 或在路径设置中指定可执行文件。',
  );
}
