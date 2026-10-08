import type { ConfigManager } from '@isles/config';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from '../logging.js';
import type { AgentRecord } from '../storage/store.js';
import { agentRoot, MCP_TOKEN_ENV, type AgentWorkspace } from '../runtime/workspace.js';
import { findClaudeExecutable, type ClaudeExecutable } from './executable.js';

const exec = promisify(execFile);
const begin = '<!-- isles:begin -->';
const end = '<!-- isles:end -->';

export class ClaudeEnvironment {
  readonly home: string;
  readonly log: Logger;
  private selected: ClaudeExecutable | undefined;
  private discovery: Promise<ClaudeExecutable> | undefined;
  constructor(
    readonly config: ConfigManager,
    readonly workspace: AgentWorkspace,
  ) {
    this.home = config.current.claudeHome;
    this.log = workspace.log.child({ harness: 'claude' });
  }
  get redactor() {
    return this.workspace.redactor;
  }
  get binaryPath() {
    return this.selected?.path ?? null;
  }
  get env() {
    return { CLAUDE_CONFIG_DIR: this.home };
  }
  invalidate() {
    this.discovery = undefined;
    this.selected = undefined;
  }
  async executable(refresh = false) {
    if (refresh) this.invalidate();
    this.discovery ??= findClaudeExecutable({ binary: this.config.current.claudeBinaryPath });
    const discovery = this.discovery;
    try {
      const executable = await discovery;
      if (this.discovery === discovery) this.selected = executable;
      return executable;
    } catch (error) {
      if (this.discovery === discovery) this.discovery = undefined;
      throw error;
    }
  }
  async learnSecrets() {
    this.redactor.add(process.env);
    for (const path of [
      join(this.home, '.credentials.json'),
      join(this.home, 'settings.json'),
      `${this.home}.json`,
    ]) {
      try {
        this.redactor.add(JSON.parse(await readFile(path, 'utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new Error(`无法读取 Claude Code 配置：${path}`, { cause: error });
      }
    }
  }
  async authentication(command: ClaudeExecutable) {
    const result = await exec(command.file, [...command.args, 'auth', 'status', '--json'], {
      env: { ...process.env, ...this.env },
      timeout: 15_000,
      maxBuffer: 256_000,
      windowsHide: true,
    }).catch((error: unknown) => {
      // An unauthenticated CLI returns nonzero together with its JSON status.
      if (
        error &&
        typeof error === 'object' &&
        'stdout' in error &&
        typeof error.stdout === 'string'
      )
        return { stdout: error.stdout };
      throw new Error('无法检测 Claude Code 原生认证，请检查 CLI 安装与配置。');
    });
    const status: unknown = JSON.parse(result.stdout);
    this.redactor.add(status);
    return Boolean(
      status && typeof status === 'object' && 'loggedIn' in status && status.loggedIn === true,
    );
  }
  async launch(agent: AgentRecord) {
    await this.workspace.prepareWorkspace(agent);
    await this.prepareClaudeGuidance(agent.workspace);
    await this.learnSecrets();
    return {
      ...this.env,
      [MCP_TOKEN_ENV]: await this.workspace.token(agentRoot(this.workspace.dataDir, agent)),
    };
  }
  private async prepareClaudeGuidance(workspace: string) {
    const path = join(workspace, 'CLAUDE.md');
    let previous = '';
    try {
      previous = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const starts = [...previous.matchAll(/^<!-- isles:begin -->\r?$/gm)];
    const ends = [...previous.matchAll(/^<!-- isles:end -->\r?$/gm)];
    if (
      starts.length > 1 ||
      ends.length > 1 ||
      starts.length !== ends.length ||
      (starts.length && starts[0]!.index! >= ends[0]!.index!)
    )
      throw new Error(`CLAUDE.md 的 Isles 托管段标记无效，请检查 ${path}`);
    const section = `${begin}\n@AGENTS.md\n${end}`;
    const next = starts.length
      ? previous.slice(0, starts[0]!.index) +
        section +
        previous.slice(ends[0]!.index! + ends[0]![0].length)
      : `${section}\n${previous ? `\n${previous}` : ''}`;
    if (next === previous) return;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, next, { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
