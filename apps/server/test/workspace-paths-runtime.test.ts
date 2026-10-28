import type { Agent, Channel, CreateAgent, WorkspaceSettings } from '@isles/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type {
  HarnessAdapter,
  HarnessHandlers,
  HarnessSession,
  HarnessSteerInput,
  HarnessTurnInput,
} from '../src/harness/types.js';
import { agentRoot } from '../src/runtime/workspace.js';
import type { AgentRecord } from '../src/storage/store.js';
import { testCatalog, testConfig } from './helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));
type InitializationPhase = 'connect' | 'create' | 'resume';
type InitializationHook = (session: WorkspaceSession, phase: InitializationPhase) => Promise<void>;

/** Capture the native connection configuration independently of later Store edits. */
class WorkspaceSession implements HarnessSession {
  readonly submissions: HarnessTurnInput[] = [];
  readonly steers: HarnessSteerInput[] = [];
  readonly resumedIds: string[] = [];
  readonly createdIds: string[] = [];
  readonly turnIds: string[] = [];
  readonly sessionId: string;
  closed = false;
  constructor(
    readonly agent: AgentRecord,
    readonly handlers: HarnessHandlers,
    readonly guidance: string,
    private readonly initialize: InitializationHook,
  ) {
    this.sessionId = agent.threadId ?? `native-${agent.id}-${randomUUID()}`;
  }
  async createSession(onCreated: (id: string) => void) {
    this.createdIds.push(this.sessionId);
    onCreated(this.sessionId);
    await this.initialize(this, 'create');
    return this.sessionId;
  }
  async resumeSession(id: string) {
    this.resumedIds.push(id);
    await this.initialize(this, 'resume');
    return id;
  }
  async submit(input: HarnessTurnInput) {
    this.submissions.push(input);
    const turnId = `input-${randomUUID()}`;
    this.turnIds.push(turnId);
    this.start(turnId);
    return { turnId };
  }
  async steer(input: HarnessSteerInput) {
    this.steers.push(input);
    return { turnId: input.expectedTurnId };
  }
  start(turnId: string, sessionId = this.sessionId) {
    this.handlers.event({ type: 'turn_started', turnId, sessionId });
  }
  complete(turnId: string, sessionId = this.sessionId) {
    this.handlers.event({
      type: 'turn_completed',
      turnId,
      sessionId,
      status: 'completed',
      error: null,
    });
  }
  completeInput(index = 0) {
    this.complete(this.turnIds[index]!);
  }
  async interrupt() {}
  answer() {}
  rejectQuestion() {}
  async close() {
    this.closed = true;
  }
}

