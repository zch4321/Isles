import { execFile, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

/**
 * Stops a native process started with `detached` on POSIX, together with its children.
 * npm launchers can own the real CLI, so the whole tree is signalled; SIGKILL follows
 * after two seconds. Resolves when `terminated` does.
 */
export async function stopProcessTree(child: ChildProcess, terminated: Promise<void>) {
  const signal = (name: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(name);
      else process.kill(-child.pid, name);
    } catch {
      /* The owned process already exited. */
    }
  };
  child.stdin?.end();
  if (
    process.platform === 'win32' &&
    child.pid &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    execFile(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true },
      (error) => {
        if (error) signal('SIGTERM');
      },
    );
  } else signal('SIGTERM');
  const timer = setTimeout(() => signal('SIGKILL'), 2_000);
  await terminated;
  clearTimeout(timer);
}
