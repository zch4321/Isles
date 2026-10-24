import { ConfigManager } from '@isles/config';
import type { Agent, Model, UserQuestion } from '@isles/contracts';
import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { localOpenCodeProvider } from './opencode-provider-fixture.js';

// Real native acceptance uses isolated Isles state and the existing OpenCode profile.
const root = await mkdtemp(join(tmpdir(), 'isles-native-opencode-'));
console.log(`OpenCode acceptance files: ${root}`);
await writeFile(join(root, 'config.toml'), '[log]\nlevel="debug"\n');
const originalOverlay = process.env.OPENCODE_CONFIG_CONTENT;
const local =
  process.env.ISLES_TEST_OPENCODE_LOCAL === '1' ? await localOpenCodeProvider() : undefined;
if (local) process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(local.overlay);
const config = new ConfigManager({ configFilePath: join(root, 'config.toml') });
const logStream = {
  write: (line: string) => {
    appendFileSync(join(root, 'server.log'), line);
  },
  close: async () => {},
};
let app = await buildApp({ config, logStream });
const report: Record<string, unknown> = { root, startedAt: new Date().toISOString(), checks: {} };
const checks = report.checks as Record<string, unknown>;
function requireCheck(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
async function waitFor<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  label: string,
) {
  const until = Date.now() + 240_000;
  while (Date.now() < until) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`OpenCode acceptance timed out: ${label}`);
}
async function ready(agent: Agent) {
  return waitFor(
    () => {
      const current = app.isles.store.publicAgent(agent.id);
      if (current.status === 'error') throw new Error(current.error ?? 'OpenCode failed');
      return current;
    },
    (current) => current.status === 'ready',
    'ready',
  );
}
async function request(method: 'POST' | 'PATCH', url: string, payload: object) {
  const response = await app.inject({ method, url, payload });
  requireCheck(response.statusCode < 300, `${method} ${url}: ${response.body}`);
  return response.json();
}
async function send(channelId: string, body: string) {
  await request('POST', `/api/channels/${channelId}/messages`, { body, clientId: randomUUID() });
}
async function reply(agent: Agent, channelId: string, marker: string) {
  await waitFor(
    () => {
      const state = app.isles.store.publicAgent(agent.id);
      if (state.status === 'error') throw new Error(state.error ?? 'OpenCode failed');
      return app.isles.store.channelDetail(channelId).messages;
    },
    (messages) =>
      messages.some((message) => message.senderId === agent.id && message.body.includes(marker)),
    marker,
  );
  await ready(agent);
}
async function hash(path: string) {
  return createHash('sha256')
    .update(await readFile(path).catch(() => Buffer.alloc(0)))
    .digest('hex');
}
let agent: Agent | undefined;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const nativeConfig = join(config.current.cli.opencode.home, 'opencode.json');
  const before = await hash(nativeConfig);
  const status = (await app.inject('/api/harnesses/opencode/status')).json();
  requireCheck(status.available && status.authenticated, status.error ?? 'OpenCode unavailable');
  const models = (await app.inject('/api/harnesses/opencode/models')).json().models as Model[];
  const desired = local?.model ?? process.env.ISLES_TEST_OPENCODE_MODEL;
  report.mode = local ? 'real-cli-with-scripted-local-provider' : 'real-cli-with-native-provider';
  const model = desired
    ? models.find((entry) => entry.model === desired)
    : (models.find((entry) => entry.isDefault) ?? models[0]);
  requireCheck(model, `Native model not found: ${desired ?? 'default'}`);
  report.version = status.version;
  report.model = model.model;
  checks.catalog = { count: models.length, reasoningEfforts: model.supportedReasoningEfforts };
  console.log('OpenCode native catalog passed');
  agent = (await request('POST', '/api/agents', {
    harness: 'opencode',
    name: 'OpenCode 验证',
    model: model.model,
    reasoningEffort: model.defaultReasoningEffort,
    canCreateGroups: false,
    steerEnabled: false,
  })) as Agent;
  agent = await ready(agent);
  const sessionId = agent.threadId;
  requireCheck(sessionId, 'Native session ID missing');
  requireCheck(
    app.isles.store.agentDetail(agent.id).runs.length === 0,
    'Creation ran a model turn',
  );
  checks.creation = { sessionId, formalMessages: 0, islesRuns: 0 };
  console.log('OpenCode native creation passed');

  await send(
    agent.channelId,
    '这是有界接入验收。请通过 Isles send_message 向 private 发送且只发送 OPENCODE_PRIVATE_OK。不要只在原生输出中回复，不创建子代理。',
  );
  await reply(agent, agent.channelId, 'OPENCODE_PRIVATE_OK');
  checks.privateMcp = true;
  if (local) {
    requireCheck(local.guidanceLoaded, 'Native workspace AGENTS.md guidance missing');
    checks.workspaceInstructions = true;
  }
  console.log('OpenCode native private MCP passed');

  await request('POST', `/api/agents/${agent.id}/stop`, {});
  await send(
    agent.channelId,
    '恢复后请通过 Isles send_message 向 private 发送 OPENCODE_RESUME_OK。',
  );
  requireCheck(
    app.isles.store.publicAgent(agent.id).status === 'stopped',
    'Stopped Agent received input',
  );
  await request('POST', `/api/agents/${agent.id}/resume`, {});
  await reply(agent, agent.channelId, 'OPENCODE_RESUME_OK');
  requireCheck(
    app.isles.store.publicAgent(agent.id).threadId === sessionId,
    'Resume replaced session',
  );
  checks.stopResume = true;
  console.log('OpenCode native fixed-session resume passed');

  await send(
    agent.channelId,
    '请先使用原生 question / ask_user 工具问我选择蓝色还是绿色，提供这两个选项。收到答案后通过 Isles send_message 向 private 发送 OPENCODE_QUESTION_OK 加所选颜色。不要用普通消息代替原生工具。',
  );
  const question = (await waitFor(
    () => {
      const state = app.isles.store.publicAgent(agent!.id);
      if (state.status === 'error') throw new Error(state.error ?? 'Question failed');
      return app.isles.store
        .agentDetail(agent!.id)
        .questions.find((value) => value.status === 'pending');
    },
    Boolean,
    'native question',
  )) as UserQuestion;
  await request('POST', `/api/agents/${agent.id}/questions/${question.id}/answer`, {
    answers: Object.fromEntries(
      question.questions.map((field) => [
        field.id,
        {
          answers: [
            field.options?.find((option) => option.label.includes('蓝'))?.label ??
              field.options?.[0]?.label ??
              '蓝色',
          ],
        },
      ]),
    ),
  });
  await reply(agent, agent.channelId, 'OPENCODE_QUESTION_OK');
  checks.nativeQuestion = true;
  console.log('OpenCode native question/answer passed');

  const group = await request('POST', '/api/channels', {
    name: 'OpenCode 原生验收',
    memberIds: [agent.id],
  });
  local?.setGroup(group.id);
  await send(
    group.id,
    '这是有界群聊验收。通过 Isles send_message 在本群发送且只发送 OPENCODE_GROUP_OK。',
  );
  await reply(agent, group.id, 'OPENCODE_GROUP_OK');
  checks.groupMcp = true;
  console.log('OpenCode native group MCP passed');

  await request('PATCH', `/api/agents/${agent.id}`, { steerEnabled: true });
  const runCount = app.isles.store.agentDetail(agent.id).runs.length;
  await send(
    agent.channelId,
    '有界 steer 验收：先用终端工具执行 sleep 12，完成后通过 Isles send_message 向 private 发送 OPENCODE_STEER_DONE。接收当前执行内追加的输入，不调用 receive_messages 或 read_history，不创建子代理。',
  );
  const running = await waitFor(
    () => {
      const state = app.isles.store.publicAgent(agent!.id);
      if (state.status === 'error') throw new Error(state.error ?? 'Steer failed');
      return app.isles.store.agentDetail(agent!.id).runs[0];
    },
    (run) => !!run?.items.some((item) => item.status === 'running' && item.text.includes('sleep')),
    'sleep boundary',
  );
  requireCheck(running, 'Steer run missing');
  await send(
    agent.channelId,
    '这是当前执行的追加输入。终端等待结束后，通过 Isles send_message 向 private 发送 OPENCODE_STEER_OK，然后继续完成原任务。',
  );
  await reply(agent, agent.channelId, 'OPENCODE_STEER_OK');
  requireCheck(
    app.isles.store
      .channelDetail(agent.channelId)
      .messages.some((message) => message.body === 'OPENCODE_STEER_DONE'),
    'Original task reply missing after steer',
  );
  const detail = app.isles.store.agentDetail(agent.id);
  requireCheck(
    detail.runs.length === runCount + 1 && detail.runs[0]?.id === running.id,
    'Steer started another execution',
  );
  requireCheck(detail.runs[0]?.status === 'completed', 'Steer execution failed');
  checks.steer = { runId: running.id, turnId: running.turnId, sameRun: true };
  console.log('OpenCode native same-execution steer passed');

  if (local) {
    const previous = new Set(detail.runs.map((run) => run.id));
    const messageCount = app.isles.store.channelDetail(agent.channelId).messages.length;
    await send(
      agent.channelId,
      'OPENCODE_BACKGROUND_START：使用原生 subagent 启动后台子代理，然后结束当前响应。',
    );
    const activities = await waitFor(
      () => app.isles.store.agentDetail(agent!.id).runs.filter((run) => !previous.has(run.id)),
      (runs) =>
        runs.length === 3 &&
        runs.every((run) => run.status === 'completed') &&
        runs.some((run) => run.items.some((item) => item.text === 'OPENCODE_ROOT_WOKEN')),
      'background child and autonomous root wake',
    );
    const child = activities.find((run) => run.threadId !== sessionId);
    const roots = activities.filter((run) => run.threadId === sessionId);
    const started = roots.find((run) => run.inputs.length === 1);
    const woken = roots.find((run) => run.inputs.length === 0);
    requireCheck(child && started && woken, 'Native background activity identities missing');
    requireCheck(child.inputs.length === 0, 'Child activity acquired an Isles input');
    requireCheck(
      started.turnId !== woken.turnId && started.finishedAt! < child.finishedAt!,
      'Root activity did not finish independently of its background child',
    );
    requireCheck(
      child.items.some((item) => item.text === 'OPENCODE_CHILD_COMPLETE'),
      'Background child output missing',
    );
    const messages = app.isles.store.channelDetail(agent.channelId).messages;
    requireCheck(messages.length === messageCount + 1, 'Native activity created a formal message');
    requireCheck(
      messages
        .find((message) => message.body.startsWith('OPENCODE_BACKGROUND_START'))
        ?.deliveries.every((delivery) => delivery.status === 'accepted'),
      'Completed native activity changed its input delivery receipt',
    );
    checks.backgroundActivities = activities.map((run) => ({
      id: run.id,
      sessionId: run.threadId,
      turnId: run.turnId,
      inputCount: run.inputs.length,
      finishedAt: run.finishedAt,
    }));
    await ready(agent);
    console.log('OpenCode native independent child and autonomous root wake passed');
  }

  await request('POST', `/api/agents/${agent.id}/stop`, {});
  await app.close();
  app = await buildApp({ config, logStream });
  await app.listen({ host: '127.0.0.1', port: 0 });
  await send(
    agent.channelId,
    '服务重启验收：通过 Isles send_message 向 private 发送 OPENCODE_RESTART_OK。',
  );
  await request('POST', `/api/agents/${agent.id}/resume`, {});
  await reply(agent, agent.channelId, 'OPENCODE_RESTART_OK');
  requireCheck(
    app.isles.store.publicAgent(agent.id).threadId === sessionId,
    'Restart replaced session',
  );
  requireCheck((await hash(nativeConfig)) === before, 'Native config file changed');
  checks.serviceRestart = true;
  checks.nativeConfigPreserved = true;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (agent) report.lastState = app.isles.store.publicAgent(agent.id).status;
  await app.close();
  if (local) {
    report.localProviderRequests = local.requests;
    await local.close();
  }
  if (originalOverlay === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
  else process.env.OPENCODE_CONFIG_CONTENT = originalOverlay;
  report.finishedAt = new Date().toISOString();
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
}
