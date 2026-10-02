// Browser tests use a simulated native adapter and real REST/SSE/MCP/storage.
// This executable is test-only and is never selected by the production server.
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/server/src/app.js';
import { agentRoot } from '../../apps/server/src/codex/environment.js';
import {
  MockHarness,
  testCatalog,
  type MockClient,
  type Envelope,
} from '../../apps/server/test/helpers.js';

const dataDir = await mkdtemp(join(tmpdir(), 'isles-e2e-'));
const harness = new MockHarness();
const tokens = new Map<string, string>();
const factory = harness.factory;
harness.factory = async (agent, handlers, baseUrl) => {
  const token = tokens.get(agent.id) ?? randomBytes(32).toString('hex');
  tokens.set(agent.id, token);
  await mkdir(agentRoot(agent), { recursive: true });
  await writeFile(join(agentRoot(agent), 'isles-mcp-token'), token, { mode: 0o600 });
  return factory(agent, handlers, baseUrl);
};
const app = await buildApp({
  dataDir,
  catalog: testCatalog,
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
  return JSON.parse(rpc.result.content[0]!.text) as T;
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
        replyTo: message.message_id,
        clientId: `reply-${message.message_id}`,
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
await app.listen({ host: '127.0.0.1', port: Number(process.env.ISLES_SERVER_PORT ?? 54310) });
const close = async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
};
process.once('SIGTERM', () => {
  void close();
});
process.once('SIGINT', () => {
  void close();
});
