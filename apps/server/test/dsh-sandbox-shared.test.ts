import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { DshEnvironment } from '../src/harness/dsh/environment.js';
import { AgentWorkspace } from '../src/runtime/workspace.js';
import type { AgentRecord } from '../src/storage/store.js';
import { dshConfig } from './dsh-fixture.js';

const electron = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const carrier = process.env.ISLES_TEST_DSH_CARRIER;

it('canonicalizes and deduplicates every additional directory and rejects invalid roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isles-dsh-roots-'));
  try {
    const first = join(root, 'first worktree');
    const second = join(root, 'second worktree');
    const alias = join(root, 'alias');
    await Promise.all([first, second].map((path) => mkdir(path)));
    await symlink(first, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const { additionalRoots } = await import(
      new URL('../resources/dsh-shared-roots.mjs', import.meta.url).href
    );
    expect(additionalRoots({ additionalDirs: [first, alias, second, first] })).toEqual(
      await Promise.all([first, second].map((path) => realpath(path))),
    );
    expect(additionalRoots({ additionalDirs: [] })).toEqual([]);
    expect(() => additionalRoots({ sharedDir: first })).toThrow('additionalDirs must be an array');
    expect(() => additionalRoots({ additionalDirs: ['relative'] })).toThrow('absolute paths');
    const file = join(root, 'file');
    await writeFile(file, 'fixture');
    expect(() => additionalRoots({ additionalDirs: [file] })).toThrow('directories');
    await rm(second, { recursive: true });
    expect(() => additionalRoots({ additionalDirs: [first, second] })).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(!carrier && !existsSync(electron))(
  'loads native DSH and grants every additional directory to file tools and command sandboxes',
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
        workspacePaths: [join(root, 'external worktree'), join(root, 'another worktree')],
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
      await Promise.all(agent.workspacePaths.map((path) => mkdir(path)));
      const runtime = await environment.runtime(agent.workspace, agent);
      const result = await promisify(execFile)(
        carrier ? process.execPath : electron,
        [
          '--expose-internals',
          fileURLToPath(new URL('./dsh-native-sandbox-check.mjs', import.meta.url)),
          root,
          runtime.args[3]!,
          agent.workspace,
          workspace.sharedDir,
          ...agent.workspacePaths,
        ],
        {
          env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
          timeout: 60_000,
        },
      );
      expect(JSON.parse(result.stdout.trim())).toEqual({
        nativeOverlay: true,
        nativeFileTools: true,
        fs: true,
        commandSandbox: process.platform,
        additionalRoots: 2,
        linuxProfiles: true,
        windowsGrantContract: true,
        nativeApprovalAudit: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  65_000,
);
