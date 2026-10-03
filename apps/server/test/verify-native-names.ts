// Opt-in: pnpm --filter @isles/server exec tsx test/verify-native-names.ts
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigManager } from '@isles/config';
import type { Agent } from '@isles/contracts';
import { buildApp } from '../src/app.js';
import { StdioClient } from '../src/codex/client.js';
import { agentRoot } from '../src/codex/environment.js';
import { threadResponseSchema } from '../src/codex/protocol.js';

const root = await mkdtemp(join(tmpdir(), 'isles-native-names-'));
const configFilePath = join(root, 'config.toml');
const environment: NodeJS.ProcessEnv = {};
for (const key of ['CODEX_HOME', 'ISLES_CODEX_HOME'])
  if (process.env[key]) environment[key] = process.env[key];
const report = {
  success: false,
  root,
  startedAt: new Date().toISOString(),
  finishedAt: '',
  version: null as string | null,
  agents: [] as { id: string; threadId: string | null }[],
  groups: [] as { id: string; name: string | null }[],
  inputs: [] as { agentId: string; text: string }[],
  sources: [] as { agentId: string; method: string; paths: string[] }[],
  tools: [] as { agentId: string; name: string; arguments: Record<string, unknown> }[],
  history: '',
  inbox: '',
  checks: [] as string[],
  error: null as string | null,
};
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
const current = () => {
  assert.ok(app);
  return app;
};
const progress = (stage: string) => console.log(JSON.stringify({ stage, root }));
async function open() {
  const instance = await buildApp({
    config: new ConfigManager({ configFilePath, environment }),
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
        if (method === 'turn/start')
          report.inputs.push({
            agentId: agent.id,
            text: (params.input as { text: string }[])[0]!.text,
          });
        const result = await request<T>(method, params);
        if (method === 'thread/start' || method === 'thread/resume')
          report.sources.push({
            agentId: agent.id,
            method,
            paths: threadResponseSchema.parse(result).instructionSources,
          });
        return result;
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
  instance.addHook('preHandler', async (request) => {
    if (!request.url.startsWith('/mcp/')) return;
    const rpc = request.body as
      | { method?: string; params?: { name: string; arguments?: Record<string, unknown> } }
      | undefined;
    if (rpc?.method === 'tools/call' && rpc.params)
      report.tools.push({
        agentId: request.url.slice('/mcp/'.length),
        name: rpc.params.name,
        arguments: rpc.params.arguments ?? {},
      });
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
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    for (const agent of current().isles.store.listAgents())
      if (agent.status === 'error') throw new Error(agent.error ?? 'Native Agent failed');
    if (predicate()) return;
    await sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
}
async function tool(agent: Agent, name: string, args: Record<string, unknown> = {}) {
  const native = current().isles.runtime.environment;
  const token = (
    await readFile(join(agentRoot(native.dataDir, agent), 'isles-mcp-token'), 'utf8')
  ).trim();
  const address = current().server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp/${agent.id}`, {
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
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200);
  const rpc = (await response.json()) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  assert.ok(!rpc.result.isError, JSON.stringify(rpc.result));
  return rpc.result.content[0]!.text;
}
async function configHash() {
  try {
    return createHash('sha256')
      .update(await readFile(join(current().isles.runtime.environment.home, 'config.toml')))
      .digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
try {
  app = await open();
  const before = await configHash();
  const status = await app.isles.runtime.catalog.status();
  assert.ok(status.available && status.authenticated, status.error ?? 'Codex is unavailable');
  report.version = status.version;
  const models = await app.isles.runtime.catalog.models();
  const model =
    models.find((value) => value.model === 'gpt-6.1-sol') ??
    models.find((value) => value.isDefault);
  assert.ok(model && model.supportedReasoningEfforts.includes('high'));
  const name = '同名审查员, [Alpha] | "v1"';
  const create = () =>
    app!.isles.runtime.createAgent({ name, model: model.model, reasoningEffort: 'high' });
  const reader = await create();
  const peer = await create();
  await until(
    () =>
      [reader, peer].every((agent) => app!.isles.store.publicAgent(agent.id).status === 'ready'),
    'native guidance loaded',
  );
  for (const agent of [reader, peer]) {
    report.agents.push({ id: agent.id, threadId: app.isles.store.publicAgent(agent.id).threadId });
    const rules = await readFile(join(agent.workspace, 'AGENTS.md'), 'utf8');
    assert.ok(rules.includes('Private channel with the human: private'));
    assert.ok(
      !rules.includes('Agent ID:') &&
        !rules.includes('Private channel with the human: ' + agent.channelId),
    );
  }
  const groupName = '同名评审群, [Beta] | "v1"';
  const group = app.isles.runtime.createGroup('user', {
    name: groupName,
    memberIds: [reader.id, peer.id],
  });
  const other = app.isles.runtime.createGroup('user', {
    name: groupName,
    memberIds: [reader.id, peer.id],
  });
  report.groups.push({ id: group.id, name: group.name }, { id: other.id, name: other.name });
  for (const channel of [group, other])
    app.isles.runtime.updateChannel(channel.id, { paused: true });
  const seed = app.isles.runtime.publish(peer.id, group.id, {
    body: 'Peer evidence for name lookup.',
    clientId: randomUUID(),
  });
  await app.isles.runtime.stop(peer.id);
  const marker = randomUUID().slice(0, 8);
  const reply = `NAME_REPLY_${marker}`;
  const ack = `NAME_ACK_${marker}`;
  const groupPrefix = group.id.slice(0, 8);
  const peerPrefix = peer.id.slice(0, 8);
  progress('native Agent resolves duplicate names through directories');
  app.isles.runtime.send(group.id, {
    body: `Acceptance check: reread your workspace AGENTS.md. The two groups and two Agents have duplicate names. This group's short suffix is #${groupPrefix}; the peer author's short suffix is #${peerPrefix}. Use list_channels and list_agents to obtain full IDs; use read_messages on this group to locate the peer evidence message. Send an official reply to that peer message in this exact group with body exactly ${reply}, replyTo its sequence, and mentions containing the peer's full Agent ID. Then send_message to private with body exactly ${ack}. End your turn. Do not publish in the other group.`,
    clientId: randomUUID(),
  });
  app.isles.runtime.updateChannel(group.id, { paused: false });
  await until(
    () =>
      app!.isles.store
        .listMessages(reader.channelId)
        .some((message) => message.sender === 'agent' && message.body === ack) &&
      app!.isles.store.publicAgent(reader.id).status === 'ready',
    'native name lookup and reply',
  );
  const response = app.isles.store
    .listMessages(group.id)
    .find((message) => message.body === reply)!;
  assert.ok(response);
  assert.equal(response.senderId, reader.id);
  assert.equal(response.replyTo, seed.seq);
  assert.deepEqual(response.mentions, [peer.id]);
  assert.equal(
    app.isles.store.listMessages(other.id).filter((message) => message.sender === 'agent').length,
    0,
  );
  const input = report.inputs.find((value) => value.agentId === reader.id)!.text;
  assert.ok(input.includes(`channel: ${JSON.stringify(groupName)}#${groupPrefix}`));
  assert.ok(input.includes(`from: agent:${JSON.stringify(name)}#${peerPrefix}`));
  assert.ok(!input.includes(group.id) && !input.includes(peer.id));
  for (const name of ['list_channels', 'list_agents', 'read_messages'])
    assert.ok(report.tools.some((call) => call.agentId === reader.id && call.name === name));
  assert.ok(
    report.tools.some(
      (call) =>
        call.agentId === reader.id &&
        call.name === 'send_message' &&
        call.arguments.channelId === group.id,
    ),
  );
  report.checks.push(
    'real native turn reads escaped duplicate names, queries directories and replies/mentions by full ID in the correct group',
  );
  report.history = await tool(reader, 'read_messages', { channelId: group.id, limit: 100 });
  assert.ok(report.history.includes(`from: agent:${JSON.stringify(name)}#${peerPrefix}`));
  app.isles.runtime.send(other.id, {
    body: 'Queued inbox label verification.',
    clientId: randomUUID(),
  });
  report.inbox = await tool(reader, 'receive_messages', { channelId: other.id, limit: 100 });
  assert.ok(report.inbox.includes(`channel: ${JSON.stringify(groupName)}#${other.id.slice(0, 8)}`));
  const contacts = JSON.parse(await tool(reader, 'list_agents')).agents as {
    id: string;
    name: string;
  }[];
  assert.ok(contacts.some((agent) => agent.id === peer.id && agent.name === name));
  const channels = JSON.parse(await tool(reader, 'list_channels')).channels as {
    channel_id: string;
    name: string;
  }[];
  assert.ok(
    channels.some((channel) => channel.channel_id === group.id && channel.name === groupName),
  );
  report.checks.push(
    'history and paused inbox use names while directory responses preserve full IDs',
  );
  const threadId = app.isles.store.publicAgent(reader.id).threadId;
  await app.close();
  app = undefined;
  progress('same native thread restores with the new guidance');
  app = await open();
  await until(() => app!.isles.store.publicAgent(reader.id).status === 'ready', 'reader restored');
  assert.equal(app.isles.store.publicAgent(reader.id).threadId, threadId);
  assert.equal(app.isles.store.publicAgent(peer.id).status, 'stopped');
  assert.equal(
    await tool(reader, 'read_messages', { channelId: group.id, limit: 100 }),
    report.history,
  );
  assert.equal(await configHash(), before);
  report.checks.push(
    'same-thread restart preserves readable name history, stopped peer and unchanged shared Codex configuration',
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
