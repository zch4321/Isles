import { healthResponseSchema } from '@isles/contracts';
import { ConfigManager } from '@isles/config';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';
import { parse } from 'smol-toml';
import { Store } from '../src/storage/store.js';

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
  const config = testConfig(directory);
  const app = await buildApp({ config, ...(withWeb ? { webRoot } : {}) });
  cleanups.push(() => app.close());
  return { app, directory, config };
}

describe('application bootstrap', () => {
  it('releases the database and data lock when boot recovery fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'isles-failed-bootstrap-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const config = testConfig(directory);
    const recovery = vi.spyOn(Store.prototype, 'recoverOnBoot').mockImplementationOnce(() => {
      throw new Error('Recovery write failed');
    });
    try {
      await expect(buildApp({ config })).rejects.toThrow('Recovery write failed');
      const app = await buildApp({ config });
      cleanups.push(() => app.close());
      expect((await app.inject('/api/health')).statusCode).toBe(200);
    } finally {
      recovery.mockRestore();
    }
  });
  it('saves Codex paths across restart and immediately invalidates a failed detection', async () => {
    const { app, directory, config } = await fixture();
    const firstPath = join(directory, 'missing-first.exe');
    const secondPath = join(directory, 'missing-second.exe');
    const save = (binaryPath: string | null) =>
      app.inject({ method: 'PUT', url: '/api/harnesses/codex/config', payload: { binaryPath } });
    expect((await save(firstPath)).json()).toMatchObject({
      binaryPath: firstPath,
      configFilePath: config.current.configFilePath,
    });
    expect(parse(await readFile(config.current.configFilePath, 'utf8'))).toMatchObject({
      codex: { binary_path: firstPath },
    });
    expect((await app.inject('/api/harnesses/codex/status')).json().error).toContain(firstPath);
    await save(secondPath);
    expect((await app.inject('/api/harnesses/codex/status')).json().error).toContain(secondPath);
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/harnesses/codex/config',
      payload: { binaryPath: '' },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
    const restored = await buildApp({ config: testConfig(directory) });
    cleanups.push(() => restored.close());
    expect((await restored.inject('/api/harnesses/codex/config')).json().binaryPath).toBe(
      secondPath,
    );
    expect(
      (
        await restored.inject({
          method: 'PUT',
          url: '/api/harnesses/codex/config',
          payload: { binaryPath: null },
        })
      ).json().binaryPath,
    ).toBeNull();
    expect(parse(await readFile(config.current.configFilePath, 'utf8')).codex).toEqual({});
  });

  it('retains manually edited fields on UI save without changing the live directories', async () => {
    const { app, directory, config } = await fixture();
    const snapshot = config.current;
    await writeFile(
      config.current.configFilePath,
      '[server]\nport = 4400\n[paths]\ndata_dir = "next-data"\nworkspace_dir = "next-work"\n',
    );
    const response = await app.inject({
      method: 'PUT',
      url: '/api/harnesses/codex/config',
      payload: { binaryPath: 'codex' },
    });
    expect(response.statusCode).toBe(200);
    expect(parse(await readFile(config.current.configFilePath, 'utf8'))).toEqual({
      server: { port: 4400 },
      paths: { data_dir: 'next-data', workspace_dir: 'next-work' },
      codex: { binary_path: 'codex' },
    });
    expect(config.current).toEqual({
      ...snapshot,
      cli: { ...snapshot.cli, codex: { ...snapshot.cli.codex, binaryPath: 'codex' } },
    });
    const reloaded = new ConfigManager({
      configFilePath: config.current.configFilePath,
      homeDir: directory,
      environment: {},
    });
    expect(reloaded.current.dataDir).toBe(join(directory, 'next-data'));
    expect(reloaded.current.workspaceDir).toBe(join(directory, 'next-work'));
  });

  it('reports the TOML filename and invalid field without overwriting a bad manual edit', async () => {
    const { app, config } = await fixture();
    const invalid = '[server]\nport = "wrong"';
    await writeFile(config.current.configFilePath, invalid);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/harnesses/codex/config',
      payload: { binaryPath: 'codex' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain(config.current.configFilePath);
    expect(response.json().error).toContain('server.port');
    expect(await readFile(config.current.configFilePath, 'utf8')).toBe(invalid);
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
