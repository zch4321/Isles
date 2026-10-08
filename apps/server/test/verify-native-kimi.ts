import { ConfigManager } from '@isles/config';
import type { Agent, Channel, Model, UserQuestion } from '@isles/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';

// Native acceptance always uses a fresh Isles configuration, database and workspaces.
// Native CLI authentication/configuration is the user's existing shared profile.
const root = await mkdtemp(join(tmpdir(), 'isles-native-kimi-'));
const passthrough = [
  'ISLES_KIMI_BIN',
  'ISLES_KIMI_HOME',
  'KIMI_CODE_HOME',
  'ISLES_CODEX_BIN',
  'ISLES_CODEX_HOME',
  'CODEX_HOME',
];
const config = new ConfigManager({
  configFilePath: join(root, 'config.toml'),
  environment: {
    ISLES_DATA_DIR: join(root, 'data'),
    ...Object.fromEntries(
      passthrough.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
    ),
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
  const until = Date.now() + 240_000;
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
async function hash(path: string) {
  return createHash('sha256')
    .update(await readFile(path).catch(() => Buffer.alloc(0)))
    .digest('hex');
}
async function create(harness: string, name: string) {
  const status = (await app.inject(`/api/harnesses/${harness}/status?refresh=true`)).json();
  requireCheck(status.available && status.authenticated, status.error ?? `${harness} unavailable`);
  const models = (await app.inject(`/api/harnesses/${harness}/models`)).json().models as Model[];
  const preferred =
    harness === 'kimi' ? process.env.ISLES_TEST_KIMI_MODEL : process.env.ISLES_TEST_CODEX_MODEL;
  const model =
    models.find((model) => model.model === preferred) ??
    models.find((model) => model.isDefault) ??
    models[0]!;
  const result = await app.inject({
    method: 'POST',
    url: '/api/agents',
    payload: {
      harness,
      name,
      model: model.model,
      reasoningEffort: model.defaultReasoningEffort,
      canCreateGroups: false,
      steerEnabled: false,
    },
  });
  requireCheck(result.statusCode === 201, `Create ${harness} failed: ${result.body}`);
  const created = result.json() as Agent;
  report[`${harness}Version`] = status.version;
  report[`${harness}Model`] = `${model.model} / ${model.defaultReasoningEffort}`;
  const agent = await ready(created.id);
  requireCheck(agent.threadId, 'Native session binding missing');
  return agent;
}
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const nativeConfig = join(config.current.cli.kimi.home, 'config.toml');
  const before = await hash(nativeConfig);
  const models = (await app.inject('/api/harnesses/kimi/models')).json().models as Model[];
  requireCheck(models.length > 0, 'Kimi catalog returned no models');
  requireCheck((await hash(nativeConfig)) === before, 'Catalog probe changed the Kimi config');
  checks.catalog = models.map((model) => `${model.model}: ${model.supportedReasoningEfforts}`);
  console.log('Native Kimi catalog passed');

  let kimi = await create('kimi', 'Kimi 验证');
  const nativeId = kimi.threadId;
  requireCheck(
    app.isles.store.agentDetail(kimi.id).runs.length === 0 &&
      app.isles.store.channelDetail(kimi.channelId).messages.length === 0,
    'Creation produced an Isles run or message',
  );
  await app.inject({ method: 'POST', url: `/api/agents/${kimi.id}/stop`, payload: {} });
  await app.inject({ method: 'POST', url: `/api/agents/${kimi.id}/resume`, payload: {} });
  kimi = await ready(kimi.id);
  requireCheck(kimi.threadId === nativeId, 'Resuming an empty session replaced it');
  checks.emptySessionResume = { sessionId: nativeId };
  console.log('Native Kimi empty-session resume passed');

  await send(
    kimi.channelId,
    '这是原生验收。请通过 Isles send_message 向 private 发送且只发送 KIMI_PRIVATE_OK；不要只在原生输出中回复。',
  );
  await reply(kimi, 'KIMI_PRIVATE_OK');
  checks.privateMcp = true;
  console.log('Native Kimi private MCP passed');

  await send(
    kimi.channelId,
    '请先运行 shell 命令 `sleep 20`，完成后通过 Isles send_message 向 private 发送 KIMI_FIRST_OK。',
  );
  await waitFor(
    () => app.isles.store.publicAgent(kimi.id).status,
    (status) => status === 'running',
    'Kimi busy turn',
  );
  await send(kimi.channelId, '通过 Isles send_message 向 private 发送 KIMI_QUEUED_OK。');
  const queued = app.isles.store.listMessages(kimi.channelId).at(-1)!.deliveries[0]!.status;
  await reply(kimi, 'KIMI_FIRST_OK');
  await reply(kimi, 'KIMI_QUEUED_OK');
  const runs = app.isles.store.agentDetail(kimi.id).runs;
  requireCheck(
    runs.every((run) => run.threadId === nativeId),
    'Queued input used another native session',
  );
  checks.busyQueue = { deliveryWhileBusy: queued, runs: runs.length };
  console.log('Native Kimi busy queue passed');

  await app.inject({ method: 'POST', url: `/api/agents/${kimi.id}/stop`, payload: {} });
  await send(kimi.channelId, '恢复后请通过 Isles send_message 向 private 发送 KIMI_RESUME_OK。');
  requireCheck(
    app.isles.store.publicAgent(kimi.id).status === 'stopped',
    'Stopped Agent processed input',
  );
  await app.inject({ method: 'POST', url: `/api/agents/${kimi.id}/resume`, payload: {} });
  await reply(kimi, 'KIMI_RESUME_OK');
  requireCheck(
    app.isles.store.publicAgent(kimi.id).threadId === nativeId,
    'Stop/resume replaced the native session',
  );
  checks.stopResume = true;
  console.log('Native Kimi fixed-session resume passed');

  await send(
    kimi.channelId,
    '请先调用原生 AskUserQuestion，问我选择蓝色还是绿色，选项为蓝色和绿色。收到我的选择后，通过 Isles send_message 向 private 发送 KIMI_QUESTION_OK 加上所选颜色。必须调用原生工具，不要将问题作为普通聊天消息发出。',
  );
  const question = (await waitFor(
    () =>
      app.isles.store
        .agentDetail(kimi.id)
        .questions.find((question) => question.status === 'pending'),
    Boolean,
    'Kimi native question',
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
    url: `/api/agents/${kimi.id}/questions/${question.id}/answer`,
    payload: { answers },
  });
  requireCheck(answered.statusCode === 200, `Native answer failed (${answered.statusCode})`);
  await reply(kimi, 'KIMI_QUESTION_OK');
  checks.nativeQuestion = { questions: question.questions };
  console.log('Native Kimi question/answer passed');

  if (process.env.ISLES_TEST_SKIP_MIXED !== '1') {
    const codex = await create('codex', 'Codex 验证');
    const result = await app.inject({
      method: 'POST',
      url: '/api/channels',
      payload: { name: '原生混合验收', memberIds: [kimi.id, codex.id] },
    });
    requireCheck(
      result.statusCode === 201,
      `Mixed group creation failed (${result.statusCode}): ${result.body}`,
    );
    const group = result.json() as Channel;
    await send(
      group.id,
      '这是有界验收。名称以 Kimi 开头的成员通过 Isles send_message 在本群只发送 KIMI_MIXED_OK；名称以 Codex 开头的成员在本群只发送 CODEX_MIXED_OK。每位仅回复这条用户消息一次，不回复其他 Agent，不创建子代理。',
    );
    await waitFor(
      () => {
        const messages = app.isles.store.channelDetail(group.id).messages;
        requireCheck(messages.length < 12, 'Mixed group did not settle');
        return messages;
      },
      (messages) =>
        messages.some(
          (message) => message.senderId === kimi.id && message.body.includes('KIMI_MIXED_OK'),
        ) &&
        messages.some(
          (message) => message.senderId === codex.id && message.body.includes('CODEX_MIXED_OK'),
        ),
      'Mixed group formal replies',
    );
    await ready(kimi.id);
    await ready(codex.id);
    checks.mixedGroup = { groupId: group.id, codexSessionId: codex.threadId };
    console.log('Native Kimi/Codex mixed group passed');
  }

  for (const agent of app.isles.store.listAgents()) await app.isles.runtime.stop(agent.id);
  await app.close();
  app = await buildApp({ config });
  await app.listen({ host: '127.0.0.1', port: 0 });
  await send(kimi.channelId, '重启验收：通过 Isles send_message 向 private 发送 KIMI_RESTART_OK。');
  await app.inject({ method: 'POST', url: `/api/agents/${kimi.id}/resume`, payload: {} });
  await reply(kimi, 'KIMI_RESTART_OK');
  requireCheck(
    app.isles.store.publicAgent(kimi.id).threadId === nativeId,
    'Service restart replaced the native session',
  );
  checks.serviceRestart = true;
  console.log('Native Kimi same-session service restart passed');
  const deleted = await app.inject({ method: 'DELETE', url: `/api/agents/${kimi.id}` });
  requireCheck(
    deleted.statusCode === 200 && app.isles.store.publicAgent(kimi.id).status === 'deleted',
    'Kimi deletion failed',
  );
  requireCheck(
    app.isles.store
      .channelDetail(kimi.channelId)
      .messages.some((message) => message.body.includes('KIMI_RESTART_OK')),
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
