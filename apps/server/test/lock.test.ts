import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireDataLock } from '../src/storage/lock.js';

it('automatically releases the data ownership lock after abrupt process termination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'isles-lock-'));
  const driver = createRequire(import.meta.url).resolve('better-sqlite3');
  const script = `const Database=require(${JSON.stringify(driver)});const db=new Database(${JSON.stringify(join(directory, 'runtime-lock.sqlite'))});db.exec('BEGIN EXCLUSIVE');console.log('owned');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout, 'data');
    expect(() => acquireDataLock(directory)).toThrow('另一个 Isles');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const release = acquireDataLock(directory);
    release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});
