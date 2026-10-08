// Opt-in: pnpm --filter @isles/server exec tsx test/verify-native-steer.ts
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigManager } from '@isles/config';
import type { Agent, Message } from '@isles/contracts';
import { buildApp } from '../src/app.js';
import { CodexAdapter } from '../src/codex/adapter.js';
import { StdioClient } from '../src/codex/client.js';
import { NativeEnvironment } from '../src/codex/environment.js';
import { NativeRpcError, threadResponseSchema } from '../src/codex/protocol.js';
import { HttpError } from '../src/errors.js';
import { agentRoot } from '../src/runtime/workspace.js';

const root = await mkdtemp(join(tmpdir(), 'isles-native-steer-'));
const configFilePath = join(root, 'config.toml');
const environment: NodeJS.ProcessEnv = {};
for (const key of ['CODEX_HOME', 'ISLES_CODEX_HOME'])
  if (process.env[key]) environment[key] = process.env[key];
const deadline = Date.now() + 600_000;
const nonce = randomUUID().slice(0, 8);
const report = {
  success: false,
  root,
  startedAt: new Date().toISOString(),
  finishedAt: '',
  version: null as string | null,
  model: null as string | null,
  agents: [] as { id: string; threadId: string; steerEnabled: boolean }[],
  sources: [] as { agentId: string; method: string; threadId: string; paths: string[] }[],
  inputs: [] as {
    agentId: string;
    method: string;
    threadId: string;
    batchId: string | null;
    expectedTurnId: string | null;
    text: string;
    acknowledgedTurnId: string | null;
  }[],
  commands: [] as { agentId: string; itemId: string; event: string; at: string; text: string }[],
  tools: [] as { agentId: string; name: string; arguments: Record<string, unknown> }[],
  appended: [] as { channelId: string; seq: number; sender: string; marker: string }[],
  run: null as { id: string; threadId: string; turnId: string; status: string } | null,
  batches: [] as unknown[],
  refusal: null as { code: number | null; message: string } | null,
  configHashBefore: null as string | null,
  configHashAfter: null as string | null,
  checks: [] as string[],
  error: null as string | null,
};
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
const clients = new Map<string, StdioClient>();
const current = () => {
  assert.ok(app);
  return app;
};
const progress = (stage: string) => console.log(JSON.stringify({ stage, root }));
const ready = (agent: Agent) => current().isles.store.publicAgent(agent.id).status === 'ready';

