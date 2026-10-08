import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigManager } from '../src/index.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(contents: string, environment: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'isles-claude-config-'));
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
    expect(manager.current).toMatchObject({
      claudeHome: join(root, 'native'),
      claudeBinaryPath: join(root, 'bin', 'claude'),
    });
    expect(manager.claudeConfiguration()).toMatchObject({
      binaryPath: 'file-claude',
      environmentBinaryPath: join(root, 'bin', 'claude'),
    });
    expect(
      fixture('', { CLAUDE_CONFIG_DIR: 'native-profile' }).manager.current.claudeHome,
    ).toContain('native-profile');
    expect(
      fixture('[claude]\nhome = "file-profile"\n', { CLAUDE_CONFIG_DIR: 'ignored' }).manager.current
        .claudeHome,
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
      manager.configureCodexBinary('codex-new'),
      manager.configureClaudeBinary('~/bin/claude'),
    ]);
    expect(parse(readFileSync(configFilePath, 'utf8'))).toMatchObject({
      server: { port: 4555 },
      codex: { home: 'codex-profile', binary_path: 'codex-new' },
      claude: { home: 'claude-profile', binary_path: '~/bin/claude' },
    });
    expect(manager.current).toMatchObject({
      port: before.port,
      dataDir: before.dataDir,
      claudeHome: before.claudeHome,
      claudeBinaryPath: join(root, 'bin', 'claude'),
    });
    await manager.configureClaudeBinary(null);
    expect(parse(readFileSync(configFilePath, 'utf8'))).toMatchObject({
      codex: { binary_path: 'codex-new' },
      claude: { home: 'claude-profile' },
    });
    expect(manager.current.claudeBinaryPath).toBeNull();
  });
  it('rejects invalid Claude paths without replacing the last working configuration', async () => {
    const { manager, configFilePath } = fixture('[claude]\nbinary_path = "claude"\n');
    const before = readFileSync(configFilePath, 'utf8');
    await expect(manager.configureClaudeBinary('"   "')).rejects.toThrow('must be nonempty');
    expect(readFileSync(configFilePath, 'utf8')).toBe(before);
  });
});
