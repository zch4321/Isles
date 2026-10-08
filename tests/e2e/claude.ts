import type { ConfigManager } from '@isles/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  ClaudeAdapter,
  CLAUDE_INITIALIZATION_MESSAGE,
  type ClaudeClientFactory,
} from '../../apps/server/src/claude/adapter.js';
import { ClaudeEnvironment } from '../../apps/server/src/claude/environment.js';
import { ClaudeInputRejected } from '../../apps/server/src/claude/client.js';
import type { AgentWorkspace } from '../../apps/server/src/runtime/workspace.js';
import type { Store } from '../../apps/server/src/storage/store.js';
import { parseMessageText, testCatalog } from '../../apps/server/test/helpers.js';

/** Browser-only CLI wire simulation. REST, SSE, database and MCP are real. */
export function claudeBrowserAdapter(
  workspace: AgentWorkspace,
  config: ConfigManager,
  store: () => Store,
) {
  const persisted = new Set<string>();
  const factory: ClaudeClientFactory = (_command, args, cwd, env, handlers) => {
    const sessionId = args.find((arg) => /^--(?:resume|session-id)=/.test(arg))!.split('=')[1]!;
    const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]!) as {
      mcpServers: { isles: { url: string } };
    };
    const url = mcp.mcpServers.isles.url;
    const agentId = new URL(url).pathname.split('/').at(-1)!;
    let closed = false;
    let activeId: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let envelopes: ReturnType<typeof parseMessageText>[] = [];
    let consumed: string[] = [];
    const queued = new Set<string>();
    const finish = (messageId: string, interrupted = false) => {
      if (closed || activeId !== messageId) return;
      activeId = undefined;
      handlers.event({
        type: 'assistant',
        session_id: sessionId,
        user_message_uuid: messageId,
        user_message_uuids: consumed,
        parent_tool_use_id: null,
        message: { id: randomUUID(), content: [{ type: 'text', text: 'Claude 原生执行详情' }] },
      });
      handlers.event({
        type: 'result',
        subtype: 'success',
        session_id: sessionId,
        user_message_uuid: messageId,
        user_message_uuids: consumed,
        is_error: interrupted,
      });
    };
    return {
      control: async (subtype) => {
        if (subtype === 'initialize') {
          if (args.some((arg) => arg.startsWith('--resume=')) && !persisted.has(sessionId))
            throw new Error('Missing browser fixture session');
          return {};
        }
        if (subtype === 'get_context_usage')
          return {
            memoryFiles: ['AGENTS.md', 'CLAUDE.md'].map((name) => ({ path: join(cwd, name) })),
          };
        if (subtype === 'mcp_status')
          return { mcpServers: [{ name: 'isles', status: 'connected' }] };
        if (subtype === 'interrupt') {
          for (const id of queued)
            handlers.event({
              type: 'command_lifecycle',
              state: 'cancelled',
              command_uuid: id,
              session_id: sessionId,
            });
          queued.clear();
        }
        if (subtype === 'interrupt' && activeId) {
          if (timer) clearTimeout(timer);
          finish(activeId, true);
        }
        return {};
      },
      sendUser: async (_sessionId, messageId, text) => {
        const database = store();
        const agent = database.getAgent(agentId);
        const parse = () =>
          parseMessageText(text, agent.channelId, agentId, {
            agents: database.listAgents(true),
            channels: database.listChannels(),
          });
        if (activeId) {
          queued.add(messageId);
          handlers.event({
            type: 'command_lifecycle',
            state: 'queued',
            command_uuid: messageId,
            session_id: sessionId,
          });
          await new Promise((resolve) => setTimeout(resolve, 450));
          if (closed) throw new Error('Browser Claude connection closed');
          if (!queued.delete(messageId))
            throw new ClaudeInputRejected('Browser Claude input withdrawn');
          if (activeId) {
            envelopes.push(parse());
            consumed.push(messageId);
            handlers.event({
              type: 'command_lifecycle',
              state: 'started',
              command_uuid: messageId,
              session_id: sessionId,
            });
            return;
          }
          // The previous turn already ended; like the CLI, run the queued input as the next turn.
        }
        activeId = messageId;
        consumed = [messageId];
        handlers.event({
          type: 'command_lifecycle',
          state: 'started',
          command_uuid: messageId,
          session_id: sessionId,
        });
        if (text === CLAUDE_INITIALIZATION_MESSAGE) {
          persisted.add(sessionId);
          timer = setTimeout(() => finish(messageId), 10);
          return;
        }
        envelopes = [parse()];
        timer = setTimeout(
          () => {
            void (async () => {
              try {
                const channels = new Map<
                  string,
                  ReturnType<typeof parseMessageText>['channels'][number]
                >();
                for (const envelope of envelopes)
                  for (const channel of envelope.channels) {
                    const previous = channels.get(channel.channel_id);
                    channels.set(channel.channel_id, {
                      ...channel,
                      messages: [...(previous?.messages ?? []), ...channel.messages],
                    });
                  }
                for (const channel of channels.values()) {
                  const latest = channel.messages
                    .filter((message) => message.sender.type === 'user')
                    .at(-1);
                  if (!latest || closed) continue;
                  const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${env.ISLES_MCP_TOKEN}`,
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
                          body: `Claude MCP 回复：${latest.body}`,
                          replyTo: latest.seq,
                          clientId: `claude-${messageId}-${channel.channel_id}`,
                        },
                      },
                    }),
                  });
                  const rpc = (await response.json()) as { result?: { isError?: boolean } };
                  if (!response.ok || !rpc.result || rpc.result.isError)
                    throw new Error('Browser Claude MCP failed');
                }
                finish(messageId);
              } catch (error) {
                if (!closed)
                  handlers.exit(
                    error instanceof Error ? error : new Error('Browser Claude failed'),
                  );
              }
            })();
          },
          text.includes('保持执行以验证 Claude steer') ? 2_000 : 250,
        );
      },
      respond: () => {},
      reject: () => {},
      close: async () => {
        closed = true;
        if (timer) clearTimeout(timer);
      },
    };
  };
  return new ClaudeAdapter(
    new ClaudeEnvironment(config, workspace),
    {
      ...testCatalog,
      status: async () => ({
        available: true,
        authenticated: true,
        version: 'mock-claude',
        binaryPath: config.current.cli.claude.binaryPath,
        error: null,
      }),
      models: async () => [
        {
          id: 'test-claude-model',
          model: 'test-claude-model',
          displayName: '测试 Claude 模型',
          description: 'Browser CLI simulation',
          supportedReasoningEfforts: ['default', 'high'],
          defaultReasoningEffort: 'default',
          isDefault: true,
        },
      ],
    },
    factory,
  );
}
