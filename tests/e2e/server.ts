// Browser tests use a simulated native adapter and real REST/SSE/MCP/storage.
// This executable is test-only and is never selected by the production server.
import { ConfigManager } from '@isles/config';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildApp } from '../../apps/server/src/app.js';
import { agentRoot } from '../../apps/server/src/codex/environment.js';
import {
  MockHarness,
  parseMessageText,
  testCatalog,
  type MockClient,
  type Envelope,
} from '../../apps/server/test/helpers.js';

const root = process.env.ISLES_CONFIG_FILE
  ? dirname(resolve(process.env.ISLES_CONFIG_FILE))
  : await mkdtemp(join(tmpdir(), 'isles-e2e-'));
if (!root.startsWith(join(tmpdir(), 'isles-')))
  throw new Error('Browser tests require a temporary config directory');
const config = new ConfigManager({
  configFilePath: join(root, 'config.toml'),
  homeDir: root,
  environment: { ISLES_SERVER_PORT: process.env.ISLES_SERVER_PORT ?? '54310' },
});
const { dataDir } = config.current;
const harness = new MockHarness();
const tokens = new Map<string, string>();
const factory = harness.factory;
harness.factory = async (agent, handlers, baseUrl) => {
  const token = tokens.get(agent.id) ?? randomBytes(32).toString('hex');
  tokens.set(agent.id, token);
  await mkdir(agentRoot(dataDir, agent), { recursive: true });
  await writeFile(join(agentRoot(dataDir, agent), 'isles-mcp-token'), token, { mode: 0o600 });
  return factory(agent, handlers, baseUrl);
};
const app = await buildApp({
  config,
  catalog: {
    ...testCatalog,
    models: async () => [
      ...(await testCatalog.models()),
      {
        id: 'test-model-2',
        model: 'test-model-2',
        displayName: '测试模型 2',
        description: '模拟模型，仅用于编辑验证',
        supportedReasoningEfforts: ['high', 'max'],
        defaultReasoningEffort: 'high',
        isDefault: false,
      },
    ],
  },
  clientFactory: harness.factory,
});

async function callMcp<T>(client: MockClient, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${client.baseUrl}/mcp/${client.agent.id}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.get(client.agent.id)}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  if (!response.ok) throw new Error('Test MCP request failed');
  const rpc = (await response.json()) as {
    result?: { isError?: boolean; content: { text: string }[] };
  };
  if (!rpc.result || rpc.result.isError) throw new Error('Test MCP tool failed');
  return (
    name === 'receive_messages'
      ? parseMessageText(rpc.result.content[0]!.text, client.agent.channelId, client.agent.id)
      : JSON.parse(rpc.result.content[0]!.text)
  ) as T;
}

// Replies once per channel to the latest user message; other Agents' messages get no reply,
// so a group discussion settles after one round.
harness.onTurn = (client) => {
  const { envelope } = harness.inputs.at(-1)!;
  const targets = envelope.channels.flatMap((channel) => {
    const latest = channel.messages.filter((m) => m.sender.type === 'user').at(-1);
    return latest ? [{ channelId: channel.channel_id, message: latest }] : [];
  });
  const receiveDuringTurn = targets.some((t) => t.message.body === '请在执行中收信');
  const publish = async () => {
    if (receiveDuringTurn) {
      const inbox = await callMcp<Envelope>(client, 'receive_messages', {});
      for (const channel of inbox.channels) {
        const message = channel.messages.filter((m) => m.sender.type === 'user').at(-1);
        if (message) targets.push({ channelId: channel.channel_id, message });
      }
    }
    for (const { channelId, message } of targets) {
      if (client.closed) return;
      await callMcp(client, 'send_message', {
        channelId,
        body: `MCP 回复：${message.body}`,
        replyTo: message.seq,
        clientId: `reply-${message.seq}`,
      });
    }
    client.complete();
  };
  if (receiveDuringTurn || targets.some((t) => t.message.body === '请向我提问')) {
    setTimeout(() => client.question(), 30);
    const respond = client.respond.bind(client);
    client.respond = (id, result) => {
      respond(id, result);
      void publish();
    };
  } else
    setTimeout(() => {
      void publish();
    }, 250);
};
await app.listen({ host: config.current.host, port: config.current.port });
const close = async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
};
process.once('SIGTERM', () => {
  void close();
});
process.once('SIGINT', () => {
  void close();
});
