import type { ConfigManager } from '@isles/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KimiWebAdapter } from '../../apps/server/src/harness/kimi/web-adapter.js';
import {
  KimiWebError,
  type KimiWebClientFactory,
} from '../../apps/server/src/harness/kimi/web-client.js';
import { KimiWebEnvironment } from '../../apps/server/src/harness/kimi/web-environment.js';
import type { AgentWorkspace } from '../../apps/server/src/runtime/workspace.js';
import type { Store } from '../../apps/server/src/storage/store.js';
import { parseMessageText, testCatalog } from '../../apps/server/test/helpers.js';

interface BrowserPrompt {
  prompt_id: string;
  status: 'running' | 'queued';
  content: { type: 'text'; text: string }[];
}
interface BrowserSession {
  id: string;
  workspace_id: string;
  metadata: { cwd: string };
  seq: number;
  epoch: string;
  turn: number;
  active: BrowserPrompt | null;
  queued: BrowserPrompt[];
}

/** Browser-only Kimi web simulation. REST, SSE, database and Isles MCP remain real. */
export function kimiBrowserAdapter(
  workspace: AgentWorkspace,
  config: ConfigManager,
  store: () => Store,
) {
  const persisted = new Map<string, BrowserSession>();
  const factory: KimiWebClientFactory = (_command, cwd, env, handlers) => {
    let closed = false;
    let subscribed = false;
    let session: BrowserSession | undefined;
    let mcp: { url: string };
    let pendingQuestion: { id: string; text: string; child: boolean } | undefined;
    const timers = new Set<NodeJS.Timeout>();
    const emit = (type: string, fields: Record<string, unknown> = {}) => {
      const current = session!;
      current.seq++;
      if (!closed && subscribed)
        handlers.event({
          type,
          session_id: current.id,
          seq: current.seq,
          epoch: current.epoch,
          timestamp: new Date().toISOString(),
          payload: {
            type,
            sessionId: current.id,
            agentId: 'main',
            turnId: current.turn,
            ...fields,
          },
        });
    };
    const schedule = (work: () => Promise<void> | void, delay: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!closed)
          void Promise.resolve(work()).catch((error: unknown) => handlers.exit(error as Error));
      }, delay);
      timers.add(timer);
    };
    const finish = (reason = 'completed') => {
      const prompt = session?.active;
      if (!prompt) return;
      session!.active = null;
      pendingQuestion = undefined;
      emit('turn.ended', { reason });
      emit('prompt.completed', { promptId: prompt.prompt_id, reason });
    };
    const reply = async (text: string, answer?: string) => {
      const database = store();
      const agentId = new URL(mcp.url).pathname.split('/').at(-1)!;
      const envelope = parseMessageText(text, database.getAgent(agentId).channelId, agentId, {
        agents: database.listAgents(true),
        channels: database.listChannels(),
      });
      for (const channel of envelope.channels) {
        const latest = channel.messages.filter((message) => message.sender.type === 'user').at(-1);
        if (!latest || closed) continue;
        const response = await fetch(mcp.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.ISLES_KIMI_MCP_TOKEN}`,
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
    const complete = async (text: string, answer?: string) => {
      await reply(text, answer);
      if (closed) return;
      emit('assistant.delta', { delta: 'Kimi 原生执行详情' });
      finish();
    };
    const ask = (text: string, child: boolean) => {
      const id = `question-${randomUUID()}`;
      pendingQuestion = { id, text, child };
      emit('event.question.requested', {
        agentId: child ? 'agent-browser' : 'main',
        agent_id: child ? 'agent-browser' : 'main',
        turnId: child ? 41 : session!.turn,
        turn_id: child ? 41 : session!.turn,
        question_id: id,
        questions: [
          {
            id: 'scope',
            header: '执行范围',
            question: '选择需要处理的内容',
            multi_select: true,
            allow_other: false,
            options: ['代码', '文档', '测试'].map((label, index) => ({ id: String(index), label })),
          },
        ],
      });
    };
    const output = async (text: string) => {
      if (text.includes('保持执行以验证 Kimi steer')) return;
      if (text.includes('Kimi 子代理提问')) {
        emit('subagent.spawned', {
          subagentId: 'agent-browser',
          subagentName: '页面助手',
          parentAgentId: 'main',
          model: 'test-kimi-model',
          description: '检查页面并询问执行范围',
        });
        emit('thinking.delta', { agentId: 'agent-browser', turnId: 41, delta: '正在检查页面结构' });
        emit('tool.call.started', {
          agentId: 'agent-browser',
          turnId: 41,
          toolCallId: 'child-read',
          name: 'Read',
          args: { path: 'index.html' },
        });
        emit('tool.progress', {
          agentId: 'agent-browser',
          turnId: 41,
          toolCallId: 'child-read',
          update: { text: '已读取页面，等待范围确认' },
        });
        ask(text, true);
      } else if (text.includes('Kimi 多选提问')) ask(text, false);
      else await complete(text);
    };
    return {
      start: async () => {
        const content = JSON.parse(await readFile(join(cwd, '.kimi-code', 'mcp.json'), 'utf8')) as {
          mcpServers: { isles: { url: string } };
        };
        mcp = content.mcpServers.isles;
      },
      subscribe: async (id) => {
        session = persisted.get(id);
        if (!session) throw new KimiWebError(40401, 'Unknown session', null, 200);
        subscribed = true;
      },
      request: async (method, path, body) => {
        const value = body as Record<string, unknown> | undefined;
        const root = path.split('?')[0]!;
        if (root === '/api/v1/workspaces') return { id: `wd-${cwd}`, root: cwd };
        if (root.includes('/workspaces/') && root.endsWith('/trust')) return { trusted: true };
        if (root === '/api/v1/models')
          return { items: [{ model: 'test-kimi-model', max_context_size: 262144 }] };
        if (root === '/api/v1/sessions' && method === 'POST') {
          session = {
            id: `session_${randomUUID()}`,
            workspace_id: `wd-${cwd}`,
            metadata: { cwd },
            seq: 0,
            epoch: `epoch-${randomUUID()}`,
            turn: 0,
            active: null,
            queued: [],
          };
          persisted.set(session.id, session);
          return session;
        }
        const match = root.match(/^\/api\/v1\/sessions\/([^/]+)(.*)$/);
        if (!match) throw new KimiWebError(40401, 'Unknown route', null, 200);
        session = persisted.get(decodeURIComponent(match[1]!));
        if (!session) throw new KimiWebError(40401, 'Unknown session', null, 200);
        const tail = match[2]!;
        if (!tail || tail === '/profile') return session;
        if (tail === '/snapshot')
          return {
            session: { ...session, usage: { context_tokens: 1000, context_limit: 262144 } },
            as_of_seq: session.seq,
            epoch: session.epoch,
            in_flight_turn: null,
          };
        if (tail === '/status')
          return {
            busy: Boolean(session.active),
            model: 'test-kimi-model',
            context_tokens: 1000,
            max_context_tokens: 262144,
          };
        if (tail === '/prompts' && method === 'GET')
          return { active: session.active, queued: session.queued };
        if (tail === '/prompts' && method === 'POST') {
          const prompt = {
            prompt_id: value!.prompt_id as string,
            status: 'queued' as const,
            content: value!.content as BrowserPrompt['content'],
          };
          const text = prompt.content.map((part) => part.text).join('');
          if (session.active) session.queued.push(prompt);
          else {
            session.active = { ...prompt, status: 'running' };
            session.turn++;
            emit('turn.started', { promptId: prompt.prompt_id });
            schedule(() => output(text), text.includes('保持执行以验证 Kimi 排队') ? 1500 : 250);
          }
          return session.active?.prompt_id === prompt.prompt_id ? session.active : prompt;
        }
        const action = tail.match(/^\/prompts\/([^/]+):(steer|abort)$/);
        if (action) {
          const id = decodeURIComponent(action[1]!);
          const prompt = session.queued.find((entry) => entry.prompt_id === id);
          session.queued = session.queued.filter((entry) => entry.prompt_id !== id);
          if (action[2] === 'steer') {
            if (!session.active || !prompt)
              throw new KimiWebError(40402, 'Prompt not pending', null, 200);
            emit('prompt.steered', { activePromptId: session.active.prompt_id, promptIds: [id] });
            schedule(() => complete(prompt.content.map((part) => part.text).join('')), 250);
            return { steered: true, prompt_ids: [id] };
          }
          emit('prompt.aborted', { promptId: id });
          if (session.active?.prompt_id === id) finish('cancelled');
          return { aborted: true };
        }
        if (tail.startsWith('/questions/')) {
          const question = pendingQuestion;
          if (!question || !tail.includes(question.id))
            throw new KimiWebError(40909, 'Question ended', null, 200);
          if (tail.endsWith(':dismiss')) {
            finish('cancelled');
            return { dismissed: true };
          }
          const selected = (value!.answers as { scope: { option_ids: string[] } }).scope.option_ids;
          const labels = selected.map((id) => ['代码', '文档', '测试'][Number(id)]).join('、');
          emit('event.question.answered', {
            agentId: question.child ? 'agent-browser' : 'main',
            question_id: question.id,
          });
          if (question.child) {
            emit('tool.result', {
              agentId: 'agent-browser',
              turnId: 41,
              toolCallId: 'child-read',
              output: '页面检查完成',
            });
            emit('subagent.completed', {
              subagentId: 'agent-browser',
              resultSummary: '页面检查完成',
            });
          }
          schedule(
            () =>
              complete(question.text, `Kimi ${question.child ? '子代理' : '多选'}回答：${labels}`),
            100,
          );
          return { resolved: true };
        }
        throw new KimiWebError(40401, 'Unknown route', null, 200);
      },
      close: async () => {
        closed = true;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        if (session) {
          session.active = null;
          session.queued = [];
        }
      },
    };
  };
  return new KimiWebAdapter(
    new KimiWebEnvironment(config, workspace),
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
          description: 'Browser Kimi web simulation',
          supportedReasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'high',
          isDefault: true,
        },
      ],
    },
    factory,
  );
}
