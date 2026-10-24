import assert from 'node:assert/strict';
import { ConfigManager } from '@isles/config';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { DshAdapter } from '../src/harness/dsh/adapter.js';
import { DshEnvironment } from '../src/harness/dsh/environment.js';

// Persist real rc3 root turns and asynchronous subagent epochs through the full
// Isles runtime. Inference stays inside the scripted adapter; MCP is real HTTP.
const root = await mkdtemp(join(tmpdir(), 'isles-dsh-native-runtime-'));
console.log(`DSH native activity persistence files: ${root}`);
const home = join(root, 'home');
await mkdir(home);
await writeFile(
  join(home, 'cordis.patch.yml'),
  JSON.stringify([
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-deepseek-account', disabled: true },
    {
      insert: [
        {
          id: 'isles-native-async-fixture',
          name: fileURLToPath(new URL('./dsh-native-async-fixture.mjs', import.meta.url)),
        },
      ],
    },
  ]),
);
const originalAudit = process.env.ISLES_DSH_ASYNC_AUDIT;
process.env.ISLES_DSH_ASYNC_AUDIT = join(root, 'native-events.jsonl');
const config = new ConfigManager({
  configFilePath: join(root, 'config.toml'),
  homeDir: root,
  environment: {
    ISLES_DATA_DIR: root,
    ISLES_DSH_HOME: home,
    ...(process.env.ISLES_DSH_BIN ? { ISLES_DSH_BIN: process.env.ISLES_DSH_BIN } : {}),
  },
});
const app = await buildApp({
  config,
  logStream: {
    write: (line) => {
      appendFileSync(join(root, 'server.log'), line);
    },
    close: async () => {},
  },
  adapterFactory: (workspace, settings) => [
    new DshAdapter(new DshEnvironment(settings, workspace)),
  ],
});
const report: Record<string, unknown> = { root };
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Native activity persistence timed out');
    await delay(25);
  }
}
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const status = (await app.inject('/api/harnesses/dsh/status')).json();
  assert.equal(status.authenticated, true, JSON.stringify(status));
  report.version = status.version;
  const response = await app.inject({
    method: 'POST',
    url: '/api/agents',
    payload: {
      harness: 'dsh',
      name: 'DSH asynchronous activity check',
      model: 'isles-scripted/scripted',
      reasoningEffort: 'default',
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  const created = response.json() as { id: string; channelId: string };
  await waitFor(() => {
    const agent = app.isles.store.publicAgent(created.id);
    if (agent.status === 'error') throw new Error(agent.error ?? 'Native agent failed');
    return agent.status === 'ready';
  });
  const rootSessionId = app.isles.store.publicAgent(created.id).threadId;
  const sent = await app.inject({
    method: 'POST',
    url: `/api/channels/${created.channelId}/messages`,
    payload: { body: 'Run scripted asynchronous activity', clientId: randomUUID() },
  });
  assert.equal(sent.statusCode, 201, sent.body);
  await waitFor(() => {
    const runs = app.isles.store.agentDetail(created.id).runs;
    return runs.length === 3 && runs.every((run) => run.status === 'completed');
  });
  const detail = app.isles.store.agentDetail(created.id);
  const rootRuns = detail.runs.filter((run) => run.threadId === rootSessionId);
  const childRuns = detail.runs.filter((run) => run.threadId === 'external-child');
  assert.deepEqual(rootRuns.map((run) => run.turnId).sort(), ['1', '2']);
  assert.equal(childRuns.length, 1);
  assert(
    childRuns[0]!.items.some(
      (item) => item.type === 'subagent' && item.text.includes('scripted child answer'),
    ),
  );
  assert(
    rootRuns.every((run) =>
      run.items.some(
        (item) => item.type === 'agentMessage' && item.text === 'scripted parent answer',
      ),
    ),
  );
  assert.equal(
    app.isles.store.listMessages(created.channelId)[0]!.deliveries[0]!.status,
    'accepted',
  );
  await app.isles.runtime.stop(created.id);
  await app.isles.runtime.resume(created.id);
  await waitFor(() => app.isles.store.publicAgent(created.id).status === 'ready');
  assert.equal(app.isles.store.publicAgent(created.id).threadId, rootSessionId);
  assert.equal(app.isles.store.agentDetail(created.id).runs.length, 3);
  const backgroundResponse = await app.inject({
    method: 'POST',
    url: '/api/agents',
    payload: {
      harness: 'dsh',
      name: 'DSH background stop check',
      model: 'isles-scripted/scripted',
      reasoningEffort: 'default',
    },
  });
  assert.equal(backgroundResponse.statusCode, 201, backgroundResponse.body);
  const background = backgroundResponse.json() as { id: string; channelId: string };
  await waitFor(() => app.isles.store.publicAgent(background.id).status === 'ready');
  const backgroundSessionId = app.isles.store.publicAgent(background.id).threadId;
  await app.inject({
    method: 'POST',
    url: `/api/channels/${background.channelId}/messages`,
    payload: { body: 'Stop the background child', clientId: randomUUID() },
  });
  await waitFor(() => {
    const runs = app.isles.store.agentDetail(background.id).runs;
    return (
      runs.some((run) => run.threadId === backgroundSessionId && run.status === 'completed') &&
      runs.some((run) => run.threadId === 'external-child' && run.status === 'running')
    );
  });
  await app.isles.runtime.stop(background.id);
  const stopped = app.isles.store.agentDetail(background.id);
  assert.equal(
    stopped.runs.find((run) => run.threadId === 'external-child')?.status,
    'interrupted',
  );
  assert.equal(app.isles.store.publicAgent(background.id).status, 'stopped');
  await delay(600);
  assert.equal(app.isles.store.agentDetail(background.id).runs.length, 2);
  await app.isles.runtime.resume(background.id);
  await waitFor(() => app.isles.store.publicAgent(background.id).status === 'ready');
  assert.equal(app.isles.store.publicAgent(background.id).threadId, backgroundSessionId);
  assert.equal(app.isles.store.agentDetail(background.id).runs.length, 2);
  Object.assign(report, {
    passed: true,
    rootSessionId,
    rootTurns: ['1', '2'],
    childSessionId: 'external-child',
    childEpoch: childRuns[0]!.turnId,
    persistedActivities: 3,
    delivery: 'accepted',
    fixedSessionResume: true,
    idleRootBackgroundStop: true,
    remoteInferenceRequests: 0,
  });
  await writeFile(join(root, 'activities.json'), JSON.stringify(detail.runs, null, 2));
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await app.close();
  if (originalAudit === undefined) delete process.env.ISLES_DSH_ASYNC_AUDIT;
  else process.env.ISLES_DSH_ASYNC_AUDIT = originalAudit;
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