async function fixture(
  options: { initialWorkspacePaths?: (root: string) => Promise<string[]> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'isles-workspace-runtime-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  if (options.initialWorkspacePaths) {
    const config = testConfig(root);
    await config.configureSharedWorkspaces(await options.initialWorkspacePaths(root));
  }
  const sessions: WorkspaceSession[] = [];
  const hooks: { initialize?: InitializationHook } = {};
  const open = async () => {
    const config = testConfig(root);
    const app = await buildApp({
      config,
      runtimeUrl: 'http://127.0.0.1:1',
      adapterFactory: (): HarnessAdapter[] => [
        {
          descriptor: {
            id: 'fixture',
            displayName: 'Fixture',
            configuration: null,
            capabilities: {
              sessionResume: true,
              interrupt: true,
              steer: true,
              userQuestions: false,
              nativeSubagents: true,
              mcp: true,
              workspaceInstructions: true,
            },
          },
          nativeHome: join(root, 'native-home'),
          catalog: testCatalog,
          invalidate: () => {},
          connect: async (agent, _baseUrl, handlers) => {
            const session = new WorkspaceSession(
              { ...agent, workspacePaths: [...agent.workspacePaths] },
              handlers,
              await readFile(join(agent.workspace, 'AGENTS.md'), 'utf8'),
              async (value, phase) => hooks.initialize?.(value, phase),
            );
            sessions.push(session);
            handlers.connected(session);
            await hooks.initialize?.(session, 'connect');
            return session;
          },
        },
      ],
    });
    cleanups.push(() => app.close());
    return { app, config };
  };
  const { app, config } = await open();
  const directory = async (name: string) => {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    return realpath(path);
  };
  const input = (workspacePaths: string[] = [], name = 'Agent'): CreateAgent => ({
    harness: 'fixture',
    name,
    model: 'test-model',
    reasoningEffort: 'high',
    workspacePaths,
    steerEnabled: true,
  });
  const ready = (agent: Pick<Agent, 'id'>) =>
    expect.poll(() => app.isles.store.publicAgent(agent.id).status).toBe('ready');
  const create = async (workspacePaths: string[] = [], wait = true) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: input(workspacePaths),
    });
    expect(response.statusCode).toBe(201);
    const agent = response.json<Agent>();
    if (wait) await ready(agent);
    return app.isles.store.publicAgent(agent.id);
  };
  const save = (workspacePaths: string[]) =>
    app.inject({ method: 'PUT', url: '/api/workspaces', payload: { workspacePaths } });
  const patch = (agent: Pick<Agent, 'id'>, workspacePaths: string[]) =>
    app.inject({ method: 'PATCH', url: `/api/agents/${agent.id}`, payload: { workspacePaths } });
  const group = async (memberIds: string[], workspacePaths: string[]) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/channels',
      payload: { name: 'Project group', memberIds, workspacePaths },
    });
    expect(response.statusCode).toBe(201);
    return response.json<Channel>();
  };
  const paths = (agent: Pick<Agent, 'id'>) => app.isles.store.publicAgent(agent.id).workspacePaths;
  const connections = (agent: Pick<Agent, 'id'>) =>
    sessions.filter((session) => session.agent.id === agent.id);
  const latest = (agent: Pick<Agent, 'id'>) => connections(agent).at(-1)!;
  const send = (agent: Agent, body = 'Continue work') =>
    app.isles.runtime.send(agent.channelId, { body, clientId: randomUUID() });
  const deliveries = (agent: Agent) =>
    app.isles.store.listMessages(agent.channelId).map((message) => message.deliveries[0]!.status);
  return {
    root,
    app,
    config,
    open,
    hooks,
    directory,
    input,
    ready,
    create,
    save,
    patch,
    group,
    paths,
    connections,
    latest,
    send,
    deliveries,
  };
}

