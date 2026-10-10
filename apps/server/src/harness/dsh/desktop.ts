import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { CliCommand } from '../shared/executable.js';

const exec = promisify(execFile);
const windowsInstallQuery = String.raw`
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$islesUninstallKeys = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
@(Get-ItemProperty -Path $islesUninstallKeys -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like 'DeepSeek Harness*' } |
  ForEach-Object { $_.InstallLocation }) | ConvertTo-Json -Compress
`;

/** Read the desktop installer's location, including custom per-user and machine installs. */
export async function windowsInstallDirectories(home: string, environment: NodeJS.ProcessEnv) {
  let registered: string[] = [];
  try {
    const { stdout } = await exec(
      join(
        environment.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      ['-NoProfile', '-NonInteractive', '-Command', windowsInstallQuery],
      { env: environment, timeout: 5_000, maxBuffer: 64_000, windowsHide: true },
    );
    const value: unknown = stdout.trim() ? JSON.parse(stdout) : [];
    registered = (Array.isArray(value) ? value : [value]).filter(
      (path): path is string => typeof path === 'string' && isAbsolute(path),
    );
  } catch {
    // Standard installation directories remain candidates when the registry is unavailable.
  }
  return [
    ...registered,
    join(
      environment.LOCALAPPDATA ?? join(home, 'AppData', 'Local'),
      'Programs',
      'DeepSeek Harness',
    ),
    ...[environment.ProgramFiles, environment['ProgramFiles(x86)']]
      .filter((path): path is string => Boolean(path))
      .map((path) => join(path, 'DeepSeek Harness')),
  ].map((path) => join(path, 'resources', 'runtime', 'cli', 'bin'));
}

/** Match the Windows desktop launcher's Electron/ASAR runtime without invoking a shell. */
export async function desktopCommand(
  path: string,
  platform: NodeJS.Platform,
): Promise<CliCommand | undefined> {
  if (platform !== 'win32') return;
  const launcher = await realpath(path);
  if (basename(launcher).toLowerCase() !== 'dsh.cmd') return;
  const root = resolve(dirname(launcher), '../../../..');
  const file = join(root, 'DeepSeek Harness.exe');
  const archive = join(root, 'resources', 'app.asar');
  try {
    if (!(await stat(file)).isFile() || !(await stat(archive)).isFile()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  return {
    file,
    args: [
      '--expose-internals',
      join(archive, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    ],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}
