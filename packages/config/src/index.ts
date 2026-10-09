import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';

const pathSchema = z.string().trim().min(1);
function unquoteBinary(value: string): string {
  return value.replace(/^"([\s\S]*)"$/, '$1');
}
const binarySchema = pathSchema.refine((value) => unquoteBinary(value).trim().length > 0, {
  message: 'Binary path must not be empty or quoted whitespace',
});
const portSchema = z.number().int().min(1).max(65_535);
export const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof logLevels)[number];
const logLevelSchema = z.enum(logLevels);

/** Native CLI harnesses whose executable and home Isles configures. */
const cliHarnesses = {
  codex: {
    binaryVariable: 'ISLES_CODEX_BIN',
    homeVariable: 'ISLES_CODEX_HOME',
    nativeHomeVariable: 'CODEX_HOME',
    defaultHome: '.codex',
  },
  claude: {
    binaryVariable: 'ISLES_CLAUDE_BIN',
    homeVariable: 'ISLES_CLAUDE_HOME',
    nativeHomeVariable: 'CLAUDE_CONFIG_DIR',
    defaultHome: '.claude',
  },
  opencode: {
    binaryVariable: 'ISLES_OPENCODE_BIN',
    homeVariable: 'ISLES_OPENCODE_HOME',
    nativeHomeVariable: 'OPENCODE_CONFIG_DIR',
    defaultHome: '.config/opencode',
  },
  kimi: {
    binaryVariable: 'ISLES_KIMI_BIN',
    homeVariable: 'ISLES_KIMI_HOME',
    nativeHomeVariable: 'KIMI_CODE_HOME',
    defaultHome: '.kimi-code',
  },
  dsh: {
    binaryVariable: 'ISLES_DSH_BIN',
    homeVariable: 'ISLES_DSH_HOME',
    nativeHomeVariable: 'DSH_HOME',
    defaultHome: '.dsh',
  },
} as const;
export type CliHarness = keyof typeof cliHarnesses;
export const cliHarnessIds = Object.keys(cliHarnesses) as CliHarness[];
export function isCliHarness(id: string): id is CliHarness {
  return Object.hasOwn(cliHarnesses, id);
}
const cliSectionSchema = z
  .strictObject({ binary_path: binarySchema.optional(), home: pathSchema.optional() })
  .optional();
const fileSchema = z.strictObject({
  server: z.strictObject({ port: portSchema.optional() }).optional(),
  paths: z
    .strictObject({
      data_dir: pathSchema.optional(),
      workspace_dir: pathSchema.optional(),
      log_dir: pathSchema.optional(),
    })
    .optional(),
  log: z.strictObject({ level: logLevelSchema.optional() }).optional(),
  codex: cliSectionSchema,
  claude: cliSectionSchema,
  kimi: cliSectionSchema,
  opencode: cliSectionSchema,
  dsh: cliSectionSchema,
  dev: z.strictObject({ port: portSchema.optional() }).optional(),
});
const environmentSchema = z.object({
  ISLES_SERVER_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  ISLES_WEB_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  ISLES_DATA_DIR: pathSchema.optional(),
  ISLES_LOG_LEVEL: logLevelSchema.optional(),
  ISLES_CODEX_BIN: binarySchema.optional(),
  ISLES_CODEX_HOME: pathSchema.optional(),
  CODEX_HOME: pathSchema.optional(),
  ISLES_CLAUDE_BIN: binarySchema.optional(),
  ISLES_CLAUDE_HOME: pathSchema.optional(),
  CLAUDE_CONFIG_DIR: pathSchema.optional(),
  ISLES_KIMI_BIN: binarySchema.optional(),
  ISLES_KIMI_HOME: pathSchema.optional(),
  KIMI_CODE_HOME: pathSchema.optional(),
  ISLES_OPENCODE_BIN: binarySchema.optional(),
  ISLES_OPENCODE_HOME: pathSchema.optional(),
  OPENCODE_CONFIG_DIR: pathSchema.optional(),
  XDG_CONFIG_HOME: pathSchema.optional(),
  XDG_DATA_HOME: pathSchema.optional(),
  OPENCODE_DB: pathSchema
    .refine((value) => value !== ':memory:', {
      message: 'OpenCode requires a persistent database path',
    })
    .optional(),
  ISLES_DSH_BIN: binarySchema.optional(),
  ISLES_DSH_HOME: pathSchema.optional(),
  DSH_HOME: pathSchema.optional(),
});

