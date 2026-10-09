import type { HarnessDescriptor } from '@isles/contracts';
import type { Redactor } from '../../errors.js';
import type { CliExecutable } from '../shared/executable.js';
import type { Logger } from '../../logging.js';
import type { AgentRecord } from '../../storage/store.js';
import type { AcpConnection } from './client.js';

/** What one ACP agent adds to the generic adapter: discovery, launch and native checks. */
export interface AcpHarness {
  readonly descriptor: HarnessDescriptor;
  /** The native home shared by every Agent of this harness. */
  readonly home: string;
  readonly redactor: Redactor;
  readonly log: Logger;
  /** Platform data directory; the catalog probe runs in a fixed folder beneath it. */
  readonly dataDir: string;
  /** Arguments that start the agent's ACP server on stdio. */
  readonly args: string[];
  /** Environment layered over the service environment for every native process. */
  readonly env: Record<string, string>;
  /** The mode each session runs in: tools run without approval and user questions stay on. */
  readonly sessionMode: string;
  readonly binaryPath: string | null;
  executable(refresh?: boolean): Promise<CliExecutable>;
  invalidate(): void;
  learnSecrets(): Promise<void>;
  /** Prepares the Agent workspace and returns the bearer token of its Isles MCP endpoint. */
  prepare(agent: AgentRecord): Promise<string>;
  /** Reports native login without starting a model turn. */
  authenticated(client: AcpConnection): Promise<boolean>;
}
