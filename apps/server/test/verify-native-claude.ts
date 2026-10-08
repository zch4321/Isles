import { ConfigManager } from '@isles/config';
import type { Agent, Channel, Model, UserQuestion } from '@isles/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';

// Native acceptance always uses a fresh Isles configuration, database and workspaces.
// Native CLI authentication/configuration is the user's existing shared profile.
const root = await mkdtemp(join(tmpdir(), 'isles-native-claude-'));
const config = new ConfigManager({
  configFilePath: join(root, 'config.toml'),
  environment: {
    ISLES_DATA_DIR: join(root, 'data'),
    ...(process.env.ISLES_CLAUDE_BIN ? { ISLES_CLAUDE_BIN: process.env.ISLES_CLAUDE_BIN } : {}),
    ...(process.env.ISLES_CLAUDE_HOME ? { ISLES_CLAUDE_HOME: process.env.ISLES_CLAUDE_HOME } : {}),
    ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } : {}),
    ...(process.env.ISLES_CODEX_BIN ? { ISLES_CODEX_BIN: process.env.ISLES_CODEX_BIN } : {}),
    ...(process.env.ISLES_CODEX_HOME ? { ISLES_CODEX_HOME: process.env.ISLES_CODEX_HOME } : {}),
    ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
  },
});
let app = await buildApp({ config });
const report: Record<string, unknown> = { root, startedAt: new Date().toISOString(), checks: {} };
const checks = report.checks as Record<string, unknown>;
const requireCheck = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
async function waitFor<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  label: string,
): Promise<T> {
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    const value = await read();
    if (accept(value)) return value;
    await pause();
  }
  throw new Error(`Native acceptance timed out: ${label}`);
}
async function ready(id: string) {
  return waitFor(
    () => {
      const agent = app.isles.store.publicAgent(id);
      if (agent.status === 'error') throw new Error(agent.error ?? 'Native Agent failed');
      return agent;
    },
    (agent) => agent.status === 'ready',
    `Agent ${id} ready`,
  );
}
async function send(channelId: string, body: string) {
  const result = await app.inject({
    method: 'POST',
    url: `/api/channels/${channelId}/messages`,
    payload: { body, clientId: randomUUID() },
  });
  requireCheck(result.statusCode === 201, `Message request failed (${result.statusCode})`);
}
async function reply(agent: Agent, marker: string) {
  await waitFor(
    () => app.isles.store.channelDetail(agent.channelId).messages,
    (messages) =>
      messages.some((message) => message.senderId === agent.id && message.body.includes(marker)),
    marker,
  );
  await ready(agent.id);
}
async function create(harness: string, name: string) {
  const status = (await app.inject(`/api/harnesses/${harness}/status?refresh=true`)).json();
  requireCheck(status.available && status.authenticated, status.error ?? `${harness} unavailable`);
  const models = (await app.inject(`/api/harnesses/${harness}/models`)).json().models as Model[];
  const preferred =
    harness === 'claude' ? process.env.ISLES_TEST_CLAUDE_MODEL : process.env.ISLES_TEST_CODEX_MODEL;
  const model =
    models.find((model) => model.model === preferred) ??
    models.find((model) => model.isDefault) ??
    models[0]!;
  const reasoningEffort = model.supportedReasoningEfforts.includes('high')
    ? 'high'
    : model.defaultReasoningEffort;
  const result = await app.inject({
    method: 'POST',
    url: '/api/agents',
    payload: {
      harness,
      name,
      model: model.model,
      reasoningEffort,
      canCreateGroups: false,
      steerEnabled: false,
    },
  });
  requireCheck(result.statusCode === 201, `Create ${harness} failed: ${result.body}`);
  const created = result.json() as Agent;
  report[`${harness}Version`] = status.version;
  report[`${harness}Model`] = model.model;
  const agent = await ready(created.id);
  requireCheck(agent.threadId, 'Native session binding missing');
  return agent;
}
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  let claude = await create('claude', 'Claude 验证');
  const nativeId = claude.threadId;
  requireCheck(
    app.isles.store.agentDetail(claude.id).runs.length === 0,
    'Bootstrap produced an Isles run',
  );
  requireCheck(
    app.isles.store.channelDetail(claude.channelId).messages.length === 0,
    'Bootstrap published a formal message',
  );
  requireCheck(
    (await readFile(join(claude.workspace, 'CLAUDE.md'), 'utf8')).includes('@AGENTS.md'),
    'Native guidance bridge missing',
  );
  checks.neutralInitialization = { sessionId: nativeId, formalMessages: 0, islesRuns: 0 };
  console.log('Native Claude neutral initialization passed');

  await send(
    claude.channelId,
    '这是原生验收。请通过 Isles send_message 向 private 发送且只发送 CLAUDE_PRIVATE_OK；不要只在原生输出中回复。',
  );
  await reply(claude, 'CLAUDE_PRIVATE_OK');
  checks.privateMcp = true;
  console.log('Native Claude private MCP passed');

  await app.inject({ method: 'POST', url: `/api/agents/${claude.id}/stop`, payload: {} });
  await send(
    claude.channelId,
    '恢复后请通过 Isles send_message 向 private 发送 CLAUDE_RESUME_OK。',
  );
  requireCheck(
    app.isles.store.publicAgent(claude.id).status === 'stopped',
    'Stopped Agent processed input',
  );
  await app.inject({ method: 'POST', url: `/api/agents/${claude.id}/resume`, payload: {} });
  await reply(claude, 'CLAUDE_RESUME_OK');
  requireCheck(
    app.isles.store.publicAgent(claude.id).threadId === nativeId,
    'Stop/resume replaced the native session',
  );
  checks.stopResume = true;
  console.log('Native Claude fixed-session resume passed');

  await send(
    claude.channelId,
    '请先调用原生 AskUserQuestion，问我选择蓝色还是绿色，选项为蓝色和绿色。收到我的选择后，通过 Isles send_message 向 private 发送 CLAUDE_QUESTION_OK 加上所选颜色。必须调用原生工具，不要将问题作为普通聊天消息发出。',
  );
  const question = (await waitFor(
    () =>
      app.isles.store
        .agentDetail(claude.id)
        .questions.find((question) => question.status === 'pending'),
    Boolean,
    'Claude native question',
  )) as UserQuestion;
  const answers = Object.fromEntries(
    question.questions.map((definition) => [
      definition.id,
      {
        answers: [
          definition.options?.find((option) => option.label.includes('蓝'))?.label ??
            definition.options?.[0]?.label ??
            '蓝色',
        ],
      },
    ]),
  );
  const answered = await app.inject({
    method: 'POST',
    url: `/api/agents/${claude.id}/questions/${question.id}/answer`,
    payload: { answers },
  });
  requireCheck(answered.statusCode === 200, `Native answer failed (${answered.statusCode})`);
  await reply(claude, 'CLAUDE_QUESTION_OK');
  checks.nativeQuestion = true;
  console.log('Native Claude question/answer passed');

  const edited = await app.inject({
    method: 'PATCH',
    url: `/api/agents/${claude.id}`,
    payload: { name: 'Claude 已改名' },
  });
  requireCheck(edited.statusCode === 200, 'Claude edit failed');
  claude = await ready(claude.id);
  requireCheck(claude.threadId === nativeId, 'Editing replaced the native session');
  checks.editPreservesSession = true;

  if (process.env.ISLES_TEST_SKIP_MIXED !== '1') {
    const codex = await create('codex', 'Codex 验证');
    const result = await app.inject({
      method: 'POST',
      url: '/api/channels',
      payload: { name: '原生混合验收', memberIds: [claude.id, codex.id] },
    });
    requireCheck(
      result.statusCode === 201,
      `Mixed group creation failed (${result.statusCode}): ${result.body}`,
    );
    const group = result.json() as Channel;
    await send(
      group.id,
      '这是有界验收。名称以 Claude 开头的成员通过 Isles send_message 在本群只发送 CLAUDE_MIXED_OK；名称以 Codex 开头的成员在本群只发送 CODEX_MIXED_OK。每位仅回复这条用户消息一次，不回复其他 Agent，不创建子代理。',
    );
    await waitFor(
      () => {
        const messages = app.isles.store.channelDetail(group.id).messages;
        requireCheck(messages.length < 12, 'Mixed group did not settle');
        return messages;
      },
      (messages) =>
        messages.some(
          (message) => message.senderId === claude.id && message.body.includes('CLAUDE_MIXED_OK'),
        ) &&
        messages.some(
          (message) => message.senderId === codex.id && message.body.includes('CODEX_MIXED_OK'),
        ),
      'Mixed group formal replies',
    );
    await ready(claude.id);
    await ready(codex.id);
    checks.mixedGroup = { groupId: group.id, codexSessionId: codex.threadId };
    console.log('Native Claude/Codex mixed group passed');
  }

  for (const agent of app.isles.store.listAgents()) await app.isles.runtime.stop(agent.id);
  await app.close();
  app = await buildApp({ config });
  await app.listen({ host: '127.0.0.1', port: 0 });
  await send(
    claude.channelId,
    '重启验收：通过 Isles send_message 向 private 发送 CLAUDE_RESTART_OK。',
  );
  await app.inject({ method: 'POST', url: `/api/agents/${claude.id}/resume`, payload: {} });
  await reply(claude, 'CLAUDE_RESTART_OK');
  requireCheck(
    app.isles.store.publicAgent(claude.id).threadId === nativeId,
    'Service restart replaced the native session',
  );
  checks.serviceRestart = true;
  console.log('Native Claude same-session service restart passed');
  const deleted = await app.inject({ method: 'DELETE', url: `/api/agents/${claude.id}` });
  requireCheck(
    deleted.statusCode === 200 && app.isles.store.publicAgent(claude.id).status === 'deleted',
    'Claude deletion failed',
  );
  requireCheck(
    app.isles.store
      .channelDetail(claude.channelId)
      .messages.some((message) => message.body.includes('CLAUDE_RESTART_OK')),
    'Deletion lost history',
  );
  checks.retainedHistoryDeletion = true;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await app.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
}