const defaultToml = `# Isles configuration. Paths are relative to this file's directory.
# Changes to ports and directories require a restart.
[server]
port = 4310

[paths]
data_dir = "data"
workspace_dir = "workspace"
log_dir = "logs"

[log]
# fatal, error, warn, info, debug, trace or silent
level = "info"

[codex]
# binary_path = "codex"
# home = "~/.codex"

[claude]
# binary_path = "claude"
# home = "~/.claude"

[kimi]
# binary_path = "kimi"
# home = "~/.kimi-code"

[opencode]
# binary_path = "opencode"
# home = "~/.config/opencode"

[dsh]
# binary_path = "dsh"
# home = "~/.dsh"

[dev]
port = 5173
`;

type FileConfig = z.infer<typeof fileSchema>;

export interface AppConfig {
  readonly configFilePath: string;
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly webPort: number;
  readonly dataDir: string;
  readonly workspaceDir: string;
  readonly sharedDir: string;
  readonly logDir: string;
  readonly logLevel: LogLevel;
  readonly cli: Readonly<Record<CliHarness, CliPaths>>;
}

export interface CliPaths {
  readonly home: string;
  /** The environment override when set, otherwise the TOML value. */
  readonly binaryPath: string | null;
  /** OpenCode stores native sessions and login credentials in the same database. */
  readonly databasePath?: string;
}

export interface CliConfiguration {
  binaryPath: string | null;
  environmentBinaryPath: string | null;
  configFilePath: string;
}

