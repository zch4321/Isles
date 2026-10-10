// Test-only harness configuration for the generic ACP adapter conformance suite.
import type { HarnessDescriptor } from '@isles/contracts';
import { AcpRpcError, type AcpConnection } from '../src/harness/acp/client.js';
import type { AcpHarness } from '../src/harness/acp/harness.js';
import { KimiEnvironment } from '../src/harness/kimi/environment.js';
import { agentRoot } from '../src/runtime/workspace.js';
import type { AgentRecord } from '../src/storage/store.js';

export class KimiAcpHarness extends KimiEnvironment implements AcpHarness {
  readonly descriptor: HarnessDescriptor = {
    id: 'kimi',
    displayName: 'ACP fixture',
    configuration: 'cli-path',
    capabilities: {
      sessionResume: true,
      interrupt: true,
      steer: false,
      userQuestions: true,
      nativeSubagents: true,
      mcp: true,
      workspaceInstructions: true,
    },
  };
  readonly args = ['acp'];
  readonly sessionMode = 'yolo';
  async prepare(agent: AgentRecord) {
    await this.workspace.prepareWorkspace(agent);
    return this.workspace.token(agentRoot(this.workspace.dataDir, agent));
  }
  async authenticated(client: AcpConnection) {
    try {
      await client.request('authenticate', { methodId: 'login' });
      return true;
    } catch (error) {
      if (error instanceof AcpRpcError && error.code === -32000) return false;
      throw error;
    }
  }
}
