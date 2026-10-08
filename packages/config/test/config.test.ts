import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigManager, ConfigurationError } from '../src/index.js';

const directories: string[] = [];

function fixture(contents?: string) {
  const homeDir = mkdtempSync(join(tmpdir(), 'isles-config-'));
  directories.push(homeDir);
  const configFilePath = join(homeDir, '.Isles', 'config.toml');
  if (contents !== undefined) {
    mkdirSync(dirname(configFilePath), { recursive: true });
    writeFileSync(configFilePath, contents, 'utf8');
  }
  return {
    homeDir,
    configFilePath,
    create: (environment: NodeJS.ProcessEnv = {}) => new ConfigManager({ homeDir, environment }),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ConfigManager startup configuration', () => {
  it('creates the home-level default TOML and resolves default directories beside it', () => {
    const { create, homeDir, configFilePath } = fixture();
    const manager = create();
    expect(manager.current).toEqual({
      configFilePath,
      host: '127.0.0.1',
      port: 4310,
      webPort: 5173,
      dataDir: join(homeDir, '.Isles', 'data'),
      workspaceDir: join(homeDir, '.Isles', 'workspace'),
      sharedDir: join(homeDir, '.Isles', 'workspace', 'shared'),
      logDir: join(homeDir, '.Isles', 'logs'),
      logLevel: 'info',
      cli: {
        codex: { home: join(homeDir, '.codex'), binaryPath: null },
        claude: { home: join(homeDir, '.claude'), binaryPath: null },
        kimi: { home: join(homeDir, '.kimi-code'), binaryPath: null },
      },
    });
    const contents = readFileSync(configFilePath, 'utf8');
    expect(parse(contents)).toEqual({
      server: { port: 4310 },
      paths: { data_dir: 'data', workspace_dir: 'workspace', log_dir: 'logs' },
      log: { level: 'info' },
      codex: {},
      claude: {},
      kimi: {},
      dev: { port: 5173 },
    });
    create();
    expect(readFileSync(configFilePath, 'utf8')).toBe(contents);
    expect(Object.isFrozen(manager.current)).toBe(true);
  });

  it('preserves an existing TOML and uses its values before defaults', () => {
    const contents = `# keep this comment
[server]
port = 4400
[paths]
data_dir = "db"
workspace_dir = "work"
[codex]
binary_path = "codex-custom"
home = "codex-profile"
[dev]
port = 5500
`;
    const { create, homeDir, configFilePath } = fixture(contents);
    const manager = create({ CODEX_HOME: 'fallback-ignored' });
    expect(manager.current).toMatchObject({
      port: 4400,
      webPort: 5500,
      dataDir: join(homeDir, '.Isles', 'db'),
      workspaceDir: join(homeDir, '.Isles', 'work'),
      sharedDir: join(homeDir, '.Isles', 'work', 'shared'),
      cli: {
        codex: { home: join(homeDir, '.Isles', 'codex-profile'), binaryPath: 'codex-custom' },
      },
    });
    expect(readFileSync(configFilePath, 'utf8')).toBe(contents);
  });

  it('gives environment overrides priority over TOML values', () => {
    const { create, homeDir } = fixture(`
[server]
port = 4400
[paths]
data_dir = "file-db"
[codex]
binary_path = "file-codex"
home = "file-home"
[dev]
port = 5500
`);
    const manager = create({
      ISLES_SERVER_PORT: '4500',
      ISLES_WEB_PORT: '5600',
      ISLES_DATA_DIR: 'env-db',
      ISLES_CODEX_BIN: './env-codex',
      ISLES_CODEX_HOME: 'env-home',
      CODEX_HOME: 'fallback-home',
    });
    expect(manager.current).toMatchObject({
      port: 4500,
      webPort: 5600,
      dataDir: join(homeDir, '.Isles', 'env-db'),
      cli: {
        codex: {
          home: join(homeDir, '.Isles', 'env-home'),
          binaryPath: join(homeDir, '.Isles', 'env-codex'),
        },
      },
    });
    expect(manager.cliConfiguration('codex')).toMatchObject({
      binaryPath: 'file-codex',
      environmentBinaryPath: join(homeDir, '.Isles', 'env-codex'),
    });
  });

  it('expands tilde paths in the file and environment and resolves relative paths beside the file', () => {
    const { create, homeDir } = fixture(`
[paths]
data_dir = "~/database"
workspace_dir = "../work"
[codex]
binary_path = "~/bin/codex"
home = "~/profiles/codex"
`);
    expect(create().current).toMatchObject({
      dataDir: join(homeDir, 'database'),
      workspaceDir: join(homeDir, 'work'),
      cli: {
        codex: {
          binaryPath: join(homeDir, 'bin', 'codex'),
          home: join(homeDir, 'profiles', 'codex'),
        },
      },
    });
    expect(create({ ISLES_DATA_DIR: '~\\env-data', ISLES_CODEX_HOME: '~' }).current).toMatchObject({
      dataDir: join(homeDir, 'env-data'),
      cli: { codex: { home: homeDir } },
    });
    expect(create({ ISLES_CODEX_BIN: 'tools/codex' }).current.cli.codex.binaryPath).toBe(
      join(homeDir, '.Isles', 'tools', 'codex'),
    );
  });

  it('reads the log directory and level from TOML with an environment level override', () => {
    const { create, homeDir } = fixture(
      '[paths]\nlog_dir = "~/isles-logs"\n[log]\nlevel = "warn"\n',
    );
    expect(create().current).toMatchObject({
      logDir: join(homeDir, 'isles-logs'),
      logLevel: 'warn',
    });
    expect(create({ ISLES_LOG_LEVEL: 'debug' }).current.logLevel).toBe('debug');
  });

  it('uses CODEX_HOME only when no explicit Codex home exists', () => {
    const { create, homeDir } = fixture('');
    expect(create({ CODEX_HOME: 'profiles/fallback' }).current.cli.codex.home).toBe(
      join(homeDir, '.Isles', 'profiles', 'fallback'),
    );
    expect(create({ CODEX_HOME: '~/fallback' }).current.cli.codex.home).toBe(
      join(homeDir, 'fallback'),
    );
  });

  it('accepts explicit and environment-selected config files', () => {
    const { homeDir } = fixture();
    const override = new ConfigManager({
      homeDir,
      environment: { ISLES_CONFIG_FILE: '~/settings/config.toml' },
    });
    expect(override.current.configFilePath).toBe(join(homeDir, 'settings', 'config.toml'));
    expect(override.current.dataDir).toBe(join(homeDir, 'settings', 'data'));
    const explicit = new ConfigManager({
      homeDir,
      configFilePath: join(homeDir, 'explicit', 'settings.toml'),
      environment: { ISLES_CONFIG_FILE: '~/ignored.toml' },
    });
    expect(explicit.current.configFilePath).toBe(join(homeDir, 'explicit', 'settings.toml'));
  });

  it.each([
    ['[server]\nport = "4310"', 'server.port'],
    ['[server]\nport = 0', 'server.port'],
    ['[dev]\nport = 65536', 'dev.port'],
    ['[paths]\ndata_dir = " "', 'paths.data_dir'],
    ['[paths]\nworkspace_dir = 1', 'paths.workspace_dir'],
    ['[paths]\nlog_dir = ""', 'paths.log_dir'],
    ['[log]\nlevel = "verbose"', 'log.level'],
    ['[codex]\nbinary_path = false', 'codex.binary_path'],
    ['[codex]\nhome = ""', 'codex.home'],
    ['[server]\nhost = "0.0.0.0"', 'server'],
    ['secret = "not-supported"', '<root>'],
  ])('rejects invalid TOML fields without fallback: %s', (contents, field) => {
    const { create, configFilePath } = fixture(contents);
    expect(() => create()).toThrow(field);
    expect(() => create()).toThrow(configFilePath);
    expect(readFileSync(configFilePath, 'utf8')).toBe(contents);
  });

  it('rejects malformed TOML with the source filename', () => {
    const { create, configFilePath } = fixture('[server\nport = 4310');
    expect(() => create()).toThrow('cannot read TOML');
    expect(() => create()).toThrow(configFilePath);
  });

  it.each([
    ['ISLES_SERVER_PORT', 'invalid'],
    ['ISLES_WEB_PORT', '0'],
    ['ISLES_DATA_DIR', ''],
    ['ISLES_CODEX_BIN', ' '],
    ['ISLES_CODEX_HOME', ''],
    ['ISLES_LOG_LEVEL', 'verbose'],
  ])('rejects invalid environment override %s', (key, value) => {
    const { create, configFilePath } = fixture('');
    expect(() => create({ [key]: value })).toThrow(key);
    expect(() => create({ [key]: value })).toThrow(configFilePath);
  });
});

