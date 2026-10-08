import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigManager, isCliHarness } from '../src/index.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(contents: string, environment: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'isles-cli-config-'));
  roots.push(root);
  const configFilePath = join(root, 'config.toml');
  writeFileSync(configFilePath, contents);
  return {
    root,
    configFilePath,
    manager: new ConfigManager({ configFilePath, homeDir: root, environment }),
  };
}

describe('Claude configuration', () => {
  it('resolves Claude home and executable with environment > TOML > native environment > default precedence', () => {
    const { root, manager } = fixture('[claude]\nhome = "profile"\nbinary_path = "file-claude"\n', {
      ISLES_CLAUDE_HOME: '~/native',
      ISLES_CLAUDE_BIN: './bin/claude',
      CLAUDE_CONFIG_DIR: 'ignored',
    });
    expect(manager.current.cli.claude).toEqual({
      home: join(root, 'native'),
      binaryPath: join(root, 'bin', 'claude'),
    });
    expect(manager.cliConfiguration('claude')).toMatchObject({
      binaryPath: 'file-claude',
      environmentBinaryPath: join(root, 'bin', 'claude'),
    });
    expect(
      fixture('', { CLAUDE_CONFIG_DIR: 'native-profile' }).manager.current.cli.claude.home,
    ).toContain('native-profile');
    expect(
      fixture('[claude]\nhome = "file-profile"\n', { CLAUDE_CONFIG_DIR: 'ignored' }).manager.current
        .cli.claude.home,
    ).toContain('file-profile');
  });
  it('serializes Codex and Claude saves together without losing disk edits or changing live directories', async () => {
    const { root, manager, configFilePath } = fixture(
      '[paths]\ndata_dir = "data"\n[codex]\nhome = "codex-profile"\n[claude]\nhome = "claude-profile"\n',
    );
    const before = manager.current;
    writeFileSync(
      configFilePath,
      '[server]\nport = 4555\n[codex]\nhome = "codex-profile"\n[claude]\nhome = "claude-profile"\n',
    );
    await Promise.all([
      manager.configureCliBinary('codex', 'codex-new'),
      manager.configureCliBinary('claude', '~/bin/claude'),
    ]);
    expect(parse(readFileSync(configFilePath, 'utf8'))).toMatchObject({
      server: { port: 4555 },
      codex: { home: 'codex-profile', binary_path: 'codex-new' },
      claude: { home: 'claude-profile', binary_path: '~/bin/claude' },
    });
    expect(manager.current).toMatchObject({
      port: before.port,
      dataDir: before.dataDir,
      cli: { claude: { home: before.cli.claude.home, binaryPath: join(root, 'bin', 'claude') } },
    });
    await manager.configureCliBinary('claude', null);
    expect(parse(readFileSync(configFilePath, 'utf8'))).toMatchObject({
      codex: { binary_path: 'codex-new' },
      claude: { home: 'claude-profile' },
    });
    expect(manager.current.cli.claude.binaryPath).toBeNull();
  });
  it('rejects invalid Claude paths without replacing the last working configuration', async () => {
    const { manager, configFilePath } = fixture('[claude]\nbinary_path = "claude"\n');
    const before = readFileSync(configFilePath, 'utf8');
    await expect(manager.configureCliBinary('claude', '"   "')).rejects.toThrow('must be nonempty');
    expect(readFileSync(configFilePath, 'utf8')).toBe(before);
  });
});

describe('Kimi configuration', () => {
  it('resolves Kimi home and executable with environment > TOML > native environment > default precedence', async () => {
    const { root, manager, configFilePath } = fixture(
      '[kimi]\nhome = "kimi-profile"\nbinary_path = "file-kimi"\n',
      { ISLES_KIMI_BIN: './bin/kimi', KIMI_CODE_HOME: 'ignored' },
    );
    expect(manager.current.cli.kimi).toEqual({
      home: join(root, 'kimi-profile'),
      binaryPath: join(root, 'bin', 'kimi'),
    });
    expect(fixture('', { KIMI_CODE_HOME: 'native' }).manager.current.cli.kimi.home).toContain(
      'native',
    );
    const defaults = fixture('');
    expect(defaults.manager.current.cli.kimi.home).toBe(join(defaults.root, '.kimi-code'));
    expect(await manager.configureCliBinary('kimi', null)).toMatchObject({
      binaryPath: null,
      environmentBinaryPath: join(root, 'bin', 'kimi'),
    });
    expect(parse(readFileSync(configFilePath, 'utf8'))).toEqual({ kimi: { home: 'kimi-profile' } });
  });
  it('recognizes only the configured CLI harnesses', () => {
    expect(['codex', 'claude', 'kimi', 'other', 'toString'].map(isCliHarness)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});
