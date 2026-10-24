import { ConfigManager } from '@isles/config';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { AcpAdapter } from '../src/harness/acp/adapter.js';
import { KimiWebAdapter } from '../src/harness/kimi/web-adapter.js';
import { KimiWebClient, type KimiWebClientFactory } from '../src/harness/kimi/web-client.js';
import { KimiWebEnvironment } from '../src/harness/kimi/web-environment.js';
import { kimiSnapshotSchema } from '../src/harness/kimi/web-protocol.js';
import { KimiAcpHarness } from './kimi-acp-harness.js';

// Exercise the installed Kimi server with an isolated home and a local provider.
// Any inference request fails this check; no user login or session is touched.
const root = await mkdtemp(join(tmpdir(), 'isles-kimi-web-protocol-'));
const nativeHome = join(root, 'native-home');
await mkdir(nativeHome);
let inferenceRequests = 0;
const provider = createServer((request, response) => {
  if (request.method === 'POST') inferenceRequests++;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ object: 'list', data: [] }));
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address();
if (!address || typeof address === 'string') throw new Error('Local provider did not bind');
await writeFile(
  join(nativeHome, 'config.toml'),
  `default_model = "protocol/test"
default_permission_mode = "auto"
[providers.protocol]
type = "openai"
base_url = "http://127.0.0.1:${address.port}/v1"
api_key = "local-protocol-test"
[models."protocol/test"]
provider = "protocol"
model = "protocol-test"
max_context_size = 262144
capabilities = ["thinking"]
display_name = "Protocol test"
support_efforts = ["low", "high", "max"]
default_effort = "high"
`,
  { mode: 0o600 },
);
const config = new ConfigManager({
  configFilePath: join(root, 'config.toml'),
  homeDir: root,
  environment: { ISLES_KIMI_HOME: nativeHome, ISLES_KIMI_BIN: process.env.ISLES_KIMI_BIN },
});
const clients = new Map<string, KimiWebClient>();
let environment: KimiWebEnvironment;
const factory: KimiWebClientFactory = (...args) => {
  const client = new KimiWebClient(...args);
  clients.set(args[1], client);
  return client;
};
const app = await buildApp({
  config,
  adapterFactory: (workspace, settings) => {
    environment = new KimiWebEnvironment(settings, workspace);
    return [new KimiWebAdapter(environment, undefined, factory)];
  },
});
const report: Record<string, unknown> = { root, checkedAt: new Date().toISOString() };
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
  const beforeConfig = await readFile(join(nativeHome, 'config.toml'), 'utf8');
  const catalog = (await app.inject('/api/harnesses/kimi/models')).json().models as {
    model: string;
    supportedReasoningEfforts: string[];
  }[];
  check(
    catalog.some((model) => model.model === 'protocol/test'),
    'Native catalog lost model',
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/agents',
    payload: {
      harness: 'kimi',
      name: 'Kimi Web protocol check',
      model: 'protocol/test',
      reasoningEffort: 'high',
      steerEnabled: true,
    },
  });
  check(response.statusCode === 201, `Agent create failed (${response.statusCode})`);
  const agent = await ready((response.json() as { id: string }).id);
  check(agent.threadId, 'Native session is missing');
  const client = clients.get(agent.workspace)!;
  const snapshot = kimiSnapshotSchema.parse(
    await client.request('GET', `/api/v1/sessions/${agent.threadId}/snapshot`),
  );
  const tools = (await client.request('GET', '/api/v1/tools')) as {
    tools: { name: string }[];
  };
  check(
    tools.tools.some((tool) => tool.name === 'mcp__isles__send_message'),
    'Isles MCP missing',
  );
  const wire = await readFile(
    join(
      nativeHome,
      'sessions',
      snapshot.session.workspace_id,
      agent.threadId,
      'agents/main/wire.jsonl',
    ),
    'utf8',
  );
  const records = wire
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const binding = records.find((record) => record.type === 'profile.bind');
  const guidance = await readFile(join(agent.workspace, 'AGENTS.md'), 'utf8');
  check(
    typeof binding?.systemPrompt === 'string' && binding.systemPrompt.includes(guidance),
    'Native system prompt did not load workspace AGENTS.md',
  );
  check(!records.some((record) => record.type === 'llm.request'), 'Creation called a model');
  // Cover more than two native heartbeat intervals without submitting a prompt.
  await new Promise((resolve) => setTimeout(resolve, 23_000));
  check(
    app.isles.store.publicAgent(agent.id).status === 'ready',
    'Native heartbeat broke connection',
  );
  await app.isles.runtime.stop(agent.id);
  await app.isles.runtime.resume(agent.id);
  const resumed = await ready(agent.id);
  check(resumed.threadId === agent.threadId, 'Resume replaced the native session');
  // An ACP-created native session must also be usable by the new web adapter.
  await app.isles.runtime.stop(agent.id);
  const acp = await new AcpAdapter(new KimiAcpHarness(config, environment!.workspace)).connect(
    app.isles.store.getAgent(agent.id),
    `http://127.0.0.1:${(app.server.address() as { port: number }).port}`,
    { connected: () => {}, event: () => {}, question: () => {}, exit: () => {} },
  );
  let acpSessionId = '';
  try {
    await acp.createSession((id) => {
      acpSessionId = id;
    });
  } finally {
    await acp.close();
  }
  check(acpSessionId, 'ACP session did not persist an ID');
  app.isles.store.updateAgent(agent.id, { threadId: acpSessionId });
  await app.isles.runtime.resume(agent.id);
  check((await ready(agent.id)).threadId === acpSessionId, 'Web did not resume the ACP session');
  check(app.isles.store.agentDetail(agent.id).runs.length === 0, 'Protocol check created a run');
  check(inferenceRequests === 0, 'Protocol check called inference');
  check(
    (await readFile(join(nativeHome, 'config.toml'), 'utf8')) === beforeConfig,
    'Native configuration changed',
  );
  Object.assign(report, {
    sessionId: agent.threadId,
    catalog,
    guidanceLoaded: true,
    mcpConnected: true,
    fixedSessionResume: true,
    acpSessionResumed: true,
    heartbeatStable: true,
    inferenceRequests,
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
  await new Promise<void>((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve())),
  );
  await writeFile(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