async function open() {
  const instance = await buildApp({
    config: new ConfigManager({ configFilePath, environment }),
    adapterFactory: (workspace, config) => {
      const native = new NativeEnvironment(config, workspace);
      return [
        new CodexAdapter(native, undefined, async (agent, handlers, _baseUrl, connecting) => {
          const client = new StdioClient(
            await native.executable(),
            agent.workspace,
            await native.launch(agent),
            {
              ...handlers,
              notification: (method, params) => {
                const item = params.item as
                  | { id?: unknown; type?: unknown; command?: unknown; aggregatedOutput?: unknown }
                  | undefined;
                if (item?.type === 'commandExecution' && typeof item.id === 'string')
                  report.commands.push({
                    agentId: agent.id,
                    itemId: item.id,
                    event: method,
                    at: new Date().toISOString(),
                    text: native.redactor.text(
                      [item.command, item.aggregatedOutput]
                        .filter((value) => typeof value === 'string')
                        .join('\n'),
                    ),
                  });
                handlers.notification(method, params);
              },
            },
            native.redactor,
            native.log.child({ agentId: agent.id }),
          );
          clients.set(agent.id, client);
          connecting(client);
          const request = client.request.bind(client);
          client.request = async <T = unknown>(method: string, params: Record<string, unknown>) => {
            let recorded: (typeof report.inputs)[number] | undefined;
            if (method === 'turn/start' || method === 'turn/steer') {
              recorded = {
                agentId: agent.id,
                method,
                threadId: String(params.threadId),
                batchId:
                  typeof params.clientUserMessageId === 'string'
                    ? params.clientUserMessageId
                    : null,
                expectedTurnId:
                  typeof params.expectedTurnId === 'string' ? params.expectedTurnId : null,
                text: native.redactor.text(
                  (params.input as { text?: string }[]).map((item) => item.text ?? '').join('\n'),
                ),
                acknowledgedTurnId: null,
              };
              report.inputs.push(recorded);
            }
            const result = await request<T>(method, params);
            if (recorded) {
              const response = result as { turn?: { id?: string }; turnId?: string };
              recorded.acknowledgedTurnId = response.turnId ?? response.turn?.id ?? null;
            }
            if (method === 'thread/start' || method === 'thread/resume') {
              const response = threadResponseSchema.parse(result);
              report.sources.push({
                agentId: agent.id,
                method,
                threadId: response.thread.id,
                paths: response.instructionSources,
              });
            }
            return result;
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
  instance.addHook('preHandler', async (request) => {
    if (!request.url.startsWith('/mcp/')) return;
    const rpc = request.body as
      | { method?: string; params?: { name: string; arguments?: Record<string, unknown> } }
      | undefined;
    if (rpc?.method !== 'tools/call' || !rpc.params) return;
    report.tools.push({
      agentId: request.url.slice('/mcp/'.length),
      name: rpc.params.name,
      arguments: rpc.params.arguments ?? {},
    });
    if (['receive_messages', 'read_messages', 'read_history'].includes(rpc.params.name))
      throw new HttpError(403, 'Steer acceptance disables inbox and history reads');
  });
  try {
    await instance.listen({ host: '127.0.0.1', port: 0 });
    return instance;
  } catch (error) {
    await instance.close();
    throw error;
  }
}

async function until(predicate: () => boolean, label: string) {
  let nextProgress = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const agent of current().isles.store.listAgents())
      if (agent.status === 'error') throw new Error(agent.error ?? `Agent ${agent.id} failed`);
    if (predicate()) return;
    if (Date.now() >= nextProgress) {
      progress(`waiting: ${label}`);
      nextProgress = Date.now() + 15_000;
    }
    await sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
}

async function peerMessage(peer: Agent, channelId: string, body: string) {
  const token = (
    await readFile(
      join(agentRoot(current().isles.runtime.workspace.dataDir, peer), 'isles-mcp-token'),
      'utf8',
    )
  ).trim();
  const address = current().server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp/${peer.id}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'send_message', arguments: { channelId, body, clientId: randomUUID() } },
    }),
  });
  assert.equal(response.status, 200);
  const rpc = (await response.json()) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  assert.equal(Boolean(rpc.result.isError), false);
  const seq = (JSON.parse(rpc.result.content[0]!.text) as { seq: number }).seq;
  return current()
    .isles.store.listMessages(channelId)
    .find((message) => message.seq === seq)!;
}

async function configHash() {
  try {
    const native = (current().isles.runtime.harnesses.get('codex') as CodexAdapter).environment;
    return createHash('sha256')
      .update(await readFile(join(native.home, 'config.toml')))
      .digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

try {
  app = await open();
  report.configHashBefore = await configHash();
  const catalog = app.isles.runtime.harnesses.get('codex').catalog;
  const status = await catalog.status();
  assert.ok(status.available && status.authenticated, status.error ?? 'Codex unavailable');
  report.version = status.version;
  const models = await catalog.models();
  const model =
    models.find((value) => value.model === 'gpt-6.1-sol') ??
    models.find((value) => value.isDefault);
  assert.ok(model && model.supportedReasoningEfforts.includes('high'));
  report.model = model.model;
  const create = (name: string, steerEnabled: boolean) =>
    current().isles.runtime.createAgent({
      harness: 'codex',
      name,
      model: model.model,
      reasoningEffort: 'high',
      steerEnabled,
    });
  const reader = await create(`Steer reader ${nonce}`, true);
  const peer = await create(`Steer peer ${nonce}`, false);
  await until(() => ready(reader) && ready(peer), 'two native sessions initialized');
  for (const agent of [reader, peer]) {
    const stored = app.isles.store.publicAgent(agent.id);
    assert.ok(stored.threadId);
    assert.ok(
      report.sources.some(
        (source) =>
          source.agentId === agent.id &&
          source.threadId === stored.threadId &&
          source.paths.includes(join(agent.workspace, 'AGENTS.md')),
      ),
    );
    report.agents.push({
      id: agent.id,
      threadId: stored.threadId,
      steerEnabled: stored.steerEnabled,
    });
  }
  const group = app.isles.runtime.createGroup('user', {
    name: `Steer group ${nonce}`,
    memberIds: [reader.id, peer.id],
  });
  const readyMarker = `STEER_READY_${nonce}`;
  const ackMarker = `STEER_ACK_${nonce}`;
  const beginMarker = `STEER_WAIT_BEGIN_${nonce}`;
  const endMarker = `STEER_WAIT_END_${nonce}`;
  const command =
    process.platform === 'win32'
      ? `Write-Output '${beginMarker}'; Start-Sleep -Seconds 30; Write-Output '${endMarker}'`
      : `printf '%s\\n' '${beginMarker}'; sleep 30; printf '%s\\n' '${endMarker}'`;
  progress('reader starts one turn, sends READY, then runs a 30-second command');
  app.isles.runtime.send(reader.channelId, {
    clientId: randomUUID(),
    body: `Steer acceptance task. First use Isles MCP send_message to private with body exactly ${readyMarker}. Then run this shell command once: ${command}. Let the command finish normally; do not cancel or replace it. You will receive three appended conversation messages during that same turn, carrying source=private_user, source=group_user, and source=group_peer with unpredictable value= markers. After the command ends, extract those values ONLY from the appended conversation messages, and use Isles MCP send_message to private with body exactly ${ackMarker}|private_user=<value>|group_user=<value>|group_peer=<value>, replacing each <value>. Do not call receive_messages, read_messages, read_history, other inbox/history tools, or inspect Isles data files; they are disabled. The group peer author is named ${JSON.stringify(peer.name)}. Do not finish the turn until all three sources have been acknowledged. Your official send_message is the result; ordinary assistant prose is not an acknowledgement.`,
  });
  await until(
    () =>
      app!.isles.store
        .listMessages(reader.channelId)
        .some((message) => message.senderId === reader.id && message.body === readyMarker) &&
      app!.isles.store
        .agentDetail(reader.id)
        .runs.some(
          (run) =>
            run.turnId &&
            run.items.some(
              (item) =>
                item.type === 'commandExecution' &&
                item.status === 'running' &&
                item.text.includes(beginMarker),
            ),
        ),
    'READY and running command with known turn ID',
  );
  const active = app.isles.store.agentDetail(reader.id).runs[0]!;
  assert.ok(active.turnId && !active.finishedAt);
  const originalTurnId = active.turnId;
  const markers = {
    private_user: `PRIVATE_${randomUUID()}`,
    group_user: `USER_${randomUUID()}`,
    group_peer: `PEER_${randomUUID()}`,
  };
  const appended: Message[] = [];
  const sendSource = (channelId: string, source: string, value: string) =>
    app!.isles.runtime.send(channelId, {
      clientId: randomUUID(),
      body: `source=${source} value=${value}. Keep this message in the current turn acknowledgement; it was appended during the command.`,
    });
  progress('appending private user, group user and authenticated peer messages');
  appended.push(sendSource(reader.channelId, 'private_user', markers.private_user));
  const peerAppend = await peerMessage(
    peer,
    group.id,
    `source=group_peer value=${markers.group_peer}. Keep this message in the current turn acknowledgement; it was appended during the command.`,
  );
  // Publish as the idle peer before stopping it; subsequent user group input must not
  // wake an unnecessary peer model turn.
  await app.isles.runtime.stop(peer.id);
  appended.push(sendSource(group.id, 'group_user', markers.group_user));
  appended.push(peerAppend);
  report.appended = appended.map((message, index) => ({
    channelId: message.channelId,
    seq: message.seq,
    sender: message.sender,
    marker: Object.values(markers)[index]!,
  }));
  const expectedAck = `${ackMarker}|private_user=${markers.private_user}|group_user=${markers.group_user}|group_peer=${markers.group_peer}`;
  await until(
    () =>
      ready(reader) &&
      app!.isles.store
        .listMessages(reader.channelId)
        .some((message) => message.senderId === reader.id && message.body === expectedAck),
    'one-turn official acknowledgement',
  );
  const detail = app.isles.store.agentDetail(reader.id);
  assert.equal(detail.runs.length, 1);
  const completed = detail.runs[0]!;
  assert.equal(completed.id, active.id);
  assert.equal(completed.turnId, originalTurnId);
  assert.equal(completed.status, 'completed');
  report.run = {
    id: completed.id,
    threadId: completed.threadId,
    turnId: originalTurnId,
    status: completed.status,
  };
  const inputs = report.inputs.filter((input) => input.agentId === reader.id);
  assert.equal(inputs.filter((input) => input.method === 'turn/start').length, 1);
  const steers = inputs.filter((input) => input.method === 'turn/steer');
  assert.ok(steers.length >= 1);
  const combined = steers.map((input) => input.text).join('\n\n');
  for (const input of steers) {
    assert.equal(input.threadId, completed.threadId);
    assert.equal(input.expectedTurnId, originalTurnId);
    assert.equal(input.acknowledgedTurnId, originalTurnId);
    assert.ok(input.batchId);
    const batch = app.isles.store.getSteer(input.batchId);
    assert.equal(batch.status, 'accepted');
    assert.equal(batch.runId, completed.id);
    assert.equal(batch.turnId, originalTurnId);
    report.batches.push(batch);
  }
  for (const message of appended) {
    const stored: Message = app.isles.store
      .listMessages(message.channelId)
      .find((candidate) => candidate.seq === message.seq)!;
    assert.equal(
      stored.deliveries.find((delivery) => delivery.agentId === reader.id)?.status,
      'completed',
    );
    assert.ok(
      completed.inputs.some(
        (input) => input.channelId === message.channelId && input.messageSeqs.includes(message.seq),
      ),
    );
    const from = message.sender === 'agent' ? `agent:${JSON.stringify(peer.name)}` : 'user';
    const channel = message.channelId === reader.channelId ? 'private' : JSON.stringify(group.name);
    assert.ok(
      combined.includes(
        `[channel: ${channel}, seq: ${message.seq}, from: ${from}]\n${message.body}`,
      ),
    );
  }
  assert.equal(
    report.tools.filter((call) =>
      ['receive_messages', 'read_messages', 'read_history'].includes(call.name),
    ).length,
    0,
  );
  assert.equal(
    report.inputs.filter((input) => input.agentId === peer.id && input.method === 'turn/start')
      .length,
    0,
  );
  assert.ok(
    completed.items.some(
      (item) =>
        item.type === 'commandExecution' &&
        item.status === 'completed' &&
        item.text.includes(endMarker),
    ),
    'The wait command should finish normally; this check does not claim immediate interruption',
  );
  report.checks.push(
    'three sources steered into the original turn, official MCP ACK, complete source metadata and delivery ownership, no inbox/history reads or extra model turns',
  );
  progress('checking explicit no-active refusal without starting a model turn');
  try {
    await clients.get(reader.id)!.request('turn/steer', {
      threadId: completed.threadId,
      expectedTurnId: originalTurnId,
      clientUserMessageId: `refusal-probe-${nonce}`,
      input: [{ type: 'text', text: 'No-active-turn protocol probe.', text_elements: [] }],
    });
    assert.fail('No-active steer unexpectedly accepted');
  } catch (error) {
    assert.ok(error instanceof NativeRpcError);
    assert.equal(error.code, -32600);
    report.refusal = {
      code: error.code ?? null,
      message: app.isles.runtime.workspace.redactor.text(error),
    };
  }
  const threadId = completed.threadId;
  await app.close();
  app = undefined;
  progress('reopening isolated data and verifying saved switch and thread');
  app = await open();
  await until(() => ready(reader), 'reader resumes the same native thread');
  assert.equal(app.isles.store.publicAgent(reader.id).threadId, threadId);
  assert.equal(app.isles.store.publicAgent(reader.id).steerEnabled, true);
  assert.equal(app.isles.store.publicAgent(peer.id).status, 'stopped');
  const edited = await app.inject({
    method: 'PATCH',
    url: `/api/agents/${reader.id}`,
    payload: { steerEnabled: false },
  });
  assert.equal(edited.statusCode, 200);
  assert.equal(app.isles.store.publicAgent(reader.id).steerEnabled, false);
  assert.equal(app.isles.store.publicAgent(reader.id).threadId, threadId);
  await app.close();
  app = undefined;
  app = await open();
  await until(() => ready(reader), 'disabled steer setting and same thread restored');
  assert.equal(app.isles.store.publicAgent(reader.id).steerEnabled, false);
  assert.equal(app.isles.store.publicAgent(reader.id).threadId, threadId);
  assert.ok(
    report.sources.some(
      (source) =>
        source.agentId === reader.id &&
        source.method === 'thread/resume' &&
        source.threadId === threadId,
    ),
  );
  report.configHashAfter = await configHash();
  assert.equal(report.configHashAfter, report.configHashBefore);
  report.checks.push(
    'explicit native -32600 no-active refusal; enabled/disabled switch and same native binding survive restarts; personal Codex config hash unchanged',
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
