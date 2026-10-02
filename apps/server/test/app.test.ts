import { healthResponseSchema } from '@isles/contracts';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture(withWeb = false) {
  const directory = await mkdtemp(join(tmpdir(), 'isles-test-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const webRoot = join(directory, 'web');
  if (withWeb) {
    await mkdir(webRoot);
    await writeFile(join(webRoot, 'index.html'), '<main>Isles shell</main>');
  }
  const app = await buildApp({ dataDir: directory, ...(withWeb ? { webRoot } : {}) });
  cleanups.push(() => app.close());
  return { app, directory };
}

describe('application bootstrap', () => {
  it('saves Codex paths across restart and immediately invalidates a failed detection', async () => {
    const { app, directory } = await fixture();
    const firstPath = join(directory, 'missing-first.exe');
    const secondPath = join(directory, 'missing-second.exe');
    const save = (binaryPath: string | null) =>
      app.inject({ method: 'PUT', url: '/api/codex/config', payload: { binaryPath } });
    expect((await save(firstPath)).json().binaryPath).toBe(firstPath);
    expect((await app.inject('/api/codex/status')).json().error).toContain(firstPath);
    await save(secondPath);
    expect((await app.inject('/api/codex/status')).json().error).toContain(secondPath);
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/codex/config',
      payload: { binaryPath: '' },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
    const restored = await buildApp({ dataDir: directory });
    cleanups.push(() => restored.close());
    expect((await restored.inject('/api/codex/config')).json().binaryPath).toBe(secondPath);
    expect(
      (
        await restored.inject({
          method: 'PUT',
          url: '/api/codex/config',
          payload: { binaryPath: null },
        })
      ).json().binaryPath,
    ).toBeNull();
  });

  it('connects the API to an on-disk SQLite database in WAL mode', async () => {
    const { app, directory } = await fixture();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.parse(response.json()).database).toBe('ready');
    expect(response.headers['cache-control']).toBe('no-store');

    const reader = new Database(join(directory, 'isles.sqlite'), { readonly: true });
    try {
      expect(reader.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      reader.close();
    }
  });

  it('keeps missing API routes as errors when serving the Web application', async () => {
    const { app } = await fixture(true);
    const response = await app.inject({
      method: 'GET',
      url: '/api/missing',
      headers: { accept: 'text/html' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('refuses an M1 data directory with a clear message instead of migrating it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'isles-legacy-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const legacy = new Database(join(directory, 'isles.sqlite'));
    legacy.exec('create table objects (id text primary key)');
    legacy.close();
    await expect(buildApp({ dataDir: directory })).rejects.toThrow('M1 格式');
    // The data lock is released, so a fixed directory can be opened again.
    await rm(join(directory, 'isles.sqlite'));
    const app = await buildApp({ dataDir: directory });
    await app.close();
  });

  it('serves the built Web shell for browser navigation', async () => {
    const { app } = await fixture(true);
    const response = await app.inject({
      method: 'GET',
      url: '/workspace',
      headers: { accept: 'text/html' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Isles shell');
  });
});
