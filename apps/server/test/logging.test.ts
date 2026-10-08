import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Redactor } from '../src/errors.js';
import { LogFile, type LogStream } from '../src/logging.js';
import { testConfig } from './helpers.js';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'isles-logs-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function clock(start: Date) {
  let time = start;
  return {
    now: () => time,
    set: (next: Date) => (time = next),
  };
}

const limits = { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxBytes: 100, fileBytes: 20 };
// Written files carry the real mtime, so injected clocks stay on the real current day.
const today = new Date();
const at = (dayOffset: number, hours: number, minutes = 0) =>
  new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, hours, minutes);
const stamp = (time: Date) =>
  `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')}`;

describe('log files', () => {
  it('appends to the current day and starts a new file after local midnight', async () => {
    const dir = await directory();
    const time = clock(at(0, 23, 59));
    const first = new LogFile(dir, limits, time.now);
    first.write('a\n');
    first.close();
    const reopened = new LogFile(dir, limits, time.now);
    cleanups.push(() => reopened.close());
    reopened.write('b\n');
    time.set(at(1, 0, 1));
    reopened.write('c\n');
    const [day, next] = [`isles-${stamp(at(0, 0))}.log`, `isles-${stamp(at(1, 0))}.log`];
    expect(readFileSync(join(dir, day), 'utf8')).toBe('a\nb\n');
    expect(readFileSync(join(dir, next), 'utf8')).toBe('c\n');
    expect(statSync(join(dir, next)).mode & 0o777).toBe(0o600);
  });

  it('continues in numbered segments when a file reaches its size limit', async () => {
    const dir = await directory();
    const file = new LogFile(dir, limits, () => at(0, 12));
    cleanups.push(() => file.close());
    file.write('0123456789\n');
    file.write('0123456789\n');
    file.write('x\n');
    const day = stamp(at(0, 12));
    expect(readdirSync(dir).sort()).toEqual([`isles-${day}.1.log`, `isles-${day}.log`]);
    expect(readFileSync(join(dir, `isles-${day}.log`), 'utf8')).toBe('0123456789\n');
    expect(readFileSync(join(dir, `isles-${day}.1.log`), 'utf8')).toBe('0123456789\nx\n');
  });

  it('removes files older than seven days and the oldest files beyond the size limit', async () => {
    const dir = await directory();
    const now = new Date(2026, 9, 8, 12);
    const age = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const seed = (name: string, bytes: number, days: number) => {
      writeFileSync(join(dir, name), 'x'.repeat(bytes));
      utimesSync(join(dir, name), age(days), age(days));
    };
    seed('isles-2026-09-30.log', 5, 8);
    seed('isles-2026-10-03.log', 30, 5);
    seed('isles-2026-10-04.log', 30, 4);
    seed('isles-2026-10-06.log', 30, 2);
    seed('isles-2026-10-07.log', 10, 1);
    seed('notes.txt', 500, 30);
    const file = new LogFile(dir, limits, () => now);
    cleanups.push(() => file.close());
    // 20 bytes stay reserved for the open file; the newest older logs fill the other 80.
    expect(readdirSync(dir).sort()).toEqual([
      'isles-2026-10-04.log',
      'isles-2026-10-06.log',
      'isles-2026-10-07.log',
      'notes.txt',
    ]);
  });
});

describe('server logging', () => {
  async function app(environment: NodeJS.ProcessEnv = {}) {
    const root = await directory();
    const lines: string[] = [];
    const logStream: LogStream = { write: (line) => lines.push(line), close: () => {} };
    const instance = await buildApp({ config: testConfig(root, environment), logStream });
    cleanups.push(() => instance.close());
    const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    return { instance, entries };
  }

  it('logs unexpected request failures with redacted error details', async () => {
    const { instance, entries } = await app();
    instance.get('/api/test-failure', async () => {
      throw new Error('upstream rejected Bearer native-secret-token', {
        cause: new Error('api_key=native-secret-key'),
      });
    });
    const response = await instance.inject('/api/test-failure?debug=1');
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: '服务处理失败，请检查运行状态' });
    const entry = entries().find((value) => value.msg === 'Request failed');
    expect(entry).toMatchObject({
      level: 50,
      method: 'GET',
      url: '/api/test-failure',
      err: {
        type: 'Error',
        message: 'upstream rejected Bearer [redacted]',
        cause: { message: 'api_key=[redacted]' },
      },
    });
    expect(JSON.stringify(entries())).not.toContain('native-secret');
  });

  it('writes only entries at or above the configured level', async () => {
    const { instance, entries } = await app({ ISLES_LOG_LEVEL: 'warn' });
    instance.log.info('hidden');
    instance.log.warn('shown');
    expect(entries().map((entry) => entry.msg)).toEqual(['shown']);
  });
});

describe('error details for logs', () => {
  it('keeps the error code and scrubs learned secrets from message and stack', () => {
    const redactor = new Redactor();
    redactor.add({ token: 'learned-secret-value' });
    const error = Object.assign(new Error('failed with learned-secret-value'), { code: 'EACCES' });
    const details = redactor.error(error);
    expect(details).toMatchObject({
      type: 'Error',
      message: 'failed with [redacted]',
      code: 'EACCES',
    });
    expect(details.stack).not.toContain('learned-secret-value');
  });
});
