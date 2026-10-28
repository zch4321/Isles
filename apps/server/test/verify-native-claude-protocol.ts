// Opt-in: ISLES_CLAUDE_BIN=<native CLI> pnpm --filter @isles/server exec tsx test/verify-native-claude-protocol.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigManager } from '@isles/config';
import { ClaudeAdapter } from '../src/harness/claude/adapter.js';
import { ClaudeClient, type ClaudeFrame } from '../src/harness/claude/client.js';
import { ClaudeEnvironment } from '../src/harness/claude/environment.js';
import type { HarnessEvent, HarnessQuestion, HarnessSession } from '../src/harness/types.js';
import { AgentWorkspace } from '../src/runtime/workspace.js';
import type { AgentRecord } from '../src/storage/store.js';

// The real CLI talks to a scripted local Anthropic provider and an empty local MCP server.
// Configuration, authentication and persisted native sessions all live in this temporary root.
const root = await mkdtemp(join(tmpdir(), 'isles-native-claude-protocol-'));
let inferenceRequests = 0;
let releaseResponse: (() => void) | undefined;
let releaseChild: (() => void) | undefined;
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as ClaudeFrame;
  if (request.url?.startsWith('/mcp')) {
    if (!('id' in body)) {
      response.writeHead(202).end();
      return;
    }
    const result =
      body.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'isles-protocol', version: '1' },
          }
        : body.method === 'tools/list'
          ? { tools: [] }
          : {};
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    return;
  }
  if (request.url?.includes('count_tokens')) {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ input_tokens: 1200 }));
    return;
  }
  if (!request.url?.startsWith('/v1/messages')) {
    response.writeHead(404).end();
    return;
  }
  inferenceRequests++;
  const messages = body.messages as { role: string; content: unknown }[];
  const last = JSON.stringify(
    messages.filter((message) => message.role === 'user').at(-1)?.content,
  );
  if (last.includes('PROTOCOL_HOLD'))
    await new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
  if (last.includes('PROTOCOL_CHILD_HOLD'))
    await new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
  const ask = last.includes('PROTOCOL_ASK');
  const background = last.includes('PROTOCOL_BACKGROUND');
  const content = background
    ? {
        type: 'tool_use',
        id: `tool_${randomUUID()}`,
        name: 'Agent',
        input: {
          description: 'Protocol background activity',
          prompt: 'PROTOCOL_CHILD_HOLD. Reply PROTOCOL_CHILD_OK.',
          subagent_type: 'general-purpose',
          run_in_background: true,
        },
      }
    : ask
      ? {
          type: 'tool_use',
          id: `tool_${randomUUID()}`,
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Which protocol result?',
                header: 'Result',
                options: [
                  { label: 'One', description: 'First result' },
                  { label: 'Two', description: 'Second result' },
                ],
                multiSelect: false,
              },
            ],
          },
        }
      : {
          type: 'text',
          text: last.includes('Isles session initialized.') ? 'READY' : 'PROTOCOL_OK',
        };
  const id = `msg_${randomUUID()}`;
  response.setHeader('Content-Type', 'text/event-stream');
  const event = (type: string, data: object) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1200, output_tokens: 1 },
    },
  });
  event('content_block_start', {
    index: 0,
    content_block: ask || background ? { ...content, input: {} } : { type: 'text', text: '' },
  });
  event('content_block_delta', {
    index: 0,
    delta:
      ask || background
        ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) }
        : { type: 'text_delta', text: content.text },
  });
  event('content_block_stop', { index: 0 });
  event('message_delta', {
    delta: { stop_reason: ask || background ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  event('message_stop', {});
  response.end();
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address();
assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}`;
for (const name of [
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
])
  delete process.env[name];
Object.assign(process.env, {
  ANTHROPIC_API_KEY: 'isles-local-protocol-test',
  ANTHROPIC_BASE_URL: baseUrl,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
});
const home = join(root, 'native-home');
await mkdir(home);
const config = new ConfigManager({
  configFilePath: join(root, 'config.toml'),
  homeDir: root,
  environment: {
    ISLES_DATA_DIR: join(root, 'data'),
    ISLES_CLAUDE_HOME: home,
    ISLES_CLAUDE_BIN: process.env.ISLES_CLAUDE_BIN,
  },
});
const environment = new ClaudeEnvironment(config, new AgentWorkspace(config));
const frames: ClaudeFrame[] = [];
const initializations: ClaudeFrame[] = [];
let native: ClaudeClient;
const adapter = new ClaudeAdapter(
  environment,
  undefined,
  (command, args, workspace, env, handlers, log) => {
    const client = new ClaudeClient(
      command,
      args,
      workspace,
      env,
      {
        ...handlers,
        event: (frame) => {
          frames.push(frame);
          handlers.event(frame);
        },
      },
      environment.redactor,
      log,
    );
    native = client;
    const control = client.control.bind(client);
    client.control = async (subtype, params) => {
      const result = await control(subtype, params);
      if (subtype === 'initialize') initializations.push(result as ClaudeFrame);
      return result;
    };
    return client;
  },
);
const events: HarnessEvent[] = [];
const questions: HarnessQuestion[] = [];
let failure: Error | undefined;
const handlers = {
  connected: () => {},
  event: (event: HarnessEvent) => events.push(event),
  question: (question: HarnessQuestion) => questions.push(question),
  exit: (error: Error) => {
    failure = error;
  },
};
const agent: AgentRecord = {
  id: randomUUID(),
  channelId: randomUUID(),
  name: 'Claude protocol',
  harness: 'claude',
  model: 'default',
  reasoningEffort: 'high',
  workspace: join(root, 'workspace'),
  workspacePaths: [],
  nativeHome: home,
  threadId: null,
  threadCreationAttempted: false,
  canCreateGroups: false,
  dangerFullAccess: false,
  steerEnabled: true,
  desiredState: 'running',
  status: 'creating',
  error: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const report: Record<string, unknown> = { root, checkedAt: new Date().toISOString() };
let session: HarnessSession | undefined;
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (failure) throw failure;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await sleep(25);
  }
}
async function submit(text: string, sessionId: string) {
  const input = {
    runId: randomUUID(),
    sessionId,
    text,
    workspace: agent.workspace,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
  };
  await session!.submit(input);
  return input;
}
try {
  const status = await adapter.catalog.status();
  assert.ok(status.available && status.authenticated, status.error ?? 'CLI unavailable');
  report.version = status.version;
  report.models = await adapter.catalog.models();
  assert.equal(inferenceRequests, 0, 'Catalog made an inference request');
  session = await adapter.connect(agent, baseUrl, handlers);
  const sessionId = await session.createSession(() => {});
  assert.equal(initializations[0]?.current_permission_mode, 'acceptEdits');
  assert.equal(events.filter((event) => event.type === 'turn_completed').length, 0);
  assert.ok(events.some((event) => event.type === 'context_usage'));
  const input = await submit('PROTOCOL_REPLY', sessionId);
  await until(
    () => events.some((event) => event.type === 'turn_completed' && event.turnId === input.runId),
    'normal result',
  );
  const result = frames.find(
    (frame) => frame.type === 'result' && frame.user_message_uuid === input.runId,
  );
  assert.ok(result && result.is_error === false);
  assert.ok(
    Array.isArray(result.user_message_uuids) && result.user_message_uuids.includes(input.runId),
  );
  const asked = await submit('PROTOCOL_ASK', sessionId);
  await until(() => questions.length === 1, 'AskUserQuestion control');
  const question = questions[0]!;
  assert.equal(question.turnId, asked.runId);
  session.answer(question.requestId, { answers: { 'question-0': { answers: ['One'] } } });
  await until(
    () => events.some((event) => event.type === 'turn_completed' && event.turnId === asked.runId),
    'question result',
  );
  const held = await submit('PROTOCOL_HOLD', sessionId);
  await until(() => Boolean(releaseResponse), 'held provider response');
  const batchId = randomUUID();
  assert.ok(session.steer);
  const steer = session.steer({
    sessionId,
    expectedTurnId: held.runId,
    batchId,
    text: 'PROTOCOL_STEER',
  });
  await until(
    () =>
      frames.some(
        (frame) =>
          frame.type === 'command_lifecycle' &&
          frame.command_uuid === batchId &&
          frame.state === 'queued',
      ),
    'queued steer receipt',
  );
  releaseResponse!();
  releaseResponse = undefined;
  const consumed = await steer;
  assert.equal(consumed.turnId, batchId);
  await until(
    () => events.some((event) => event.type === 'turn_completed' && event.turnId === held.runId),
    'first native result',
  );
  await until(
    () =>
      events.some((event) => event.type === 'turn_completed' && event.turnId === consumed.turnId),
    'queued input native result',
  );
  const backgroundInput = await submit('PROTOCOL_BACKGROUND', sessionId);
  await until(() => Boolean(releaseChild), 'background inference');
  await until(
    () =>
      events.some(
        (event) => event.type === 'turn_completed' && event.turnId === backgroundInput.runId,
      ),
    'root result while child remains active',
  );
  const child = events.find(
    (event) => event.type === 'turn_started' && event.sessionId !== sessionId,
  );
  assert.ok(child && child.type === 'turn_started');
  assert.ok(
    !events.some((event) => event.type === 'turn_completed' && event.sessionId === child.sessionId),
  );
  releaseChild!();
  releaseChild = undefined;
  await until(
    () =>
      events.some(
        (event) => event.type === 'turn_completed' && event.sessionId === child.sessionId,
      ),
    'child completion after root',
  );
  await until(
    () =>
      events.some(
        (event) =>
          event.type === 'turn_completed' &&
          event.sessionId === sessionId &&
          ![input.runId, asked.runId, held.runId, consumed.turnId, backgroundInput.runId].includes(
            event.turnId,
          ),
      ),
    'automatic native wakeup',
  );
  const interrupted = await submit('PROTOCOL_HOLD', sessionId);
  await until(() => Boolean(releaseResponse), 'interrupt provider response');
  const usage = (await native!.control('get_context_usage', { detail: 'summary' })) as ClaudeFrame;
  assert.equal(typeof usage.totalTokens, 'number');
  await session.interrupt(sessionId, interrupted.runId);
  releaseResponse!();
  releaseResponse = undefined;
  await until(
    () =>
      events.some(
        (event) =>
          event.type === 'turn_completed' &&
          event.turnId === interrupted.runId &&
          event.status === 'interrupted',
      ),
    'interrupt result',
  );
  await session.close();
  session = await adapter.connect(agent, baseUrl, handlers);
  assert.equal(await session.resumeSession(sessionId), sessionId);
  const resumed = await submit('PROTOCOL_RESUMED', sessionId);
  await until(
    () => events.some((event) => event.type === 'turn_completed' && event.turnId === resumed.runId),
    'resumed result',
  );
  assert.equal(failure, undefined);
  report.checks = [
    'catalog without inference',
    'explicit acceptEdits',
    'guidance and context usage',
    'neutral initialization',
    'input acknowledgements and result UUIDs',
    'native AskUserQuestion and answer',
    'queued steer consumption',
    'background child completion after root and automatic native wakeup',
    'context control during inference',
    'interrupt',
    'same-session resume',
  ];
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  releaseResponse?.();
  releaseChild?.();
  await session?.close();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  report.inferenceRequests = inferenceRequests;
  await writeFile(join(root, 'frames.json'), JSON.stringify(frames, null, 2));
  await writeFile(join(root, 'events.json'), JSON.stringify(events, null, 2));
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
