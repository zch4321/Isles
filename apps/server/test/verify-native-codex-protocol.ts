// ISLES_TEST_CODEX_BIN=<codex executable> pnpm --filter @isles/server exec tsx test/verify-native-codex-protocol.ts
// Runs the installed CLI against a local Responses fixture in an isolated Codex home.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigManager } from '@isles/config';
import { CodexAdapter } from '../src/harness/codex/adapter.js';
import { NativeEnvironment } from '../src/harness/codex/environment.js';
import type { HarnessEvent, HarnessSession } from '../src/harness/types.js';
import { AgentWorkspace } from '../src/runtime/workspace.js';
import type { AgentRecord } from '../src/storage/store.js';

assert.ok(
  process.env.ISLES_TEST_CODEX_BIN,
  'Set ISLES_TEST_CODEX_BIN to the native CLI executable',
);
const root = await mkdtemp(join(tmpdir(), 'isles-codex-protocol-'));
const home = join(root, 'native-home');
await mkdir(home);
const events: HarnessEvent[] = [];
const requests: { path: string; body: Record<string, unknown> }[] = [];
const held = new Set<ServerResponse>();
let inferenceRequests = 0;
const provider = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += String(chunk);
  const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
  requests.push({ path: request.url ?? '', body });
  if (request.url?.startsWith('/mcp/')) {
    if (body.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result:
          body.method === 'initialize'
            ? {
                protocolVersion: (body.params as { protocolVersion: string }).protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: 'local-isles-fixture', version: '1' },
              }
            : { tools: [] },
      }),
    );
    return;
  }
  assert.ok(request.url?.endsWith('/responses'), `Unexpected native route ${request.url}`);
  inferenceRequests++;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type: string, data: Record<string, unknown>) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('response.created', { response: { id: `local-${inferenceRequests}` } });
  if (inferenceRequests > 1) {
    held.add(response);
    response.on('close', () => held.delete(response));
    return;
  }
  const reasoning = {
    type: 'reasoning',
    id: 'reasoning-local',
    summary: [{ type: 'summary_text', text: 'Local protocol summary' }],
  };
  send('response.output_item.added', { output_index: 0, item: { ...reasoning, summary: [] } });
  send('response.reasoning_summary_part.added', {
    item_id: reasoning.id,
    output_index: 0,
    summary_index: 0,
    part: { type: 'summary_text', text: '' },
  });
  send('response.reasoning_summary_text.delta', {
    item_id: reasoning.id,
    output_index: 0,
    summary_index: 0,
    delta: 'Local protocol summary',
  });
  send('response.output_item.done', { output_index: 0, item: reasoning });
  const message = {
    type: 'message',
    role: 'assistant',
    id: 'message-local',
    content: [{ type: 'output_text', text: 'Local protocol answer', annotations: [] }],
  };
  send('response.output_item.added', { output_index: 1, item: { ...message, content: [] } });
  send('response.content_part.added', {
    item_id: message.id,
    output_index: 1,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });
  send('response.output_text.delta', {
    item_id: message.id,
    output_index: 1,
    content_index: 0,
    delta: 'Local protocol answer',
  });
  send('response.output_item.done', { output_index: 1, item: message });
  send('response.completed', {
    response: {
      id: 'local-1',
      output: [reasoning, message],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 5 },
      },
    },
  });
  response.end();
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address();
assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}`;
await writeFile(
  join(home, 'config.toml'),
  `model_provider = "local_fixture"
model = "gpt-6.1-sol"
[model_providers.local_fixture]
name = "Local protocol fixture"
base_url = "${baseUrl}/v1"
wire_api = "responses"
requires_openai_auth = false
`,
);
const config = new ConfigManager({
  configFilePath: join(root, 'isles.toml'),
  homeDir: root,
  environment: {
    ISLES_DATA_DIR: root,
    ISLES_WORKSPACE_DIR: join(root, 'work'),
    ISLES_CODEX_HOME: home,
    ISLES_CODEX_BIN: process.env.ISLES_TEST_CODEX_BIN,
  },
});
const environment = new NativeEnvironment(config, new AgentWorkspace(config));
const adapter = new CodexAdapter(environment);
const agent = {
  id: randomUUID(),
  channelId: randomUUID(),
  name: 'Codex protocol fixture',
  harness: 'codex',
  workspace: join(root, 'agent'),
  nativeHome: home,
  model: 'gpt-6.1-sol',
  reasoningEffort: 'high',
  threadId: null,
  threadCreationAttempted: false,
  canCreateGroups: false,
  dangerFullAccess: false,
  steerEnabled: false,
  desiredState: 'running',
  status: 'creating',
  error: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} satisfies AgentRecord;
let session: HarnessSession | undefined;
const report: Record<string, unknown> = { root };
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  const status = await adapter.catalog.status();
  assert.ok(status.available && status.authenticated, status.error ?? 'Native catalog unavailable');
  assert.ok((await adapter.catalog.models()).length > 0);
  report.version = status.version;
  session = await adapter.connect(agent, baseUrl, {
    connected: (value) => {
      session = value;
    },
    event: (event) => events.push(event),
    question: () => {
      throw new Error('Unexpected interactive request');
    },
    exit: (error) => {
      report.nativeExit = error.message;
    },
  });
  const threadId = await session.createSession(() => {});
  assert.equal(await session.resumeSession(threadId), threadId);
  assert.equal(inferenceRequests, 0);
  const input = {
    sessionId: threadId,
    runId: randomUUID(),
    text: 'Local fixture turn',
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    workspace: agent.workspace,
  };
  const first = await session.submit(input);
  await until(
    () => events.some((event) => event.type === 'turn_completed' && event.turnId === first.turnId),
    'first turn completion',
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === 'turn_completed' &&
        event.turnId === first.turnId &&
        event.status === 'completed',
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === 'item_delta' &&
        event.item.type === 'reasoning' &&
        event.item.text === 'Local protocol summary',
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === 'item' &&
        event.item.type === 'reasoning' &&
        event.item.text === 'Local protocol summary',
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === 'item' &&
        event.item.type === 'agentMessage' &&
        event.item.text === 'Local protocol answer',
    ),
  );
  assert.ok(
    events.some((event) => event.type === 'context_usage' && event.usage?.usedTokens === 120),
  );
  const second = await session.submit({ ...input, runId: randomUUID() });
  await until(() => inferenceRequests === 2, 'held local response');
  assert.deepEqual(
    await session.steer!({
      sessionId: threadId,
      expectedTurnId: second.turnId,
      batchId: randomUUID(),
      text: 'Steer local fixture',
    }),
    { turnId: second.turnId },
  );
  await session.interrupt(threadId, second.turnId);
  await until(
    () =>
      events.some(
        (event) =>
          event.type === 'turn_completed' &&
          event.turnId === second.turnId &&
          event.status === 'interrupted',
      ),
    'turn interruption',
  );
  assert.ok(requests.some((request) => request.body.method === 'tools/list'));
  assert.equal(report.nativeExit, undefined);
  Object.assign(report, {
    passed: true,
    inferenceRequests,
    mcpConnected: requests.some((request) => request.body.method === 'tools/list'),
    checks: [
      'native catalog',
      'AGENTS.md start/resume verification',
      'thread history injection',
      'reasoning and message streams',
      'context usage',
      'turn steer and interrupt',
    ],
  });
} catch (error) {
  Object.assign(report, {
    passed: false,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  await session?.close();
  for (const response of held) response.destroy();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await writeFile(
    join(root, 'report.json'),
    JSON.stringify({ ...report, requests, events }, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
