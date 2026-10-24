import type { ConfigManager } from '@isles/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DshAdapter } from '../../apps/server/src/harness/dsh/adapter.js';
import type { DshClientFactory } from '../../apps/server/src/harness/dsh/client.js';
import { DshEnvironment } from '../../apps/server/src/harness/dsh/environment.js';
import type { AgentWorkspace } from '../../apps/server/src/runtime/workspace.js';
import type { Store } from '../../apps/server/src/storage/store.js';
import { DshFixture } from '../../apps/server/test/dsh-fixture.js';
import { parseMessageText } from '../../apps/server/test/helpers.js';

/** Browser-only native RPC simulation; REST, SSE, MCP and storage run normally. */
export function dshBrowserAdapter(
  workspace: AgentWorkspace,
  config: ConfigManager,
  store: () => Store,
) {
  const persisted = new Map<string, { sessionId: string; cwd: string }>();
  const turns = new Map<string, number>();
  const factory: DshClientFactory = (command, cwd, runtime, handlers, redactor, log) => {
    const native = new DshFixture();
    native.factory(command, cwd, runtime, handlers, redactor, log);
    for (const [id, session] of persisted) native.sessions.set(id, session);
    const timers = new Set<NodeJS.Timeout>();
    let sessionId = '';
    let turnId: string | undefined;
    let questionText = '';
    const complete = async (text: string, answer?: string) => {
      const patch = runtime.args[runtime.args.indexOf('--patch') + 1]!;
      const overlay = JSON.parse(await readFile(patch, 'utf8')) as {
        insert?: {
          id: string;
          config: { url: string; headers: { Authorization: string } };
        }[];
      }[];
      const mcp = overlay
        .flatMap((entry) => entry.insert ?? [])
        .find((entry) => entry.id === 'isles-mcp')!.config;
      const database = store();
      const agentId = new URL(mcp.url).pathname.split('/').at(-1)!;
      const envelope = parseMessageText(text, database.getAgent(agentId).channelId, agentId, {
        agents: database.listAgents(true),
        channels: database.listChannels(),
      });
      for (const channel of envelope.channels) {
        const message = channel.messages.filter((entry) => entry.sender.type === 'user').at(-1);
        if (!message || native.closed) continue;
        const response = await fetch(mcp.url, {
          method: 'POST',
          headers: {
            Authorization: mcp.headers.Authorization,
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
                body: answer ?? `DSH MCP 回复：${message.body}`,
                replyTo: message.seq,
                clientId: `dsh-${randomUUID()}`,
              },
            },
          }),
        });
        const rpc = (await response.json()) as { result?: { isError?: boolean } };
        if (!response.ok || !rpc.result || rpc.result.isError)
          throw new Error('Browser DSH MCP failed');
      }
      if (native.closed || !turnId) return;
      native.event(sessionId, {
        type: 'item',
        turnId,
        item: {
          id: `item_${randomUUID()}`,
          type: 'assistant_message',
          status: 'completed',
          text: 'DSH 原生执行详情',
        },
        append: false,
      });
      native.complete(sessionId, turnId);
      turnId = undefined;
    };
    const publish = (text: string, answer?: string) => {
      void complete(text, answer).catch((error: unknown) => native.loseConnection(error as Error));
    };
    const schedule = (work: () => void, delay: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        work();
      }, delay);
      timers.add(timer);
    };
    const cancelTimers = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
    native.onRequest = ({ method, params }) => {
      if (method === 'isles/session/create') {
        sessionId = params.sessionId as string;
        const session = { sessionId, cwd: params.cwd as string };
        persisted.set(sessionId, session);
        native.sessions.set(sessionId, session);
        return session;
      }
      if (method === 'isles/session/resume') sessionId = params.sessionId as string;
      if (method === 'isles/session/submit' || method === 'isles/session/steer') {
        const text = params.text as string;
        const messageId = params.messageId as string;
        schedule(
          () => {
            if (!turnId) {
              const turn = (turns.get(sessionId) ?? 0) + 1;
              turns.set(sessionId, turn);
              turnId = native.start(sessionId, String(turn));
            }
            native.accept(sessionId, messageId, turnId);
            if (text.includes('保持执行以验证 DSH steer')) return;
            if (text.includes('DSH 多选提问')) {
              questionText = text;
              native.notify('isles/question', {
                sessionId,
                turnId,
                requestId: `question_${randomUUID()}`,
                questions: [
                  {
                    id: 'scope',
                    header: '执行范围',
                    question: '选择需要处理的内容',
                    multiSelect: true,
                    isOther: false,
                    isSecret: false,
                    options: ['代码', '文档', '测试'].map((label) => ({ label, description: '' })),
                  },
                ],
              });
            } else publish(text);
          },
          method === 'isles/session/steer' ? 1_000 : 250,
        );
        return { sessionId, messageId };
      }
      if (method === 'isles/question/answer') {
        const answers = params.answers as { scope: { answers: string[] } };
        publish(questionText, `DSH 多选回答：${answers.scope.answers.join('、')}`);
        return {};
      }
      if (method === 'isles/session/interrupt') {
        cancelTimers();
        if (turnId) native.complete(sessionId, turnId, 'interrupted');
        turnId = undefined;
        return {};
      }
    };
    const close = native.close.bind(native);
    native.close = async () => {
      cancelTimers();
      await close();
    };
    return native;
  };
  return new DshAdapter(new DshEnvironment(config, workspace), factory);
}