async function mcpClient(app: Awaited<ReturnType<typeof buildApp>>, agent: Agent) {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Expected local listener');
  const token = await app.isles.runtime.workspace.token(
    agentRoot(app.isles.runtime.workspace.dataDir, agent),
  );
  const client = new Client({ name: 'workspace-runtime-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp/${agent.id}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as Transport,
  );
  cleanups.push(() => client.close());
  return client;
}

describe('workspace paths through HTTP and native runtime', () => {
  it('validates every workspace entry point before mutating Agents, groups or global settings', async () => {
    const f = await fixture();
    const agent = await f.create();
    const room = await f.group([agent.id], []);
    const file = join(f.root, 'project.txt');
    await writeFile(file, 'file');
    const originalAgents = f.app.isles.store.listAgents().map((value) => value.id);
    const originalChannels = f.app.isles.store.listChannels().map((value) => value.id);
    for (const path of ['relative-project', join(f.root, 'missing'), file]) {
      const requests = [
        { method: 'PUT' as const, url: '/api/workspaces', payload: { workspacePaths: [path] } },
        { method: 'POST' as const, url: '/api/agents', payload: f.input([path]) },
        {
          method: 'POST' as const,
          url: '/api/agents/batch',
          payload: { ...f.input([path]), count: 2 },
        },
        {
          method: 'PATCH' as const,
          url: `/api/agents/${agent.id}`,
          payload: { workspacePaths: [path] },
        },
        {
          method: 'POST' as const,
          url: '/api/channels',
          payload: { name: 'Invalid group', memberIds: [agent.id], workspacePaths: [path] },
        },
        {
          method: 'PATCH' as const,
          url: `/api/channels/${room.id}`,
          payload: { workspacePaths: [path] },
        },
      ];
      for (const request of requests) expect((await f.app.inject(request)).statusCode).toBe(400);
    }
    expect(f.app.isles.store.listAgents().map((value) => value.id)).toEqual(originalAgents);
    expect(f.app.isles.store.listChannels().map((value) => value.id)).toEqual(originalChannels);
    expect(f.paths(agent)).toEqual([]);
    expect(f.app.isles.store.publicChannel(room.id).workspacePaths).toEqual([]);
    expect(
      (await f.app.inject('/api/workspaces')).json<WorkspaceSettings>().workspacePaths,
    ).toEqual([]);
    expect(f.connections(agent)).toHaveLength(1);
  });

  it('canonicalizes aliases, trimmed paths and platform case identity across defaults and local settings', async () => {
    const f = await fixture();
    const project = await f.directory('project');
    const alias = join(f.root, 'project-alias');
    await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const selected = [project, ` ${alias} `, `${project}${sep}.`];
    if (process.platform === 'win32') selected.push(project.toUpperCase());
    const saved = await f.save(selected);
    expect(saved.statusCode).toBe(200);
    expect(saved.json<WorkspaceSettings>()).toEqual({
      workspacePaths: [project],
      defaultSharedDir: f.config.current.sharedDir,
      configFilePath: f.config.current.configFilePath,
    });
    const agent = await f.create(selected);
    expect(f.paths(agent)).toEqual([project]);
    const room = await f.group([agent.id], selected);
    expect(room.workspacePaths).toEqual([project]);
    const original = f.latest(agent);
    const patched = await f.patch(agent, selected);
    expect(patched.statusCode).toBe(200);
    await nextTick();
    expect(f.latest(agent)).toBe(original);
    expect(parse(await readFile(f.config.current.configFilePath, 'utf8'))).toMatchObject({
      paths: { shared_workspaces: [project] },
    });
  });

  it('persists global defaults, adds only new entries to live Agents and retains manual removals across restart', async () => {
    const f = await fixture();
    const own = await f.directory('own');
    const first = await f.directory('global-first');
    const second = await f.directory('global-second');
    const a = await f.create([own]);
    const stopped = await f.create();
    const deleted = await f.create();
    await f.app.isles.runtime.stop(stopped.id);
    await f.app.isles.runtime.deleteAgent(deleted.id);
    const stoppedConnections = f.connections(stopped).length;
    expect((await f.save([first])).statusCode).toBe(200);
    await f.ready(a);
    expect(f.paths(a)).toEqual([own, first]);
    expect(f.paths(stopped)).toEqual([first]);
    expect(f.paths(deleted)).toEqual([]);
    expect(f.app.isles.store.publicAgent(stopped.id).status).toBe('stopped');
    expect(f.connections(stopped)).toHaveLength(stoppedConnections);
    expect((await f.patch(a, [own])).statusCode).toBe(200);
    await f.ready(a);
    const manuallyEdited = f.latest(a);
    expect((await f.save([first])).statusCode).toBe(200);
    await nextTick();
    expect(f.paths(a)).toEqual([own]);
    expect(f.latest(a)).toBe(manuallyEdited);
    expect((await f.save([first, second])).statusCode).toBe(200);
    await f.ready(a);
    expect(f.paths(a)).toEqual([own, second]);
    expect(f.paths(stopped)).toEqual([first, second]);
    const created = await f.create([own, second]);
    expect(f.paths(created)).toEqual([first, second, own]);
    const batchResponse = await f.app.inject({
      method: 'POST',
      url: '/api/agents/batch',
      payload: { ...f.input([own, first], 'Batch'), count: 2 },
    });
    expect(batchResponse.statusCode).toBe(201);
    const batch = batchResponse.json<{ agents: Agent[] }>().agents;
    expect(batch.map((value) => value.workspacePaths)).toEqual([
      [first, second, own],
      [first, second, own],
    ]);
    for (const agent of batch) await f.ready(agent);
    await f.app.isles.runtime.resume(stopped.id);
    await f.ready(stopped);
    expect(f.latest(stopped).agent.workspacePaths).toEqual([first, second]);
    expect(f.latest(stopped).resumedIds).toEqual([stopped.threadId]);
    expect((await f.save([])).statusCode).toBe(200);
    expect(f.paths(created)).toEqual([first, second, own]);
    expect(f.paths(a)).toEqual([own, second]);
    expect(f.paths(await f.create())).toEqual([]);
    expect((await f.save([second])).statusCode).toBe(200);
    expect((await f.patch(a, [own])).statusCode).toBe(200);
    await f.ready(a);
    await f.app.close();
    const restored = await f.open();
    await expect.poll(() => restored.app.isles.store.publicAgent(a.id).status).toBe('ready');
    expect(
      (await restored.app.inject('/api/workspaces')).json<WorkspaceSettings>().workspacePaths,
    ).toEqual([second]);
    expect(restored.app.isles.store.publicAgent(a.id)).toMatchObject({
      workspacePaths: [own],
      threadId: a.threadId,
    });
    const fresh = await restored.app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: f.input(),
    });
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json<Agent>().workspacePaths).toEqual([second]);
  });

  it.each([false, true])(
    'preserves manual removals when canonicalizing initial config aliases (remove unrelated default: %s)',
    async (removeUnrelated) => {
      let project = '';
      let alias = '';
      let unrelated = '';
      const f = await fixture({
        initialWorkspacePaths: async (root) => {
          await mkdir(join(root, 'project'));
          await mkdir(join(root, 'unrelated'));
          project = await realpath(join(root, 'project'));
          unrelated = await realpath(join(root, 'unrelated'));
          alias = join(root, 'project-alias');
          await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
          return [alias, unrelated];
        },
      });
      expect(f.config.current.sharedWorkspacePaths).toEqual([alias, unrelated]);
      const agent = await f.create();
      expect(f.paths(agent)).toEqual([project, unrelated]);
      expect((await f.patch(agent, [])).statusCode).toBe(200);
      await f.ready(agent);
      const manual = f.latest(agent);
      expect((await f.save(removeUnrelated ? [alias] : [alias, unrelated])).statusCode).toBe(200);
      await nextTick();
      expect(f.paths(agent)).toEqual([]);
      expect(f.latest(agent)).toBe(manual);
      expect(f.config.current.sharedWorkspacePaths).toEqual(
        removeUnrelated ? [project] : [project, unrelated],
      );
    },
  );

  it('propagates group create, join and updates, exposes current MCP paths, and retains directories after leave or deletion', async () => {
    const f = await fixture();
    const own = await f.directory('own');
    const first = await f.directory('group-first');
    const second = await f.directory('group-second');
    const third = await f.directory('group-third');
    const a = await f.create([own]);
    const b = await f.create();
    const outsider = await f.create();
    const original = f.latest(a);
    const room = await f.group([a.id], [first]);
    await f.ready(a);
    expect(f.paths(a)).toEqual([own, first]);
    expect(original.closed).toBe(true);
    expect(f.latest(a).resumedIds).toEqual([a.threadId]);
    const joined = await f.app.inject({
      method: 'POST',
      url: `/api/channels/${room.id}/members`,
      payload: { agentIds: [b.id] },
    });
    expect(joined.statusCode).toBe(200);
    await f.ready(b);
    expect(f.paths(b)).toEqual([first]);
    const updated = await f.app.inject({
      method: 'PATCH',
      url: `/api/channels/${room.id}`,
      payload: { workspacePaths: [first, second] },
    });
    expect(updated.statusCode).toBe(200);
    await f.ready(a);
    await f.ready(b);
    expect(f.paths(a)).toEqual([own, first, second]);
    expect(f.paths(b)).toEqual([first, second]);
    expect(f.paths(outsider)).toEqual([]);
    const client = await mcpClient(f.app, a);
    const list = async () => {
      const result = await client.callTool({ name: 'list_channels' });
      expect(result.isError).not.toBe(true);
      return JSON.parse((result.content as { text: string }[])[0]!.text).channels as {
        channel_id: string;
        workspace_paths: string[];
      }[];
    };
    expect(await list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel_id: room.id, workspace_paths: [first, second] }),
        expect.objectContaining({ channel_id: a.channelId, workspace_paths: [] }),
      ]),
    );
    expect(
      (await f.app.inject({ method: 'DELETE', url: `/api/channels/${room.id}/members/${b.id}` }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `/api/channels/${room.id}`,
          payload: { workspacePaths: [third] },
        })
      ).statusCode,
    ).toBe(200);
    await f.ready(a);
    expect(f.paths(a)).toEqual([own, first, second, third]);
    expect(f.paths(b)).toEqual([first, second]);
    expect((await list()).find((value) => value.channel_id === room.id)?.workspace_paths).toEqual([
      third,
    ]);
    f.send(a);
    await expect.poll(() => f.deliveries(a)).toEqual(['accepted']);
    expect(f.latest(a).submissions[0]).toMatchObject({
      sessionId: a.threadId,
      workspace: a.workspace,
    });
    f.latest(a).completeInput();
    await f.ready(a);
    f.app.isles.runtime.send(room.id, {
      body: 'Use the current group project',
      clientId: randomUUID(),
    });
    await expect.poll(() => f.latest(a).submissions.length).toBe(2);
    expect(f.latest(a).submissions[1]).toMatchObject({
      sessionId: a.threadId,
      workspace: a.workspace,
      text: expect.stringContaining(
        `[channel: "Project group", workspace_paths: ${JSON.stringify(third)}]`,
      ),
    });
    f.latest(a).completeInput(1);
    await f.ready(a);
    expect(
      (await f.app.inject({ method: 'DELETE', url: `/api/channels/${room.id}` })).statusCode,
    ).toBe(200);
    expect(f.paths(a)).toEqual([own, first, second, third]);
    expect(f.paths(b)).toEqual([first, second]);
    expect((await list()).map((value) => value.channel_id)).toEqual([a.channelId]);
    expect(f.app.isles.store.publicAgent(a.id)).toMatchObject({
      threadId: a.threadId,
      workspace: a.workspace,
    });
  });

  it('preserves manual Agent removals during no-op group saves and existing-member invitations', async () => {
    const f = await fixture();
    const first = await f.directory('group-first');
    const second = await f.directory('group-second');
    const agent = await f.create();
    const room = await f.group([agent.id], [first]);
    await f.ready(agent);
    expect((await f.patch(agent, [])).statusCode).toBe(200);
    await f.ready(agent);
    const manual = f.latest(agent);
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `/api/channels/${room.id}`,
          payload: { name: 'Renamed group', workspacePaths: [first] },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/channels/${room.id}/members`,
          payload: { agentIds: [agent.id] },
        })
      ).statusCode,
    ).toBe(200);
    await nextTick();
    expect(f.paths(agent)).toEqual([]);
    expect(f.latest(agent)).toBe(manual);
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `/api/channels/${room.id}`,
          payload: { workspacePaths: [first, second] },
        })
      ).statusCode,
    ).toBe(200);
    await f.ready(agent);
    expect(f.paths(agent)).toEqual([second]);
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `/api/channels/${room.id}`,
          payload: { workspacePaths: [] },
        })
      ).statusCode,
    ).toBe(200);
    expect(f.paths(agent)).toEqual([second]);
  });

  it.each(['agent', 'global', 'group'] as const)(
    'queues new steer-enabled input after a %s edit until root and child finish, then resumes the exact session with fresh directories',
    async (source) => {
      const f = await fixture();
      const originalPath = await f.directory('original');
      const nextPath = await f.directory('next');
      const agent = await f.create([originalPath]);
      const original = f.latest(agent);
      f.send(agent, 'Start root work');
      await expect.poll(() => f.deliveries(agent)).toEqual(['accepted']);
      original.start('child-turn', 'child-session');
      if (source === 'agent') expect((await f.patch(agent, [nextPath])).statusCode).toBe(200);
      else if (source === 'global') expect((await f.save([nextPath])).statusCode).toBe(200);
      else await f.group([agent.id], [nextPath]);
      const expected = source === 'agent' ? [nextPath] : [originalPath, nextPath];
      f.send(agent, 'Use the updated project');
      await nextTick();
      expect(f.deliveries(agent)).toEqual(['accepted', 'queued']);
      expect(original.steers).toEqual([]);
      original.completeInput();
      await nextTick();
      expect(f.app.isles.store.publicAgent(agent.id).status).toBe('running');
      expect(f.connections(agent)).toHaveLength(1);
      expect(original.closed).toBe(false);
      expect(original.agent.workspacePaths).toEqual([originalPath]);
      expect(f.deliveries(agent)).toEqual(['accepted', 'queued']);
      const liveGuidance = await readFile(join(agent.workspace, 'AGENTS.md'), 'utf8');
      expect(liveGuidance).toContain(JSON.stringify(originalPath));
      expect(liveGuidance).not.toContain(JSON.stringify(nextPath));
      original.complete('child-turn', 'child-session');
      await expect.poll(() => f.deliveries(agent)).toEqual(['accepted', 'accepted']);
      const refreshed = f.latest(agent);
      expect(original.closed).toBe(true);
      expect(original.submissions).toHaveLength(1);
      expect(refreshed).not.toBe(original);
      expect(refreshed.agent.workspacePaths).toEqual(expected);
      expect(refreshed.resumedIds).toEqual([agent.threadId]);
      expect(refreshed.createdIds).toEqual([]);
      expect(refreshed.guidance).toContain(JSON.stringify(nextPath));
      expect(refreshed.submissions).toHaveLength(1);
      expect(refreshed.submissions[0]).toMatchObject({
        sessionId: agent.threadId,
        workspace: agent.workspace,
      });
      refreshed.completeInput();
      await f.ready(agent);
    },
  );

  it.each(['connect', 'create', 'resume'] as const)(
    'reloads edits made during native %s initialization before submitting queued input',
    async (phase) => {
      const f = await fixture();
      const first = await f.directory('first');
      const second = await f.directory('second');
      const gate = deferred();
      const entered = deferred();
      cleanups.push(async () => gate.resolve());
      let held: WorkspaceSession | undefined;
      let agent: Agent;
      if (phase === 'resume') {
        agent = await f.create([first]);
        await f.app.isles.runtime.stop(agent.id);
      }
      f.hooks.initialize = async (session, currentPhase) => {
        if (currentPhase !== phase || held) return;
        held = session;
        entered.resolve();
        await gate.promise;
      };
      if (phase === 'resume') await f.app.isles.runtime.resume(agent!.id);
      else agent = await f.create([first], false);
      await entered.promise;
      const original = held!;
      expect((await f.patch(agent!, [second])).statusCode).toBe(200);
      f.send(agent!, 'Queued during initialization');
      expect(f.deliveries(agent!)).toEqual(['queued']);
      gate.resolve();
      await expect.poll(() => f.deliveries(agent!)).toEqual(['accepted']);
      const refreshed = f.latest(agent!);
      const sessionId = f.app.isles.store.publicAgent(agent!.id).threadId;
      expect(original.closed).toBe(true);
      expect(original.submissions).toEqual([]);
      expect(original.agent.workspacePaths).toEqual([first]);
      expect(refreshed.agent.workspacePaths).toEqual([second]);
      expect(refreshed.resumedIds).toEqual([sessionId]);
      expect(refreshed.createdIds).toEqual([]);
      expect(refreshed.submissions[0]).toMatchObject({ sessionId, workspace: agent!.workspace });
      refreshed.completeInput();
      await f.ready(agent!);
    },
  );

  it.each([
    ['global', false],
    ['global', true],
    ['group', false],
    ['group', true],
  ] as const)(
    'loads a %s append made during new-session initialization without queued messages (stopped: %s)',
    async (source, stopped) => {
      const f = await fixture();
      const first = await f.directory('first');
      const appended = await f.directory('appended');
      const agent = await f.create([first]);
      if (stopped) await f.app.isles.runtime.stop(agent.id);
      await nextTick();
      const gate = deferred();
      const entered = deferred();
      cleanups.push(async () => gate.resolve());
      let held: WorkspaceSession | undefined;
      f.hooks.initialize = async (session, phase) => {
        if (phase !== 'create' || held) return;
        held = session;
        entered.resolve();
        await gate.promise;
      };
      const replacing = f.app.isles.runtime.newSession(agent.id);
      await entered.promise;
      if (source === 'global') expect((await f.save([appended])).statusCode).toBe(200);
      else await f.group([agent.id], [appended]);
      expect(held!.agent.workspacePaths).toEqual([first]);
      expect(f.paths(agent)).toEqual([first, appended]);
      gate.resolve();
      const replaced = await replacing;
      expect(replaced.threadId).not.toBe(agent.threadId);
      if (stopped) {
        await nextTick();
        expect(f.app.isles.store.publicAgent(agent.id)).toMatchObject({
          desiredState: 'stopped',
          status: 'stopped',
        });
        expect(f.connections(agent)).toHaveLength(2);
        await f.app.isles.runtime.resume(agent.id);
      }
      await expect.poll(() => f.connections(agent).length).toBe(3);
      await f.ready(agent);
      const refreshed = f.latest(agent);
      expect(held!.closed).toBe(true);
      expect(refreshed.agent.workspacePaths).toEqual([first, appended]);
      expect(refreshed.resumedIds).toEqual([replaced.threadId]);
      expect(refreshed.createdIds).toEqual([]);
      expect(f.connections(agent).flatMap((session) => session.submissions)).toEqual([]);
      expect(f.app.isles.store.publicAgent(agent.id).threadId).toBe(replaced.threadId);
    },
  );

  it('finishes ordered global writes before shutdown releases storage and restores their combined additions', async () => {
    const f = await fixture();
    const first = await f.directory('first');
    const second = await f.directory('second');
    const agent = await f.create();
    const gate = deferred();
    const entered = deferred();
    cleanups.push(async () => gate.resolve());
    const configure = f.config.configureSharedWorkspaces.bind(f.config);
    const write = vi
      .spyOn(f.config, 'configureSharedWorkspaces')
      .mockImplementationOnce(async (paths) => {
        entered.resolve();
        await gate.promise;
        await configure(paths);
      });
    try {
      const firstWrite = f.app.isles.runtime.configureSharedWorkspaces([first]);
      const secondWrite = f.app.isles.runtime.configureSharedWorkspaces([second]);
      await entered.promise;
      let closed = false;
      const close = f.app.close().then(() => {
        closed = true;
      });
      await nextTick();
      expect(closed).toBe(false);
      expect(f.paths(agent)).toEqual([]);
      gate.resolve();
      const [firstResult, secondResult] = await Promise.all([firstWrite, secondWrite]);
      expect(firstResult.workspacePaths).toEqual([first]);
      expect(secondResult.workspacePaths).toEqual([second]);
      await close;
      const restored = await f.open();
      await expect.poll(() => restored.app.isles.store.publicAgent(agent.id).status).toBe('ready');
      expect(restored.config.current.sharedWorkspacePaths).toEqual([second]);
      expect(restored.app.isles.store.publicAgent(agent.id)).toMatchObject({
        workspacePaths: [first, second],
        threadId: agent.threadId,
      });
    } finally {
      gate.resolve();
      write.mockRestore();
    }
  });
});
