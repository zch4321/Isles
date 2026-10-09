import type { ConfigManager } from '@isles/config';
import { randomUUID } from 'node:crypto';
import { OpenCodeAdapter } from '../../apps/server/src/harness/opencode/adapter.js';
import { OpenCodeEnvironment } from '../../apps/server/src/harness/opencode/environment.js';
import type { AgentWorkspace } from '../../apps/server/src/runtime/workspace.js';
import type { Store } from '../../apps/server/src/storage/store.js';
import { parseMessageText } from '../../apps/server/test/helpers.js';
import { inboxReceipt, OpenCodeFixture } from '../../apps/server/test/opencode-fixture.js';

/** Browser-only native HTTP simulation; REST, SSE, MCP and storage run normally. */
export function opencodeBrowserAdapter(
  workspace: AgentWorkspace,
  config: ConfigManager,
  store: () => Store,
) {
  const persisted = new Map<string, Record<string, unknown>>();
  return new OpenCodeAdapter(new OpenCodeEnvironment(config, workspace), (_command, _cwd, env) => {
    const native = new OpenCodeFixture();
    for (const [id, session] of persisted) native.sessions.set(id, session);
    const timers = new Set<NodeJS.Timeout>();
    let active = false;
    let sessionID = '';
    let questionText = '';
    const mcp = env.OPENCODE_CONFIG_CONTENT
      ? (
          JSON.parse(env.OPENCODE_CONFIG_CONTENT) as {
            mcp: { servers: { isles: { url: string; headers: { Authorization: string } } } };
          }
        ).mcp.servers.isles
      : undefined;
    const complete = async (text: string, answer?: string) => {
      const database = store();
      const agentID = new URL(mcp!.url).pathname.split('/').at(-1)!;
      const envelope = parseMessageText(text, database.getAgent(agentID).channelId, agentID, {
        agents: database.listAgents(true),
        channels: database.listChannels(),
      });
      for (const channel of envelope.channels) {
        const message = channel.messages.filter((entry) => entry.sender.type === 'user').at(-1);
        if (!message || native.closed) continue;
        const response = await fetch(mcp!.url, {
          method: 'POST',
          headers: {
            Authorization: mcp!.headers.Authorization,
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
                body: answer ?? `OpenCode MCP 回复：${message.body}`,
                replyTo: message.seq,
                clientId: `opencode-${randomUUID()}`,
              },
            },
          }),
        });
        const rpc = (await response.json()) as { result?: { isError?: boolean } };
        if (!response.ok || !rpc.result || rpc.result.isError)
          throw new Error('Browser OpenCode MCP failed');
      }
      if (native.closed) return;
      native.emit(
        native.frame(sessionID, 'session.text.ended', {
          assistantMessageID: `msg_${randomUUID()}`,
          ordinal: 0,
          text: 'OpenCode 原生执行详情',
        }),
      );
      native.emit(native.frame(sessionID, 'session.execution.succeeded'));
      active = false;
    };
    const schedule = (work: () => void, delay: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        work();
      }, delay);
      timers.add(timer);
    };
    native.onRequest = ({ method, path, body }) => {
      const route = path.split('?')[0];
      if (route === '/api/session' && method === 'POST') {
        const info: Record<string, unknown> = {
          ...(body as Record<string, unknown>),
          time: { created: Date.now(), updated: Date.now() },
        };
        sessionID = info.id as string;
        persisted.set(sessionID, info);
        native.sessions.set(sessionID, info);
        return { data: info };
      }
      if (method === 'GET' && route?.startsWith('/api/session/') && route.split('/').length === 4)
        sessionID = route.split('/')[3]!;
      if (route?.endsWith('/prompt')) {
        const input = body as { id: string; text: string };
        const receipt = inboxReceipt(sessionID, input.text, input.id);
        const wasActive = active;
        if (!active) {
          native.execution(sessionID);
          active = true;
        }
        schedule(
          () => {
            native.deliver(sessionID, input.id);
            if (input.text.includes('保持执行以验证 OpenCode steer')) return;
            if (input.text.includes('OpenCode 多选提问')) {
              questionText = input.text;
              native.emit(
                native.frame(sessionID, 'form.created', {
                  form: {
                    id: 'frm_browser',
                    sessionID,
                    title: '执行范围',
                    fields: [
                      {
                        key: 'scope',
                        type: 'multiselect',
                        title: '选择需要处理的内容',
                        options: [
                          { value: 'code', label: '代码' },
                          { value: 'docs', label: '文档' },
                          { value: 'tests', label: '测试' },
                        ],
                      },
                    ],
                  },
                }),
              );
            } else
              void complete(input.text).catch((error: unknown) =>
                native.loseEvents(error as Error),
              );
          },
          wasActive ? 450 : 250,
        );
        return receipt;
      }
      if (route?.endsWith('/form/frm_browser/reply')) {
        const answer = (body as { answer: { scope: string[] } }).answer.scope;
        const labels: Record<string, string> = { code: '代码', docs: '文档', tests: '测试' };
        void complete(
          questionText,
          `OpenCode 多选回答：${answer.map((value) => labels[value]).join('、')}`,
        ).catch((error: unknown) => native.loseEvents(error as Error));
        return {};
      }
      if (route?.includes('/inbox/') && method === 'DELETE') {
        native.emit(
          native.frame(sessionID, 'session.inbox.cancelled', { inboxID: route.split('/').at(-1)! }),
        );
        return {};
      }
      if (route?.endsWith('/interrupt')) {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        if (active) native.emit(native.frame(sessionID, 'session.execution.interrupted'));
        active = false;
        return {};
      }
    };
    const close = native.close.bind(native);
    native.close = async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await close();
    };
    return native;
  });
}
