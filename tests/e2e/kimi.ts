import type { ConfigManager } from '@isles/config';
import { randomUUID } from 'node:crypto';
import { AcpAdapter } from '../../apps/server/src/acp/adapter.js';
import { AcpRpcError, type AcpClientFactory } from '../../apps/server/src/acp/client.js';
import { KimiEnvironment } from '../../apps/server/src/kimi/environment.js';
import type { AgentWorkspace } from '../../apps/server/src/runtime/workspace.js';
import type { Store } from '../../apps/server/src/storage/store.js';
import { parseMessageText, testCatalog } from '../../apps/server/test/helpers.js';

/** Browser-only ACP simulation. REST, SSE, database and MCP are real. */
export function kimiBrowserAdapter(
  workspace: AgentWorkspace,
  config: ConfigManager,
  store: () => Store,
) {
  const persisted = new Set<string>();
  const configOptions = [
    {
      type: 'select',
      id: 'model',
      category: 'model',
      currentValue: 'test-kimi-model',
      options: [{ value: 'test-kimi-model', name: '测试 Kimi 模型' }],
    },
    {
      type: 'select',
      id: 'thinking',
      category: 'thought_level',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
    {
      type: 'select',
      id: 'mode',
      category: 'mode',
      currentValue: 'yolo',
      options: [{ value: 'yolo', name: 'YOLO' }],
    },
  ];
  const factory: AcpClientFactory = (_command, _cwd, handlers) => {
    let closed = false;
    let mcp: { url: string; authorization: string } | undefined;
    let active: { finish(stopReason: string): void } | undefined;
    let question: { id: string; respond(result: unknown): void } | undefined;
    const open = (params: { mcpServers: { url: string; headers: { value: string }[] }[] }) => {
      const server = params.mcpServers[0]!;
      mcp = { url: server.url, authorization: server.headers[0]!.value };
      return { configOptions };
    };
    const reply = async (text: string, answer?: string) => {
      const database = store();
      const agentId = new URL(mcp!.url).pathname.split('/').at(-1)!;
      const envelope = parseMessageText(text, database.getAgent(agentId).channelId, agentId, {
        agents: database.listAgents(true),
        channels: database.listChannels(),
      });
      for (const channel of envelope.channels) {
        const latest = channel.messages.filter((message) => message.sender.type === 'user').at(-1);
        if (!latest || closed) continue;
        const response = await fetch(mcp!.url, {
          method: 'POST',
          headers: {
            Authorization: mcp!.authorization,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'send_message',
              arguments: {
                channelId: channel.channel_id,
                body: answer ?? `Kimi MCP 回复：${latest.body}`,
                replyTo: latest.seq,
                clientId: `kimi-${randomUUID()}`,
              },
            },
          }),
        });
        const rpc = (await response.json()) as { result?: { isError?: boolean } };
        if (!response.ok || !rpc.result || rpc.result.isError)
          throw new Error('Browser Kimi MCP failed');
      }
    };
    return {
      request: async (method, params) => {
        const value = params as Record<string, unknown> & {
          sessionId: string;
          mcpServers: { url: string; headers: { value: string }[] }[];
          prompt: { text: string }[];
        };
        if (method === 'initialize')
          return {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { resume: {} },
              mcpCapabilities: { http: true },
            },
          };
        if (method === 'session/new') {
          const sessionId = `session_${randomUUID()}`;
          persisted.add(sessionId);
          return { sessionId, ...open(value) };
        }
        if (method === 'session/resume') {
          if (!persisted.has(value.sessionId))
            throw new AcpRpcError('Unknown sessionId', -32602, null);
          return open(value);
        }
        if (method === 'session/set_config_option') return { configOptions };
        if (method !== 'session/prompt') throw new AcpRpcError('Method not found', -32601, null);
        const text = value.prompt.map((block) => block.text).join('');
        return new Promise((resolve, reject) => {
          const complete = (answer?: string) => {
            void reply(text, answer).then(() => {
              handlers.notification('session/update', {
                sessionId: value.sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Kimi 原生执行详情' },
                },
              });
              active?.finish('end_turn');
            }, reject);
          };
          const timer = setTimeout(
            () => {
              if (text.includes('Kimi 多选提问')) {
                const id = `question-${randomUUID()}`;
                question = {
                  id,
                  respond: (result) => {
                    const response = result as { action: string; content?: { scope: string[] } };
                    if (response.action === 'accept')
                      complete(`Kimi 多选回答：${response.content!.scope.join('、')}`);
                    else active?.finish('cancelled');
                  },
                };
                handlers.request(id, 'elicitation/create', {
                  sessionId: value.sessionId,
                  mode: 'form',
                  message: '选择需要处理的内容',
                  requestedSchema: {
                    properties: {
                      scope: {
                        type: 'array',
                        title: '执行范围',
                        items: {
                          anyOf: ['代码', '文档', '测试'].map((label) => ({ const: label })),
                        },
                      },
                    },
                  },
                });
              } else complete();
            },
            text.includes('保持执行以验证 Kimi 排队') ? 1_500 : 250,
          );
          active = {
            finish: (stopReason) => {
              clearTimeout(timer);
              question = undefined;
              active = undefined;
              resolve({ stopReason });
            },
          };
        });
      },
      notify: (method) => {
        if (method === 'session/cancel') active?.finish('cancelled');
      },
      respond: (id, result) => {
        if (question?.id === id) question.respond(result);
      },
      reject: () => {},
      close: async () => {
        closed = true;
        active?.finish('cancelled');
      },
    };
  };
  return new AcpAdapter(
    new KimiEnvironment(config, workspace),
    {
      ...testCatalog,
      status: async () => ({
        available: true,
        authenticated: true,
        version: '2.1.1',
        binaryPath: config.current.cli.kimi.binaryPath,
        error: null,
      }),
      models: async () => [
        {
          id: 'test-kimi-model',
          model: 'test-kimi-model',
          displayName: '测试 Kimi 模型',
          description: 'Browser ACP simulation',
          supportedReasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'high',
          isDefault: true,
        },
      ],
    },
    factory,
  );
}
