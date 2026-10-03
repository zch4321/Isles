import type { ConfigManager } from '@isles/config';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Redactor } from '../errors.js';
import type { AgentRecord } from '../storage/store.js';
import { prepareGuidance } from './guidance.js';

export const MCP_TOKEN_ENV = 'ISLES_MCP_TOKEN';
export const agentRoot = (dataDir: string, agent: Pick<AgentRecord, 'id'>) =>
  join(dataDir, 'agents', agent.id);

/** Application-owned workspaces, shared files and MCP credentials, independent of a harness. */
export class AgentWorkspace {
  readonly dataDir: string;
  readonly sharedDir: string;
  readonly redactor = new Redactor();
  constructor(config: ConfigManager) {
    this.dataDir = config.current.dataDir;
    this.sharedDir = config.current.sharedDir;
  }
  async token(dir: string): Promise<string> {
    const path = join(dir, 'isles-mcp-token');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let token: string;
    try {
      token = (await readFile(path, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      token = randomBytes(32).toString('hex');
      const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, token, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    }
    this.redactor.add(token);
    return token;
  }
  async prepareWorkspace(agent: AgentRecord) {
    await mkdir(agent.workspace, { recursive: true });
    await mkdir(this.sharedDir, { recursive: true });
    await writeFile(join(agent.workspace, '.isles-root'), 'Isles Agent workspace\n');
    await prepareGuidance(agent, this.sharedDir);
    await this.token(agentRoot(this.dataDir, agent));
  }
}
