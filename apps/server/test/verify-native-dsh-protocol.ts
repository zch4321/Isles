import { ConfigManager } from '@isles/config';
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { DshAdapter } from '../src/harness/dsh/adapter.js';
import { DshEnvironment } from '../src/harness/dsh/environment.js';
import type { Model } from '@isles/contracts';

// Real native loader/bridge/MCP/session check with an isolated home. The local
// endpoint fails any inference request; no account or remote model is needed.
const root = await mkdtemp(join(tmpdir(), 'isles-dsh-protocol-'));
console.log(`DSH protocol files: ${root}`);
const home = join(root, 'native-home');
await mkdir(home);
let inferenceRequests = 0;
const provider = createServer((_request, response) => {
  inferenceRequests++;
  response.writeHead(500).end('Protocol check must not invoke a model');
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address();
if (!address || typeof address === 'string') throw new Error('Provider did not bind');
const patch = join(home, 'cordis.patch.yml');
await writeFile(
  patch,
  JSON.stringify([
    {
      id: 'llm-deepseek',
      config: {
        baseURL: `http://127.0.0.1:${address.port}`,
        apiKeyEnv: 'ISLES_DSH_PROTOCOL_KEY',
      },
    },
  ]),
);
const originalKey = process.env.ISLES_DSH_PROTOCOL_KEY;
process.env.ISLES_DSH_PROTOCOL_KEY = 'local-protocol-test';
const config = new ConfigManager({
  configFilePath: join(root, 'config.toml'),
  homeDir: root,
  environment: { ISLES_DSH_HOME: home, ISLES_DSH_BIN: process.env.ISLES_DSH_BIN },
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
const report: Record<string, unknown> = { root, checkedAt: new Date().toISOString() };
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function ready(id: string) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const agent = app.isles.store.publicAgent(id);
    if (agent.status === 'error') throw new Error(agent.error ?? 'Agent failed');
    if (agent.status === 'ready') return agent;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Agent initialization timed out');
}
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const before = await readFile(patch, 'utf8');
  const status = (await app.inject('/api/harnesses/dsh/status')).json();
  check(status.available && status.authenticated, status.error ?? 'Native catalog failed');
  report.version = status.version;
  const models = (await app.inject('/api/harnesses/dsh/models')).json().models as Model[];
  const model = models.find((entry) => entry.isDefault) ?? models[0];
  check(model, 'Native model missing');
  const response = await app.inject({
    method: 'POST',
    url: '/api/agents',
    payload: {
      harness: 'dsh',
      name: 'DSH protocol check',
      model: model.model,
      reasoningEffort: model.defaultReasoningEffort,
    },
  });
  check(response.statusCode === 201, `Create failed: ${response.body}`);
  const agent = await ready((response.json() as { id: string }).id);
  check(agent.threadId, 'Native session missing');
  await app.isles.runtime.stop(agent.id);
  await app.isles.runtime.resume(agent.id);
  check((await ready(agent.id)).threadId === agent.threadId, 'Resume changed native session');
  check(app.isles.store.agentDetail(agent.id).runs.length === 0, 'Check created a run');
  check(inferenceRequests === 0, 'Check invoked inference');
  check((await readFile(patch, 'utf8')) === before, 'Native configuration changed');
  Object.assign(report, {
    passed: true,
    model: model.model,
    sessionId: agent.threadId,
    mcpConnected: true,
    fixedSessionResume: true,
    inferenceRequests,
  });
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await app.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  if (originalKey === undefined) delete process.env.ISLES_DSH_PROTOCOL_KEY;
  else process.env.ISLES_DSH_PROTOCOL_KEY = originalKey;
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
