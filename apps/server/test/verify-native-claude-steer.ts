// Opt-in: pnpm --filter @isles/server exec tsx test/verify-native-claude-steer.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigManager } from '@isles/config';
import type { Agent, Message } from '@isles/contracts';
import { buildApp } from '../src/app.js';
import { ClaudeAdapter, CLAUDE_INITIALIZATION_MESSAGE } from '../src/claude/adapter.js';
import { ClaudeClient } from '../src/claude/client.js';
import { ClaudeEnvironment } from '../src/claude/environment.js';
import { HttpError } from '../src/errors.js';
import { agentRoot } from '../src/runtime/workspace.js';

const root = await mkdtemp(join(tmpdir(), 'isles-native-claude-steer-'));
const environment: NodeJS.ProcessEnv = { ISLES_DATA_DIR: join(root, 'data') };
for (const key of ['ISLES_CLAUDE_BIN', 'ISLES_CLAUDE_HOME', 'CLAUDE_CONFIG_DIR'])
  if (process.env[key]) environment[key] = process.env[key];
const config = new ConfigManager({ configFilePath: join(root, 'config.toml'), environment });
const nonce = randomUUID().slice(0, 8);
const report = {
  success: false,
  root,
  startedAt: new Date().toISOString(),
  finishedAt: '',
  version: null as string | null,
  model: '',
  sessionId: '',
  launches: [] as { agentId: string; sessionId: string | undefined }[],
  inputs: [] as {
    agentId: string;
    sessionId: string;
    uuid: string;
    text: string;
    acknowledged: boolean;
  }[],
  frames: [] as {
    agentId: string;
    type: string;
    input: unknown;
    state: unknown;
    consumed: unknown;
  }[],
  tools: [] as { agentId: string; name: string }[],
  run: null as unknown,
  batches: [] as unknown[],
  checks: [] as string[],
  error: null as string | null,
};
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
const current = () => {
  assert.ok(app);
  return app;
};
const stage = (stage: string) => console.log(JSON.stringify({ stage, root }));
async function open() {
  const instance = await buildApp({
    config,
    adapterFactory: (workspace, config) => {
      const native = new ClaudeEnvironment(config, workspace);
      return [
        new ClaudeAdapter(native, undefined, (command, args, cwd, env, handlers, log) => {
          const agentId = new URL(
            JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers.isles.url,
          ).pathname
            .split('/')
            .at(-1)!;
          report.launches.push({
            agentId,
            sessionId: args.find((arg) => /^--(?:resume|session-id)=/.test(arg))?.split('=')[1],
          });
          const client = new ClaudeClient(
            command,
            args,
            cwd,
            env,
            {
              ...handlers,
              event: (frame) => {
                if (['command_lifecycle', 'result'].includes(String(frame.type)))
                  report.frames.push({
                    agentId,
                    type: String(frame.type),
                    input: frame.command_uuid ?? frame.user_message_uuid,
                    state: frame.state,
                    consumed: frame.user_message_uuids,
                  });
                handlers.event(frame);
              },
            },
            native.redactor,
            log,
          );
          const send = client.sendUser.bind(client);
          client.sendUser = async (sessionId, uuid, text, options) => {
            if (text === CLAUDE_INITIALIZATION_MESSAGE) return send(sessionId, uuid, text, options);
            const input = {
              agentId,
              sessionId,
              uuid,
              text: native.redactor.text(text),
              acknowledged: false,
            };
            report.inputs.push(input);
            await send(sessionId, uuid, text, options);
            input.acknowledged = true;
          };
          return client;
        }),
      ];
    },
  });
  instance.addHook('preHandler', async (request) => {
    if (!request.url.startsWith('/mcp/')) return;
    const rpc = request.body as { method?: string; params?: { name?: string } } | undefined;
    if (rpc?.method !== 'tools/call' || !rpc.params?.name) return;
    report.tools.push({ agentId: request.url.slice('/mcp/'.length), name: rpc.params.name });
    if (['receive_messages', 'read_messages', 'read_history'].includes(rpc.params.name))
      throw new HttpError(403, 'Steer acceptance disables inbox and history reads');
  });
  await instance.listen({ host: '127.0.0.1', port: 0 });
  return instance;
}
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 180_000;
  let progressAt = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const agent of current().isles.store.listAgents())
      if (agent.status === 'error') throw new Error(agent.error ?? 'Native Agent failed');
    if (predicate()) return;
    if (Date.now() >= progressAt) {
      stage(`waiting: ${label}`);
      progressAt = Date.now() + 15_000;
    }
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const ready = (id: string) => current().isles.store.publicAgent(id).status === 'ready';
const say = (channelId: string, body: string) =>
  current().isles.runtime.send(channelId, { body, clientId: randomUUID() });