export interface ConfigManagerOptions {
  configFilePath?: string;
  environment?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export class ConfigurationError extends Error {
  constructor(
    readonly configFilePath: string,
    details: string,
  ) {
    super(`Invalid Isles configuration at "${configFilePath}": ${details}`);
    this.name = 'ConfigurationError';
  }
}

function describeValidation(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

/** Node-only configuration shared by the server, database tools, and Vite. */
export class ConfigManager {
  private static readonly writes = new Map<string, Promise<void>>();
  private snapshot: AppConfig;
  private readonly homeDir: string;
  private readonly binaries = {} as Record<
    CliHarness,
    { file: string | null; readonly environment: string | null }
  >;

  constructor(options: ConfigManagerOptions = {}) {
    this.homeDir = resolve(options.homeDir ?? homedir());
    const environment = options.environment ?? process.env;
    const configFilePath = this.resolvePath(
      options.configFilePath ??
        environment.ISLES_CONFIG_FILE ??
        join(this.homeDir, '.Isles/config.toml'),
      process.cwd(),
    );
    const parsedEnvironment = environmentSchema.safeParse(environment);
    if (!parsedEnvironment.success) {
      throw this.configurationError(configFilePath, describeValidation(parsedEnvironment.error));
    }
    mkdirSync(dirname(configFilePath), { recursive: true });
    try {
      writeFileSync(configFilePath, defaultToml, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw this.configurationError(configFilePath, `cannot create file: ${String(error)}`);
      }
    }
    const file = this.readFile(configFilePath);
    const env = parsedEnvironment.data;
    const base = dirname(configFilePath);
    const workspaceDir = this.resolvePath(file.paths?.workspace_dir ?? 'workspace', base);
    const cli = {} as Record<CliHarness, CliPaths>;
    for (const id of cliHarnessIds) {
      const spec = cliHarnesses[id];
      const binary = {
        file: this.resolveBinary(file[id]?.binary_path, base),
        environment: this.resolveBinary(env[spec.binaryVariable], base),
      };
      this.binaries[id] = binary;
      // Home precedence: Isles environment > TOML > the CLI's own variable > default.
      cli[id] = Object.freeze({
        home: this.resolvePath(
          env[spec.homeVariable] ??
            file[id]?.home ??
            (id === 'opencode' && env.OPENCODE_CONFIG_DIR
              ? resolve(env.OPENCODE_CONFIG_DIR)
              : env[spec.nativeHomeVariable]) ??
            (id === 'opencode' && env.XDG_CONFIG_HOME
              ? resolve(env.XDG_CONFIG_HOME, 'opencode')
              : join(this.homeDir, spec.defaultHome)),
          base,
        ),
        binaryPath: binary.environment ?? binary.file,
        ...(id === 'opencode'
          ? {
              databasePath: resolve(
                env.XDG_DATA_HOME ?? join(this.homeDir, '.local', 'share'),
                'opencode',
                env.OPENCODE_DB ?? 'opencode.db',
              ),
            }
          : {}),
      });
    }
    this.snapshot = Object.freeze({
      configFilePath,
      host: '127.0.0.1',
      port: env.ISLES_SERVER_PORT ?? file.server?.port ?? 4310,
      webPort: env.ISLES_WEB_PORT ?? file.dev?.port ?? 5173,
      dataDir: this.resolvePath(env.ISLES_DATA_DIR ?? file.paths?.data_dir ?? 'data', base),
      workspaceDir,
      sharedDir: join(workspaceDir, 'shared'),
      logDir: this.resolvePath(file.paths?.log_dir ?? 'logs', base),
      logLevel: env.ISLES_LOG_LEVEL ?? file.log?.level ?? 'info',
      cli: Object.freeze(cli),
    });
  }

  get current(): AppConfig {
    return this.snapshot;
  }

  cliConfiguration(harness: CliHarness): CliConfiguration {
    return {
      binaryPath: this.binaries[harness].file,
      environmentBinaryPath: this.binaries[harness].environment,
      configFilePath: this.current.configFilePath,
    };
  }

  async configureCliBinary(
    harness: CliHarness,
    binaryPath: string | null,
  ): Promise<CliConfiguration> {
    const selected = binaryPath === null ? null : binarySchema.safeParse(binaryPath);
    if (selected !== null && !selected.success) {
      throw this.configurationError(
        this.current.configFilePath,
        `${harness}.binary_path must be nonempty`,
      );
    }
    const value = selected === null ? null : selected.data;
    const filePath = this.current.configFilePath;
    const previous = ConfigManager.writes.get(filePath) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const file = this.readFile(filePath);
      if (value === null) {
        if (file[harness]) delete file[harness].binary_path;
      } else {
        file[harness] = { ...file[harness], binary_path: value };
      }
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, stringify(file), {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
        await rename(temporaryPath, filePath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw this.configurationError(filePath, `cannot write file: ${String(error)}`);
      }
      const binary = this.binaries[harness];
      binary.file = this.resolveBinary(value ?? undefined, dirname(filePath));
      this.snapshot = Object.freeze({
        ...this.snapshot,
        cli: Object.freeze({
          ...this.snapshot.cli,
          [harness]: Object.freeze({
            ...this.snapshot.cli[harness],
            binaryPath: binary.environment ?? binary.file,
          }),
        }),
      });
      return this.cliConfiguration(harness);
    });
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    ConfigManager.writes.set(filePath, settled);
    void settled.then(() => {
      if (ConfigManager.writes.get(filePath) === settled) ConfigManager.writes.delete(filePath);
    });
    return operation;
  }

  private resolvePath(value: string, base: string): string {
    const trimmed = pathSchema.safeParse(value);
    if (!trimmed.success) throw new Error('Isles configuration path must be nonempty');
    const path = trimmed.data;
    if (path === '~') return this.homeDir;
    if (path.startsWith('~/') || path.startsWith('~\\')) {
      return resolve(this.homeDir, path.slice(2));
    }
    return resolve(base, path);
  }

  private resolveBinary(value: string | undefined, base: string): string | null {
    if (value === undefined) return null;
    const binary = unquoteBinary(value);
    return binary === '~' || /[/\\]/.test(binary) || isAbsolute(binary)
      ? this.resolvePath(binary, base)
      : binary;
  }

  private readFile(filePath: string): FileConfig {
    let raw: unknown;
    try {
      raw = parse(readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw this.configurationError(filePath, `cannot read TOML: ${String(error)}`);
    }
    const result = fileSchema.safeParse(raw);
    if (!result.success) {
      throw this.configurationError(filePath, describeValidation(result.error));
    }
    return result.data;
  }

  private configurationError(filePath: string, details: string): ConfigurationError {
    return new ConfigurationError(filePath, details);
  }
}