describe('ConfigManager binary configuration writes', () => {
  it.each(['""', '"   "', '"\t\r\n"'])(
    'rejects quote-only file and environment binaries with the actual custom filename: %s',
    (value) => {
      const { homeDir } = fixture();
      const configFilePath = join(homeDir, 'custom-isles-settings.toml');
      const invalid = stringify({ codex: { binary_path: value } });
      writeFileSync(configFilePath, invalid);
      const fromFile = () => new ConfigManager({ homeDir, configFilePath, environment: {} });
      expect(fromFile).toThrow(ConfigurationError);
      expect(fromFile).toThrow('codex.binary_path');
      expect(fromFile).toThrow(configFilePath);
      expect(readFileSync(configFilePath, 'utf8')).toBe(invalid);

      const valid = '[server]\nport = 4400';
      writeFileSync(configFilePath, valid);
      const fromEnvironment = () =>
        new ConfigManager({
          homeDir,
          configFilePath,
          environment: { ISLES_CODEX_BIN: value },
        });
      expect(fromEnvironment).toThrow('ISLES_CODEX_BIN');
      expect(fromEnvironment).toThrow(ConfigurationError);
      expect(fromEnvironment).toThrow(configFilePath);
      expect(readFileSync(configFilePath, 'utf8')).toBe(valid);
    },
  );

  it.each(['""', '"   "', '"\t\r\n"'])(
    'rejects quote-only UI binaries before changing a custom file or live settings: %s',
    async (value) => {
      const { homeDir } = fixture();
      const configFilePath = join(homeDir, 'custom-isles-settings.toml');
      const manager = new ConfigManager({ homeDir, configFilePath, environment: {} });
      await manager.configureCliBinary('codex', 'codex-valid');
      const before = readFileSync(configFilePath, 'utf8');
      const snapshot = manager.current;
      const failure = manager.configureCliBinary('codex', value);
      await expect(failure).rejects.toBeInstanceOf(ConfigurationError);
      await expect(failure).rejects.toThrow('codex.binary_path');
      await expect(failure).rejects.toThrow(configFilePath);
      expect(readFileSync(configFilePath, 'utf8')).toBe(before);
      expect(manager.current).toBe(snapshot);
      expect(manager.cliConfiguration('codex').binaryPath).toBe('codex-valid');
    },
  );

  it.each(['absolute', 'relative', 'tilde', 'command'] as const)(
    'resolves a quoted %s UI binary before classification and after restart',
    async (kind) => {
      const { create, configFilePath, homeDir } = fixture();
      const binaries = {
        absolute: {
          value: join(homeDir, 'Program Files', 'Codex', 'codex.exe'),
          expected: join(homeDir, 'Program Files', 'Codex', 'codex.exe'),
        },
        relative: {
          value: './Program Files/Codex/codex.exe',
          expected: join(homeDir, '.Isles', 'Program Files', 'Codex', 'codex.exe'),
        },
        tilde: {
          value: '~/Program Files/Codex/codex.exe',
          expected: join(homeDir, 'Program Files', 'Codex', 'codex.exe'),
        },
        command: { value: 'codex-custom', expected: 'codex-custom' },
      };
      const { value, expected } = binaries[kind];
      const manager = create();
      const quoted = `"${value}"`;
      expect(await manager.configureCliBinary('codex', quoted)).toMatchObject({
        binaryPath: expected,
      });
      expect(manager.current.cli.codex.binaryPath).toBe(expected);
      expect(parse(readFileSync(configFilePath, 'utf8'))).toMatchObject({
        codex: { binary_path: quoted },
      });
      expect(create().current.cli.codex.binaryPath).toBe(expected);
    },
  );

  it('resolves quoted environment binaries before applying their priority', async () => {
    const { create, homeDir } = fixture();
    const environmentBinaryPath = join(homeDir, 'Program Files', 'Codex', 'codex.exe');
    const manager = create({ ISLES_CODEX_BIN: `"${environmentBinaryPath}"` });
    expect(manager.cliConfiguration('codex').environmentBinaryPath).toBe(environmentBinaryPath);
    expect(await manager.configureCliBinary('codex', '"codex-custom"')).toMatchObject({
      binaryPath: 'codex-custom',
      environmentBinaryPath,
    });
    expect(manager.current.cli.codex.binaryPath).toBe(environmentBinaryPath);
  });

  it('rereads current disk values and changes only the binary selection live', async () => {
    const { create, configFilePath, homeDir } = fixture();
    const manager = create();
    const snapshot = manager.current;
    writeFileSync(
      configFilePath,
      `[server]
port = 4500
[paths]
data_dir = "edited-data"
workspace_dir = "edited-workspace"
[codex]
home = "edited-home"
[dev]
port = 5600
`,
    );
    const result = await manager.configureCliBinary('codex', './tools/codex');
    expect(result).toEqual({
      binaryPath: join(homeDir, '.Isles', 'tools', 'codex'),
      environmentBinaryPath: null,
      configFilePath,
    });
    expect(parse(readFileSync(configFilePath, 'utf8'))).toEqual({
      server: { port: 4500 },
      paths: { data_dir: 'edited-data', workspace_dir: 'edited-workspace' },
      codex: { home: 'edited-home', binary_path: './tools/codex' },
      dev: { port: 5600 },
    });
    expect(manager.current).toEqual({
      ...snapshot,
      cli: { ...snapshot.cli, codex: { ...snapshot.cli.codex, binaryPath: result.binaryPath } },
    });
    expect(create().current).toMatchObject({
      port: 4500,
      webPort: 5600,
      dataDir: join(homeDir, '.Isles', 'edited-data'),
      workspaceDir: join(homeDir, '.Isles', 'edited-workspace'),
      cli: { codex: { home: join(homeDir, '.Isles', 'edited-home') } },
    });
    expect(readdirSync(dirname(configFilePath))).toEqual(['config.toml']);
  });

  it('clears the stored binary while preserving environment priority and Codex home', async () => {
    const { create, configFilePath } = fixture('[codex]\nbinary_path = "old"\nhome = "~/profile"');
    const manager = create({ ISLES_CODEX_BIN: 'env-codex' });
    expect(await manager.configureCliBinary('codex', 'new')).toMatchObject({
      binaryPath: 'new',
      environmentBinaryPath: 'env-codex',
    });
    expect(manager.current.cli.codex.binaryPath).toBe('env-codex');
    expect(await manager.configureCliBinary('codex', null)).toMatchObject({
      binaryPath: null,
      environmentBinaryPath: 'env-codex',
    });
    expect(parse(readFileSync(configFilePath, 'utf8'))).toEqual({ codex: { home: '~/profile' } });
    expect(create().current.cli.codex.binaryPath).toBeNull();
  });

  it('serializes concurrent writes across managers sharing a file', async () => {
    const { create, configFilePath } = fixture('[server]\nport = 4500');
    const first = create();
    const second = create();
    const responses = await Promise.all([
      first.configureCliBinary('codex', 'first'),
      second.configureCliBinary('codex', 'second'),
      first.configureCliBinary('codex', null),
      second.configureCliBinary('codex', 'last'),
    ]);
    expect(responses.map((response) => response.binaryPath)).toEqual([
      'first',
      'second',
      null,
      'last',
    ]);
    expect(parse(readFileSync(configFilePath, 'utf8'))).toEqual({
      server: { port: 4500 },
      codex: { binary_path: 'last' },
    });
    expect(readdirSync(dirname(configFilePath))).toEqual(['config.toml']);
  });

  it('refuses invalid edits without overwriting them and allows subsequent retries', async () => {
    const { create, configFilePath } = fixture();
    const manager = create();
    const invalid = '[server]\nport = "invalid"';
    writeFileSync(configFilePath, invalid);
    await expect(manager.configureCliBinary('codex', 'codex')).rejects.toThrow('server.port');
    expect(readFileSync(configFilePath, 'utf8')).toBe(invalid);
    expect(manager.current.cli.codex.binaryPath).toBeNull();
    writeFileSync(configFilePath, '[server]\nport = 4400');
    await expect(manager.configureCliBinary('codex', 'codex')).resolves.toMatchObject({
      binaryPath: 'codex',
    });
    expect(manager.current.port).toBe(4310);
  });

  it('rejects empty UI values and resolves absolute binary paths', async () => {
    const { create, homeDir, configFilePath } = fixture();
    const manager = create();
    const before = readFileSync(configFilePath, 'utf8');
    await expect(manager.configureCliBinary('codex', ' ')).rejects.toThrow('codex.binary_path');
    expect(readFileSync(configFilePath, 'utf8')).toBe(before);
    const binaryPath = resolve(homeDir, 'bin', 'codex');
    await expect(manager.configureCliBinary('codex', binaryPath)).resolves.toMatchObject({
      binaryPath,
    });
  });
});
