import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { DshEnvironment } from '../src/harness/dsh/environment.js';
import { AgentWorkspace } from '../src/runtime/workspace.js';
import type { AgentRecord } from '../src/storage/store.js';
import { dshConfig } from './dsh-fixture.js';

const electron = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';

it.skipIf(!existsSync(electron))(
  'loads the generated overlay through native DSH and confines file tools and Seatbelt writes without a model',
  async () => {
    const root = await mkdtemp(join(homedir(), '.isles-dsh-sandbox-check-'));
    try {
      const { config, home } = await dshConfig(root);
      const workspace = new AgentWorkspace(config);
      const environment = new DshEnvironment(config, workspace);
      const agent: AgentRecord = {
        id: randomUUID(),
        channelId: randomUUID(),
        name: 'DSH sandbox fixture',
        harness: 'dsh',
        model: 'default',
        reasoningEffort: 'default',
        workspace: join(root, 'agent', 'workspace'),
        nativeHome: home,
        threadId: null,
        threadCreationAttempted: false,
        canCreateGroups: false,
        steerEnabled: false,
        dangerFullAccess: false,
        desiredState: 'running',
        status: 'creating',
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const runtime = await environment.runtime(agent.workspace, agent);
      const result = await promisify(execFile)(
        electron,
        [
          '--expose-internals',
          fileURLToPath(new URL('./dsh-native-sandbox-check.mjs', import.meta.url)),
          root,
          runtime.args[3]!,
          agent.workspace,
          workspace.sharedDir,
        ],
        {
          env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
          timeout: 20_000,
        },
      );
      expect(JSON.parse(result.stdout.trim())).toEqual({
        nativeOverlay: true,
        nativeFileTools: true,
        fs: true,
        seatbelt: true,
        linuxProfiles: true,
        windowsGrantContract: true,
        nativeApprovalAudit: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  25_000,
);
