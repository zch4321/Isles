// Opt-in configuration, workspace and Agent management acceptance.
// pnpm --filter @isles/server exec tsx test/verify-native-config.ts
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigManager } from '@isles/config';
import type { Agent } from '@isles/contracts';
import { parse } from 'smol-toml';
import { buildApp } from '../src/app.js';
import { agentRoot } from '../src/runtime/workspace.js';
import { StdioClient } from '../src/codex/client.js';
import { CodexAdapter } from '../src/codex/adapter.js';
import { NativeEnvironment } from '../src/codex/environment.js';
import { threadResponseSchema } from '../src/codex/protocol.js';

const root = await mkdtemp(join(tmpdir(), 'isles-native-config-'));
const configFilePath = join(root, 'settings', 'config.toml');
await mkdir(join(root, 'settings'));
await writeFile(configFilePath, '[paths]\ndata_dir = "../data"\nworkspace_dir = "../work"\n');
const nonce = randomUUID();
const report = {
  success: false,
  root,
  configFilePath,
  startedAt: new Date().toISOString(),
  version: null as string | null,
  model: null as string | null,
  editedModel: null as string | null,
  editedEffort: null as string | null,
  agents: [] as { id: string; threadId: string | null; workspace: string }[],
  instructionSources: [] as {
    agentId: string;
    method: string;
    threadId: string;
    paths: string[];
    injectedRules: boolean;
  }[],
  turns: [] as { agentId: string; threadId: string; model: string; effort: string }[],
  checks: [] as string[],
  error: null as string | null,
  finishedAt: '',
};
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
const environment: NodeJS.ProcessEnv = {};
if (process.env.CODEX_HOME) environment.CODEX_HOME = process.env.CODEX_HOME;
if (process.env.ISLES_CODEX_HOME) environment.ISLES_CODEX_HOME = process.env.ISLES_CODEX_HOME;
const open = async () => {
  const config = new ConfigManager({ configFilePath, environment });
  const instance = await buildApp({
    config,
    adapterFactory: (workspace, config) => {
      const native = new NativeEnvironment(config, workspace);
      return [
        new CodexAdapter(native, undefined, async (agent, handlers, _baseUrl, connecting) => {
          const client = new StdioClient(
            await native.executable(),
            agent.workspace,
            await native.launch(agent),
            handlers,
            native.redactor,
            native.log.child({ agentId: agent.id }),
          );
          connecting(client);
          const request = client.request.bind(client);
          client.request = async <T = unknown>(method: string, params: Record<string, unknown>) => {
            const response = await request<T>(method, params);
            if (method === 'thread/start' || method === 'thread/resume') {
              const parsed = threadResponseSchema.parse(response);
              report.instructionSources.push({
                agentId: agent.id,
                method,
                threadId: parsed.thread.id,
                paths: parsed.instructionSources,
                injectedRules: Object.hasOwn(params, 'developerInstructions'),
              });
            }
            if (method === 'turn/start')
              report.turns.push({
                agentId: agent.id,
                threadId: String(params.threadId),
                model: String(params.model),
                effort: String(params.effort),
              });
            return response;
          };
          try {
            await client.initialize();
            return client;
          } catch (error) {
            await client.close();
            throw error;
          }
        }),
      ];
    },
  });
  try {
    await instance.listen({ host: '127.0.0.1', port: 0 });
    return instance;
  } catch (error) {
    await instance.close();
    throw error;
  }
};
const current = () => {
  assert.ok(app);
  return app;
};
const progress = (stage: string) => console.log(JSON.stringify({ stage, root }));
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    for (const agent of current().isles.store.listAgents()) {
      if (agent.status === 'error') throw new Error(agent.error ?? `Agent ${agent.id} failed`);
    }
    if (predicate()) return;
    await sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
}
const ready = (agent: Agent) => current().isles.store.publicAgent(agent.id).status === 'ready';
async function ask(agent: Agent, body: string, expected: string) {
  current().isles.runtime.send(agent.channelId, { body, clientId: randomUUID() });
  await until(
    () =>
      current()
        .isles.store.listMessages(agent.channelId)
        .some((message) => message.sender === 'agent' && message.body === expected) && ready(agent),
    expected,
  );
}
async function configHash() {
  try {
    const file = await readFile(
      join(
        (current().isles.runtime.harnesses.get('codex') as CodexAdapter).environment.home,
        'config.toml',
      ),
    );
    return createHash('sha256').update(file).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
try {
  app = await open();
  const before = await configHash();
  const status = await app.isles.runtime.harnesses.get('codex').catalog.status();
  assert.ok(status.available && status.authenticated, status.error ?? 'Codex is not authenticated');
  const models = await app.isles.runtime.harnesses.get('codex').catalog.models();
  const model =
    models.find((candidate) => candidate.model === 'gpt-6.1-sol') ??
    models.find((candidate) => candidate.isDefault);
  assert.ok(model);
  assert.ok(model.supportedReasoningEfforts.includes('high'));
  report.version = status.version;
  report.model = model.model;
  progress('native catalog ready');
  const writer = await app.isles.runtime.createAgent({
    harness: 'codex',
    name: 'Workspace acceptance writer',
    model: model.model,
    reasoningEffort: 'high',
  });
  const reader = await app.isles.runtime.createAgent({
    harness: 'codex',
    name: 'Workspace acceptance reader',
    model: model.model,
    reasoningEffort: 'high',
  });
  await until(() => ready(writer) && ready(reader), 'both Agent workspaces initialized');
  for (const agent of [writer, reader]) {
    const stored = app.isles.store.publicAgent(agent.id);
    assert.equal(stored.workspace, join(root, 'work', 'agents', agent.id, 'workspace'));
    assert.match(
      await readFile(join(agentRoot(join(root, 'data'), agent), 'isles-mcp-token'), 'utf8'),
      /^[0-9a-f]{64}$/,
    );
    const rules = await readFile(join(agent.workspace, 'AGENTS.md'), 'utf8');
    assert.ok(rules.includes(JSON.stringify(join(root, 'work', 'shared'))));
    assert.ok((await stat(join(agent.workspace, '.isles-root'))).isFile());
    report.agents.push({ id: stored.id, threadId: stored.threadId, workspace: stored.workspace });
  }
  report.checks.push('external personal workspaces and data-backed tokens');
  const fileName = `handoff-${nonce}.txt`;
  const payload = `ISLES_SHARED_${nonce}`;
  const written = `WRITTEN_${nonce}`;
  progress('writer creates shared file');
  await ask(
    writer,
    `Acceptance check: reread your workspace AGENTS.md and obtain the shared directory from it. Create ${fileName} in that shared directory with exactly this content and no newline: ${payload}. Then use Isles MCP send_message with channelId private and body exactly ${written}. End your turn.`,
    written,
  );
  assert.equal(await readFile(join(root, 'work', 'shared', fileName), 'utf8'), payload);
  progress('reader consumes shared file');
  await ask(
    reader,
    `Acceptance check: reread your workspace AGENTS.md to locate the shared directory. Read ${fileName} there. Use Isles MCP send_message with channelId private and body exactly the file content. End your turn.`,
    payload,
  );
  report.checks.push('two real Agents exchange shared file using AGENTS.md and MCP');
  assert.ok(status.binaryPath);
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/harnesses/codex/config',
    payload: { binaryPath: status.binaryPath },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().configFilePath, configFilePath);
  const document = parse(await readFile(configFilePath, 'utf8'));
  assert.deepEqual(
    { ...(document.paths as Record<string, unknown>) },
    {
      data_dir: '../data',
      workspace_dir: '../work',
    },
  );
  report.checks.push('existing config API writes TOML and preserves directory settings');
  await app.close();
  app = undefined;
  progress('restarting same threads');
  app = await open();
  await until(() => ready(writer) && ready(reader), 'both Agents restored');
  for (const agent of report.agents) {
    assert.equal(app.isles.store.publicAgent(agent.id).threadId, agent.threadId);
  }
  const resumed = `RESUMED_${nonce}`;
  await ask(
    reader,
    `Acceptance check after restart: reread your workspace AGENTS.md, read ${fileName} from its shared directory, and verify its content is ${payload}. Use Isles MCP send_message with channelId private and body exactly ${resumed}. End your turn.`,
    resumed,
  );
  report.checks.push('same native threads and shared file survive application restart');
  progress('editing a real Agent without replacing its thread');
  const alternate =
    models.find(
      (candidate) => candidate.model === 'gpt-6-luna' && candidate.model !== model.model,
    ) ??
    models.find(
      (candidate) =>
        candidate.model !== model.model && candidate.supportedReasoningEfforts.includes('high'),
    );
  assert.ok(alternate, 'Need a second available model to verify model editing');
  const editedEffort = alternate.supportedReasoningEfforts.includes('xhigh') ? 'xhigh' : 'high';
  const editedName = `Edited reader ${nonce}`;
  const beforeEdit = app.isles.store.publicAgent(reader.id);
  const resumesBeforeEdit = report.instructionSources.filter(
    (source) => source.agentId === reader.id && source.method === 'thread/resume',
  ).length;
  const editedResponse = await app.inject({
    method: 'PATCH',
    url: `/api/agents/${reader.id}`,
    payload: {
      name: editedName,
      model: alternate.model,
      reasoningEffort: editedEffort,
      canCreateGroups: true,
    },
  });
  assert.equal(editedResponse.statusCode, 200);
  report.editedModel = alternate.model;
  report.editedEffort = editedEffort;
  await until(
    () =>
      ready(reader) &&
      report.instructionSources.filter(
        (source) => source.agentId === reader.id && source.method === 'thread/resume',
      ).length ===
        resumesBeforeEdit + 1,
    'edited Agent reconnected',
  );
  const edited = app.isles.store.publicAgent(reader.id);
  assert.equal(edited.threadId, beforeEdit.threadId);
  assert.equal(edited.workspace, beforeEdit.workspace);
  assert.equal(edited.canCreateGroups, true);
  assert.ok(
    (await readFile(join(reader.workspace, 'AGENTS.md'), 'utf8')).includes(
      `Agent name: ${JSON.stringify(editedName)}`,
    ),
  );
  const editReply = `EDITED_${nonce}`;
  await ask(
    reader,
    `Acceptance check: read your workspace AGENTS.md and verify your Agent name is exactly ${editedName}. Read ${fileName} from its shared directory and verify its content is ${payload}. Use Isles MCP send_message with channelId private and body exactly ${editReply}. End your turn.`,
    editReply,
  );
  assert.deepEqual(report.turns.at(-1), {
    agentId: reader.id,
    threadId: edited.threadId!,
    model: alternate.model,
    effort: editedEffort,
  });
  report.checks.push(
    'native rename, model and effort edit reloads AGENTS.md and retains original thread/workspace',
  );
  const group = app.isles.runtime.createGroup('user', {
    name: 'Deletion acceptance',
    memberIds: [writer.id, reader.id],
  });
  const personalFile = join(reader.workspace, 'retained-after-delete.txt');
  await writeFile(personalFile, nonce);
  const readerRoot = agentRoot(app.isles.runtime.workspace.dataDir, reader);
  const readerToken = (await readFile(join(readerRoot, 'isles-mcp-token'), 'utf8')).trim();
  const historyBeforeDelete = app.isles.store.listMessages(reader.channelId);
  progress('deleting an active real Agent');
  app.isles.runtime.send(reader.channelId, {
    body: 'Acceptance interruption check: reread AGENTS.md, then wait 10 seconds before publishing anything. Your turn will be interrupted by the test.',
    clientId: randomUUID(),
  });
  await until(
    () =>
      app!.isles.store
        .agentDetail(reader.id)
        .runs.some((run) => run.status === 'running' && run.turnId !== null),
    'native turn accepted before deletion',
  );
  const deletedResponse = await app.inject({ method: 'DELETE', url: `/api/agents/${reader.id}` });
  assert.equal(deletedResponse.statusCode, 200);
  assert.equal(deletedResponse.json().status, 'deleted');
  assert.equal(app.isles.store.publicAgent(reader.id).threadId, beforeEdit.threadId);
  assert.deepEqual(app.isles.store.memberIds(group.id), [writer.id]);
  assert.equal(app.isles.store.agentDetail(reader.id).runs[0]!.status, 'interrupted');
  assert.deepEqual(
    app.isles.store.listMessages(reader.channelId).slice(0, historyBeforeDelete.length),
    historyBeforeDelete,
  );
  assert.equal(await readFile(personalFile, 'utf8'), nonce);
  assert.equal(await readFile(join(root, 'work', 'shared', fileName), 'utf8'), payload);
  assert.equal((await readFile(join(readerRoot, 'isles-mcp-token'), 'utf8')).trim(), readerToken);
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/agents/${reader.id}`,
        payload: { name: 'Cannot revive' },
      })
    ).statusCode,
    410,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: `/api/agents/${reader.id}/resume` })).statusCode,
    410,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/channels/${reader.channelId}/messages`,
        payload: { body: 'Read only', clientId: 'deleted-write' },
      })
    ).statusCode,
    409,
  );
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const rejectedMcp = await fetch(`http://127.0.0.1:${address.port}/mcp/${reader.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readerToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(rejectedMcp.status, 401);
  report.checks.push(
    'active native deletion interrupts turn, leaves groups, revokes MCP and retains history/personal/shared files',
  );
  await app.close();
  app = undefined;
  progress('restarting after deletion');
  app = await open();
  await until(() => ready(writer), 'surviving Agent restored');
  assert.equal(app.isles.store.publicAgent(writer.id).threadId, report.agents[0]!.threadId);
  const afterRestart = app.isles.store.publicAgent(reader.id);
  assert.equal(afterRestart.status, 'deleted');
  assert.equal(afterRestart.name, editedName);
  assert.equal(afterRestart.model, alternate.model);
  assert.equal(afterRestart.reasoningEffort, editedEffort);
  assert.equal(app.isles.store.listAgents().length, 1);
  assert.equal(app.isles.store.listAgents(true).length, 2);
  assert.equal((await app.inject(`/api/agents/${reader.id}`)).statusCode, 200);
  assert.equal(await readFile(personalFile, 'utf8'), nonce);
  report.checks.push(
    'restart restores only the surviving original thread; deleted identity and read-only history remain',
  );
  const normalize = (path: string) =>
    process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  for (const source of report.instructionSources) {
    const agent = report.agents.find((candidate) => candidate.id === source.agentId)!;
    assert.ok(
      source.paths.some(
        (path) => normalize(path) === normalize(join(agent.workspace, 'AGENTS.md')),
      ),
    );
    assert.equal(source.injectedRules, false);
  }
  assert.equal(
    report.instructionSources.filter((source) => source.method === 'thread/start').length,
    2,
  );
  assert.equal(
    report.instructionSources.filter((source) => source.method === 'thread/resume').length,
    4,
  );
  assert.equal(await configHash(), before);
  report.checks.push(
    'native file instructions confirmed on start/resume; shared Codex config unchanged',
  );
  report.success = true;
} catch (error) {
  report.error = app?.isles.runtime.workspace.redactor.text(error) ?? String(error);
  process.exitCode = 1;
} finally {
  await app?.close();
  report.finishedAt = new Date().toISOString();
  const reportPath = join(root, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      success: report.success,
      reportPath,
      checks: report.checks,
      error: report.error,
    }),
  );
}
