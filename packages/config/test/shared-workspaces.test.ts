import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigManager } from '../src/index.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(contents = '') {
  const root = mkdtempSync(join(tmpdir(), 'isles-shared-workspaces-'));
  roots.push(root);
  const configFilePath = join(root, 'config.toml');
  writeFileSync(configFilePath, contents);
  const create = () => new ConfigManager({ configFilePath, homeDir: root, environment: {} });
  return { root, configFilePath, create };
}

describe('shared workspace configuration', () => {
  it('defaults to an empty list and resolves tilde and relative directories beside the config', () => {
    expect(fixture().create().current.sharedWorkspacePaths).toEqual([]);
    const { create, root } = fixture(
      '[paths]\nshared_workspaces = ["~/project", "./shared", " ~ "]',
    );
    expect(create().current.sharedWorkspacePaths).toEqual([
      join(root, 'project'),
      join(root, 'shared'),
      root,
    ]);
    expect(Object.isFrozen(create().current.sharedWorkspacePaths)).toBe(true);
  });

  it('preserves latest disk fields and refreshes only shared paths live', async () => {
    const { create, root, configFilePath } = fixture('[server]\nport = 4400');
    const manager = create();
    const before = manager.current;
    writeFileSync(
      configFilePath,
      '[server]\nport = 4500\n[paths]\nworkspace_dir = "edited"\n[codex]\nhome = "native"',
    );
    await manager.configureSharedWorkspaces([join(root, 'selected')]);
    expect(parse(readFileSync(configFilePath, 'utf8'))).toEqual({
      server: { port: 4500 },
      paths: { workspace_dir: 'edited', shared_workspaces: [join(root, 'selected')] },
      codex: { home: 'native' },
    });
    expect(manager.current).toEqual({ ...before, sharedWorkspacePaths: [join(root, 'selected')] });
    expect(create().current.sharedWorkspacePaths).toEqual([join(root, 'selected')]);
    await manager.configureSharedWorkspaces([]);
    expect(create().current.sharedWorkspacePaths).toEqual([]);
  });

  it('shares the CLI write queue across managers without losing concurrent edits', async () => {
    const { create, root, configFilePath } = fixture('[server]\nport = 4400');
    const first = create();
    const second = create();
    await Promise.all([
      first.configureSharedWorkspaces([join(root, 'first')]),
      second.configureCliBinary('codex', 'chosen'),
      first.configureSharedWorkspaces([join(root, 'last')]),
      second.configureCliBinary('claude', 'selected'),
    ]);
    expect(parse(readFileSync(configFilePath, 'utf8'))).toEqual({
      server: { port: 4400 },
      paths: { shared_workspaces: [join(root, 'last')] },
      codex: { binary_path: 'chosen' },
      claude: { binary_path: 'selected' },
    });
  });

  it.each([' ', 'line\nfeed', '\rboundary', 'nul\0byte', 'x'.repeat(4097)])(
    'rejects invalid paths in files and writes: %j',
    async (value) => {
      const { create, configFilePath } = fixture();
      const manager = create();
      const before = readFileSync(configFilePath, 'utf8');
      await expect(manager.configureSharedWorkspaces([value])).rejects.toThrow();
      expect(readFileSync(configFilePath, 'utf8')).toBe(before);
      const invalid = stringify({ paths: { shared_workspaces: [value] } });
      writeFileSync(configFilePath, invalid);
      expect(() => create()).toThrow('paths.shared_workspaces');
      await expect(manager.configureSharedWorkspaces([])).rejects.toThrow();
      expect(readFileSync(configFilePath, 'utf8')).toBe(invalid);
      writeFileSync(configFilePath, '');
      await manager.configureSharedWorkspaces([]);
      expect(manager.current.sharedWorkspacePaths).toEqual([]);
    },
  );
});