const official = (agent: Agent, body: string) =>
  current()
    .isles.store.listMessages(agent.channelId)
    .some((message) => message.senderId === agent.id && message.body === body);
const delivery = (agent: Agent, message: Message) =>
  current()
    .isles.store.listMessages(message.channelId)
    .find((candidate) => candidate.seq === message.seq)!
    .deliveries.find((d) => d.agentId === agent.id)!;
async function peerMessage(peer: Agent, channelId: string, body: string) {
  const token = (
    await readFile(
      join(agentRoot(current().isles.runtime.workspace.dataDir, peer), 'isles-mcp-token'),
      'utf8',
    )
  ).trim();
  const address = current().server.address();
  assert.ok(address && typeof address !== 'string');
  const result = await fetch(`http://127.0.0.1:${address.port}/mcp/${peer.id}`, {
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
  assert.equal(result.status, 200);
  const rpc = (await result.json()) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  assert.equal(Boolean(rpc.result.isError), false);
  const seq = (JSON.parse(rpc.result.content[0]!.text) as { seq: number }).seq;
  return current()
    .isles.store.listMessages(channelId)
    .find((message) => message.seq === seq)!;
}
try {
  app = await open();
  const catalog = current().isles.runtime.harnesses.get('claude').catalog;
  const status = await catalog.status();
  assert.ok(status.available && status.authenticated, status.error ?? 'Claude unavailable');
  report.version = status.version;
  const models = await catalog.models();
  const model =
    models.find((model) => model.model === process.env.ISLES_TEST_CLAUDE_MODEL) ??
    models.find((model) => model.isDefault)!;
  assert.ok(model);
  report.model = model.model;
  const create = (name: string, steerEnabled: boolean) =>
    current().isles.runtime.createAgent({
      harness: 'claude',
      name,
      model: model.model,
      reasoningEffort: model.supportedReasoningEfforts.includes('high')
        ? 'high'
        : model.defaultReasoningEffort,
      steerEnabled,
    });
  stage('initialize two fixed Claude sessions');
  const reader = await create(`Claude steer reader ${nonce}`, true);
  const peer = await create(`Claude steer peer ${nonce}`, false);
  await until(() => ready(reader.id) && ready(peer.id), 'native initialization');
  const binding = current().isles.store.publicAgent(reader.id).threadId!;
  report.sessionId = binding;
  assert.equal(current().isles.store.agentDetail(reader.id).runs.length, 0);
  assert.equal(current().isles.store.listMessages(reader.channelId).length, 0);
  const group = current().isles.runtime.createGroup('user', {
    name: `Claude steer group ${nonce}`,
    memberIds: [reader.id, peer.id],
  });
  const readyMarker = `CLAUDE_STEER_READY_${nonce}`;
  const ackMarker = `CLAUDE_STEER_ACK_${nonce}`;
  const beginMarker = `CLAUDE_WAIT_BEGIN_${nonce}`;
  const endMarker = `CLAUDE_WAIT_END_${nonce}`;
  const command =
    process.platform === 'win32'
      ? `Write-Output '${beginMarker}'; Start-Sleep -Seconds 15; Write-Output '${endMarker}'`
      : `printf '%s\\n' '${beginMarker}'; sleep 15; printf '%s\\n' '${endMarker}'`;
  const secondWait = process.platform === 'win32' ? 'Start-Sleep -Seconds 6' : 'sleep 6';
  stage('run one turn with two tool boundaries and append three sources');
  say(
    reader.channelId,
    `Steer acceptance. First use Isles send_message to private with body exactly ${readyMarker}. Run this shell command exactly once and let it finish normally: ${command}. Then run another shell command exactly once: ${secondWait}. During this turn three additional conversation messages arrive with source=private_user, source=group_user, source=group_peer and unpredictable value= markers. After both commands finish, extract values ONLY from those additional conversation messages, then use Isles send_message to private with body exactly ${ackMarker}|private_user=<value>|group_user=<value>|group_peer=<value>. The peer is ${JSON.stringify(peer.name)}. Do not finish until all three values have been received and sent. Do not call inbox/history tools, read Isles data files, or create subagents. Native assistant prose is not the official acknowledgement.`,
  );
  await until(
    () =>
      official(reader, readyMarker) &&
      current()
        .isles.store.agentDetail(reader.id)
        .runs[0]?.items.some(
          (item) =>
            item.type === 'toolCall' &&
            item.status === 'running' &&
            item.text.includes(beginMarker),
        ) === true,
    'READY and running Bash command',
  );
  const original = current().isles.store.agentDetail(reader.id).runs[0]!;
  const markers = {
    private_user: randomUUID(),
    group_user: randomUUID(),
    group_peer: randomUUID(),
  };
  const appended = [say(reader.channelId, `source=private_user value=${markers.private_user}`)];
  appended.push(await peerMessage(peer, group.id, `source=group_peer value=${markers.group_peer}`));
  await current().isles.runtime.stop(peer.id);
  appended.push(say(group.id, `source=group_user value=${markers.group_user}`));
  const expected = `${ackMarker}|private_user=${markers.private_user}|group_user=${markers.group_user}|group_peer=${markers.group_peer}`;
  await until(
    () => ready(reader.id) && official(reader, expected),
    'same-turn official acknowledgement',
  );
  const runs = current().isles.store.agentDetail(reader.id).runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.id, original.id);
  assert.equal(runs[0]!.turnId, original.turnId);
  assert.equal(runs[0]!.status, 'completed');
  report.run = runs[0];
  const inputs = report.inputs.filter((input) => input.agentId === reader.id);
  assert.equal(inputs.filter((input) => input.uuid === original.id).length, 1);
  const steers = inputs.filter((input) => input.uuid !== original.id);
  assert.ok(steers.length);
  for (const input of steers) {
    assert.equal(input.sessionId, binding);
    assert.equal(input.acknowledged, true);
    const batch = current().isles.store.getSteer(input.uuid);
    assert.equal(batch.runId, original.id);
    assert.equal(batch.turnId, original.turnId);
    assert.equal(batch.status, 'accepted');
    report.batches.push(batch);
  }
  for (const value of Object.values(markers))
    assert.ok(steers.some((input) => input.text.includes(value)));
  for (const message of appended) {
    assert.equal(delivery(reader, message).status, 'completed');
    assert.ok(
      runs[0]!.inputs.some(
        (input) => input.channelId === message.channelId && input.messageSeqs.includes(message.seq),
      ),
    );
  }
  assert.equal(report.inputs.filter((input) => input.agentId === peer.id).length, 0);
  assert.equal(
    report.frames.filter(
      (frame) =>
        frame.agentId === reader.id &&
        frame.type === 'result' &&
        (frame.input === original.id ||
          (Array.isArray(frame.consumed) && frame.consumed.includes(original.id))),
    ).length,
    1,
  );
  assert.equal(
    report.tools.filter((tool) =>
      ['receive_messages', 'read_messages', 'read_history'].includes(tool.name),
    ).length,
    0,
  );
  assert.ok(
    runs[0]!.items.some(
      (item) =>
        item.type === 'toolCall' && item.status === 'completed' && item.text.includes(endMarker),
    ),
  );
  report.checks.push(
    'three message sources, original run/session, native consumption ACKs, one result, formal MCP reply, normal tool completion, no inbox polling',
  );

  stage('stop with an unconsumed steer input and resume the same UUID');
  const stopReady = `CLAUDE_STOP_READY_${nonce}`;
  const pendingMarker = `CLAUDE_PENDING_${nonce}`;
  const stopCommand = process.platform === 'win32' ? 'Start-Sleep -Seconds 15' : 'sleep 15';
  say(
    reader.channelId,
    `Use Isles send_message to private with body exactly ${stopReady}, then run the shell command ${stopCommand}. Let it finish normally unless the host stops you.`,
  );
  await until(
    () =>
      official(reader, stopReady) &&
      current()
        .isles.store.agentDetail(reader.id)
        .runs.some(
          (run) =>
            !run.finishedAt &&
            run.items.some(
              (item) =>
                item.type === 'toolCall' &&
                item.status === 'running' &&
                item.text.includes(stopCommand),
            ),
        ),
    'running stop probe',
  );
  const pending = say(
    reader.channelId,
    `When continuing this task, send ${pendingMarker} through Isles MCP.`,
  );
  await until(
    () =>
      delivery(reader, pending).status === 'steering' &&
      report.frames.some(
        (frame) =>
          frame.agentId === reader.id &&
          frame.type === 'command_lifecycle' &&
          frame.state === 'queued' &&
          report.inputs.some(
            (input) => input.uuid === frame.input && input.text.includes(pendingMarker),
          ),
      ),
    'native queued steer input',
  );
  await current().isles.runtime.stop(reader.id);
  assert.equal(delivery(reader, pending).status, 'cancelled');
  assert.equal(current().isles.store.publicAgent(reader.id).status, 'stopped');
  await current().isles.runtime.resume(reader.id);
  await until(() => ready(reader.id), 'fixed-session resume');
  assert.equal(current().isles.store.publicAgent(reader.id).threadId, binding);
  const resumeMarker = `CLAUDE_STEER_RESUME_${nonce}`;
  say(reader.channelId, `Use Isles send_message to private with body exactly ${resumeMarker}.`);
  await until(
    () => ready(reader.id) && official(reader, resumeMarker),
    'official response after resume',
  );
  assert.equal(report.inputs.filter((input) => input.text.includes(pendingMarker)).length, 1);
  assert.equal(official(reader, pendingMarker), false);
  report.checks.push(
    'queued native input cancelled by stop, no automatic replay, owned process closed, same UUID resume',
  );

  stage('restart and persist both steer preference values');
  await app.close();
  app = await open();
  await until(() => ready(reader.id), 'restart with steer enabled');
  assert.equal(current().isles.store.publicAgent(reader.id).threadId, binding);
  assert.equal(current().isles.store.publicAgent(reader.id).steerEnabled, true);
  const launches = report.launches.length;
  await current().isles.runtime.updateAgent(reader.id, { steerEnabled: false });
  assert.equal(report.launches.length, launches);
  await app.close();
  app = await open();
  await until(() => ready(reader.id), 'restart with steer disabled');
  assert.equal(current().isles.store.publicAgent(reader.id).threadId, binding);
  assert.equal(current().isles.store.publicAgent(reader.id).steerEnabled, false);
  report.checks.push(
    'both preferences survive restart, preference-only edit preserves native process/session',
  );
  report.success = true;
  stage('Claude steer acceptance passed');
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await app?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      { success: report.success, root, report: join(root, 'report.json'), error: report.error },
      null,
      2,
    ),
  );
}
