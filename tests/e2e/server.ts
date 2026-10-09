// Browser tests use a simulated native adapter and real REST/SSE/MCP/storage.
// This executable is test-only and is never selected by the production server.
import { ConfigManager } from '@isles/config';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildApp } from '../../apps/server/src/app.js';
import type { Store } from '../../apps/server/src/storage/store.js';
import { claudeFixture } from '../../apps/server/test/claude-fixture.js';
import { kimiFixture } from '../../apps/server/test/acp-fixture.js';
import { claudeBrowserAdapter } from './claude.js';
import { kimiBrowserAdapter } from './kimi.js';
import { opencodeBrowserAdapter } from './opencode.js';
import { dshBrowserAdapter } from './dsh.js';
import { opencodeConfig } from '../../apps/server/test/opencode-fixture.js';
import { dshConfig } from '../../apps/server/test/dsh-fixture.js';
import { agentRoot } from '../../apps/server/src/runtime/workspace.js';
import {
  MockHarness,
  codexAdapters,
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
  environment: {
    ISLES_SERVER_PORT: process.env.ISLES_SERVER_PORT ?? '54310',
    ISLES_DSH_HOME: join(root, 'native-home'),
  },
});
const { dataDir } = config.current;
const claude = await claudeFixture(root);
await config.configureCliBinary('claude', claude.binary);
const kimi = await kimiFixture(root);
await config.configureCliBinary('kimi', kimi.binary);
const opencode = await opencodeConfig(root);
await config.configureCliBinary('opencode', opencode.binary);
const dsh = await dshConfig(root);
await config.configureCliBinary('dsh', dsh.binary);
const harness = new MockHarness();
const tokens = new Map<string, string>();
const factory = harness.factory;
harness.factory = async (agent, handlers, baseUrl, connecting) => {
  const token = tokens.get(agent.id) ?? randomBytes(32).toString('hex');
  tokens.set(agent.id, token);
  await mkdir(agentRoot(dataDir, agent), { recursive: true });
  await writeFile(join(agentRoot(dataDir, agent), 'isles-mcp-token'), token, { mode: 0o600 });
  return factory(agent, handlers, baseUrl, connecting);
};
const app = await buildApp({
  config,
  adapterFactory: (workspace, configuration) => [
    ...codexAdapters(
      {
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
      harness.factory,
    )(workspace, configuration),
    claudeBrowserAdapter(workspace, configuration, () => browserStore),
    kimiBrowserAdapter(workspace, configuration, () => browserStore),
    opencodeBrowserAdapter(workspace, configuration, () => browserStore),
    dshBrowserAdapter(workspace, configuration, () => browserStore),
  ],
});
const browserStore: Store = app.isles.store;
harness.useStore(app.isles.store);

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
      ? parseMessageText(
          rpc.result.content[0]!.text,
          client.agent.channelId,
          client.agent.id,
          harness.directory(),
        )
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
  if (targets.some((t) => t.message.body === '保持执行以验证 steer')) return;
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
harness.onSteer = async (client) => {
  const { envelope } = harness.steers.at(-1)!;
  // Keep the RPC pending long enough to observe the delivery state through SSE.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  if (client.closed) return;
  for (const channel of envelope.channels) {
    const message = channel.messages.filter((item) => item.sender.type === 'user').at(-1);
    if (message)
      await callMcp(client, 'send_message', {
        channelId: channel.channel_id,
        body: `MCP steer 回复：${message.body}`,
        replyTo: message.seq,
        clientId: `steer-reply-${message.seq}`,
      });
  }
  client.complete();
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
