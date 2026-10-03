// Opt-in native acceptance: pnpm --filter @isles/server exec tsx test/verify-native-config.ts
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
import { agentRoot } from '../src/codex/environment.js';
import { StdioClient } from '../src/codex/client.js';
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
  agents: [] as { id: string; threadId: string | null; workspace: string }[],
  instructionSources: [] as {
    agentId: string;
    method: string;
    threadId: string;
    paths: string[];
    injectedRules: boolean;
  }[],
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
    clientFactory: async (agent, handlers) => {
      const native = instance.isles.runtime.environment;
      const client = new StdioClient(
        await native.executable(),
        agent.workspace,
        await native.launch(agent),
        handlers,
        native.redactor,
      );
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
        return response;
      };
      try {
        await client.initialize();
        return client;
      } catch (error) {
        await client.close();
        throw error;
      }
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
    const file = await readFile(join(current().isles.runtime.environment.home, 'config.toml'));
    return createHash('sha256').update(file).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
try {
  app = await open();
  const before = await configHash();
  const status = await app.isles.runtime.catalog.status();
  assert.ok(status.available && status.authenticated, status.error ?? 'Codex is not authenticated');
  const models = await app.isles.runtime.catalog.models();
  const model =
    models.find((candidate) => candidate.model === 'gpt-6.1-sol') ??
    models.find((candidate) => candidate.isDefault);
  assert.ok(model);
  assert.ok(model.supportedReasoningEfforts.includes('high'));
  report.version = status.version;
  report.model = model.model;
  progress('native catalog ready');
  const writer = await app.isles.runtime.createAgent({
    name: 'Workspace acceptance writer',
    model: model.model,
    reasoningEffort: 'high',
  });
  const reader = await app.isles.runtime.createAgent({
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
    url: '/api/codex/config',
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
    2,
  );
  assert.equal(await configHash(), before);
  report.checks.push(
    'native file instructions confirmed on start/resume; shared Codex config unchanged',
  );
  report.success = true;
} catch (error) {
  report.error = app?.isles.runtime.environment.redactor.text(error) ?? String(error);
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
