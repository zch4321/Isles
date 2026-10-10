import type { ConfigManager } from '@isles/config';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import type { CliExecutable } from '../shared/executable.js';
import type { Logger } from '../../logging.js';
import type { AgentWorkspace } from '../../runtime/workspace.js';
import { findKimiExecutable } from './executable.js';

/** Native discovery and secret redaction shared by Kimi's local interfaces. */
export class KimiEnvironment {
  readonly home: string;
  readonly log: Logger;
  private selected: CliExecutable | undefined;
  private discovery: Promise<CliExecutable> | undefined;
  constructor(
    readonly config: ConfigManager,
    readonly workspace: AgentWorkspace,
  ) {
    this.home = config.current.cli.kimi.home;
    this.log = workspace.log.child({ harness: 'kimi' });
  }
  get redactor() {
    return this.workspace.redactor;
  }
  get dataDir() {
    return this.workspace.dataDir;
  }
  get env() {
    return { KIMI_CODE_HOME: this.home };
  }
  get binaryPath() {
    return this.selected?.path ?? null;
  }
  invalidate() {
    this.discovery = undefined;
    this.selected = undefined;
  }
  async executable(refresh = false) {
    if (refresh) this.invalidate();
    this.discovery ??= findKimiExecutable({ binary: this.config.current.cli.kimi.binaryPath });
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
  /**
   * Native errors and tool output may echo credentials from the shared home. They are
   * read only to scrub them; nothing in the home is copied or written.
   */
  async learnSecrets() {
    this.redactor.add(process.env);
    const files: [string, (text: string) => unknown][] = [
      [join(this.home, 'config.toml'), parse],
      [join(this.home, 'server.token'), (text) => ({ token: text.trim() })],
    ];
    try {
      for (const name of await readdir(join(this.home, 'credentials')))
        if (name.endsWith('.json')) files.push([join(this.home, 'credentials', name), JSON.parse]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('无法读取 Kimi Code 凭据目录', { cause: error });
    }
    for (const [path, read] of files) {
      try {
        this.redactor.add(read(await readFile(path, 'utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new Error(`无法读取 Kimi Code 配置：${path}`, { cause: error });
      }
    }
  }
}
