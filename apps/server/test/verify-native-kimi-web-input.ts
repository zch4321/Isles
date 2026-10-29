import { ConfigManager } from '@isles/config';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { KimiWebAdapter } from '../src/harness/kimi/web-adapter.js';
import { KimiWebClient, KimiWebError } from '../src/harness/kimi/web-client.js';
import { KimiWebEnvironment } from '../src/harness/kimi/web-environment.js';
import {
  kimiEventSchema,
  kimiPromptSchema,
  kimiPromptsSchema,
  kimiSnapshotSchema,
  type KimiWebEvent,
} from '../src/harness/kimi/web-protocol.js';
import {
  HarnessImageInputUnsupported,
  type HarnessEvent,
  type HarnessSession,
} from '../src/harness/types.js';

// Run with ISLES_KIMI_BIN pointing to the native CLI under test. Every model
// request uses the scripted loopback provider and a newly created native home.
const root = await mkdtemp(join(tmpdir(), 'isles-kimi-web-input-'));
const nativeHome = join(root, 'native-home');
await mkdir(nativeHome);
const report: Record<string, unknown> = { root, checkedAt: new Date().toISOString() };
const events: HarnessEvent[] = [];
const frames: unknown[] = [];
const competitorFrames: KimiWebEvent[] = [];
const failures: string[] = [];
interface ModelRequest {
  body: { stream?: boolean; messages?: unknown[] };
  response: ServerResponse;
  released: boolean;
}
const requests: ModelRequest[] = [];
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push({ body: JSON.parse(body) as ModelRequest['body'], response, released: false });
  } catch (error) {
    failures.push(String(error));
    response.writeHead(500).end();
  }
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address();
if (!address || typeof address === 'string') throw new Error('Local provider did not bind');
await writeFile(
  join(nativeHome, 'config.toml'),
  `default_model = "input/test"
default_permission_mode = "auto"
[providers.input]
type = "openai"
base_url = "http://127.0.0.1:${address.port}/v1"
api_key = "local-input-test"
[models."input/test"]
provider = "input"
model = "input-test"
max_context_size = 262144
capabilities = ["thinking", "image_in"]
display_name = "Input test"
support_efforts = ["low", "high", "max"]
default_effort = "high"
[models."input/text-only"]
provider = "input"
model = "input-text-only"
max_context_size = 262144
capabilities = ["thinking"]
display_name = "Text-only input test"
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
let session: HarnessSession;
let client: KimiWebClient;
let environment: KimiWebEnvironment;
let competitor: KimiWebClient | undefined;
const app = await buildApp({
  config,
  adapterFactory: (workspace, settings) => {
    environment = new KimiWebEnvironment(settings, workspace);
    const adapter = new KimiWebAdapter(environment, undefined, (...args) => {
      const handlers = args[3];
      return (client = new KimiWebClient(
        args[0],
        args[1],
        args[2],
        {
          event: (frame) => {
            frames.push(frame);
            handlers.event(frame);
          },
          exit: handlers.exit,
        },
        args[4],
        args[5],
      ));
    });
    const connect = adapter.connect.bind(adapter);
    adapter.connect = async (agent, baseUrl, handlers) => {
      const connected = await connect(agent, baseUrl, {
        ...handlers,
        event: (event) => {
          events.push(event);
          handlers.event(event);
        },
        exit: (error) => {
          failures.push(error.message);
          handlers.exit(error);
        },
      });
      session = connected;
      return connected;
    };
    return [adapter];
  },
});
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until<T>(label: string, inspect: () => T | undefined, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (failures.length) throw new Error(failures.join('\n'));
    const result = inspect();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}
function release(index: number, content: string) {
  const request = requests[index];
  check(request && !request.released, `Request ${index} missing or released`);
  request.released = true;
  if (request.response.destroyed) return;
  const base = { id: `chatcmpl-${randomUUID()}`, created: 1, model: 'input-test' };
  if (request.body.stream) {
    request.response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (data: object) =>
      request.response.write(
        `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', ...data })}\n\n`,
      );
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] });
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    frame({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } });
    request.response.end('data: [DONE]\n\n');
  } else {
    request.response.setHeader('Content-Type', 'application/json');
    request.response.end(
      JSON.stringify({
        ...base,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      }),
    );
  }
}
function completed(turnId: string) {
  return until('turn completion', () =>
    events.find((event) => event.type === 'turn_completed' && event.turnId === turnId),
  );
}
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const created = await app.inject({
    method: 'POST',
    url: '/api/agents',
    payload: {
      harness: 'kimi',
      name: 'Kimi native input check',
      model: 'input/test',
      reasoningEffort: 'high',
      steerEnabled: true,
    },
  });
  check(created.statusCode === 201, `Agent create failed: ${created.body}`);
  const id = (created.json() as { id: string }).id;
  const agent = await until('agent ready', () => {
    const current = app.isles.store.publicAgent(id);
    check(current.status !== 'error', current.error ?? 'Agent failed');
    return current.status === 'ready' ? current : undefined;
  });
  check(agent.threadId, 'Native session missing');
  const executable = await environment!.executable();
  report.version = executable.version;
  check(/\b2\.3\.1\b/.test(executable.version), `Expected Kimi 2.3.1: ${executable.version}`);
  const sessionId = agent.threadId;
  const input = (text: string) => ({
    sessionId,
    runId: randomUUID(),
    text,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    workspace: agent.workspace,
  });
  const path = `/api/v1/sessions/${sessionId}/`;
  const imageData =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC';
  const imagePath = join(agent.workspace, '.isles-images', 'one.png');
  const imageLabel = '[channel: protocol, message 1, image 1]';
  await mkdir(join(agent.workspace, '.isles-images'), { recursive: true });
  await writeFile(imagePath, Buffer.from(imageData, 'base64'));
  const first = await session!.submit({
    ...input('KIMI_INPUT_NORMAL'),
    images: [
      {
        id: 'image-one',
        path: imagePath,
        mimeType: 'image/png',
        data: imageData,
        label: imageLabel,
      },
    ],
  });
  const normalRequest = await until('normal model request', () => requests[0]);
  const normalMessages = JSON.stringify(normalRequest.body.messages);
  check(normalMessages.includes('KIMI_INPUT_NORMAL'), 'Input missing');
  check(normalMessages.includes(imageLabel), 'Image label missing');
  check(normalMessages.includes(`data:image/png;base64,${imageData}`), 'Native image missing');
  release(0, 'KIMI_NORMAL_OK');
  const normal = await completed(first.turnId);
  check(normal.type === 'turn_completed' && normal.status === 'completed', 'Normal turn failed');
  check(
    events.some(
      (event) =>
        (event.type === 'item' || event.type === 'item_delta') &&
        event.turnId === first.turnId &&
        event.item.text.includes('KIMI_NORMAL_OK'),
    ),
    'Normal response missing from adapter output',
  );
  report.normalInput = true;
  report.nativeImageInput = true;

  const second = await session!.submit(input('KIMI_INPUT_STEER_INITIAL'));
  await until('held steer model request', () => requests[1]);
  const batchId = randomUUID();
  const steering = session!.steer!({
    sessionId,
    expectedTurnId: second.turnId,
    batchId,
    text: 'KIMI_INPUT_STEER_ADDED',
  });
  // Admission is explicit before releasing the in-flight model request.
  await until('native prompt.steered receipt', () =>
    frames.find((value) => {
      const frame = kimiEventSchema.parse(value);
      return (
        frame.type === 'prompt.steered' &&
        JSON.stringify(frame.payload.promptIds).includes(`isles-${agent.id}-${batchId}`)
      );
    }),
  );
  release(1, 'KIMI_STEER_INITIAL_OK');
  const steered = await steering;
  check(steered.turnId === second.turnId, 'Steer changed the public turn identity');
  const continuation = await until('steered continuation request', () => requests[2]);
  check(
    JSON.stringify(continuation.body.messages).includes('KIMI_INPUT_STEER_ADDED'),
    'Steered input missing from continuation',
  );
  release(2, 'KIMI_STEER_ADDED_OK');
  const steerCompletion = await completed(second.turnId);
  check(
    steerCompletion.type === 'turn_completed' && steerCompletion.status === 'completed',
    'Steered turn failed',
  );
  check(
    events.some(
      (event) =>
        (event.type === 'item' || event.type === 'item_delta') &&
        event.turnId === second.turnId &&
        event.item.text.includes('KIMI_STEER_ADDED_OK'),
    ),
    'Steered continuation response missing from the original adapter turn',
  );
  check(
    events.filter((event) => event.type === 'turn_started' && event.turnId === second.turnId)
      .length === 1,
    'Steered run published more than one turn start',
  );
  report.sameRunSteer = true;

  // The second native server reads the same session before its owner starts a
  // held turn, then attempts a write while the first process holds the lease.
  competitor = new KimiWebClient(
    executable,
    agent.workspace,
    environment!.env,
    {
      event: (frame) => competitorFrames.push(kimiEventSchema.parse(frame)),
      exit: (error) => failures.push(error.message),
    },
    environment!.redactor,
    environment!.log,
  );
  await competitor.start();
  await competitor.request('GET', `${path}snapshot`);
  const interrupted = await session!.submit(input('KIMI_INPUT_INTERRUPT_OWNER'));
  await until('held interruption model request', () => requests[3]);
  const refusedId = `native-lock-check-${randomUUID()}`;
  let refusal: KimiWebError | undefined;
  try {
    await competitor.request('POST', `${path}prompts`, {
      prompt_id: refusedId,
      content: [{ type: 'text', text: 'KIMI_INPUT_LOCK_MUST_NOT_RUN' }],
      model: agent.model,
      thinking: agent.reasoningEffort,
    });
  } catch (error) {
    check(error instanceof KimiWebError, `Unexpected lock error: ${String(error)}`);
    refusal = error;
  }
  check(refusal?.code === 40931, `Expected occupied code 40931, got ${refusal?.code}`);
  const inbox = kimiPromptsSchema.parse(await competitor.request('GET', `${path}prompts`));
  check(
    inbox.active?.prompt_id !== refusedId && !inbox.queued.some((p) => p.prompt_id === refusedId),
    'Occupied request entered the native inbox',
  );
  await session!.interrupt(sessionId, interrupted.turnId);
  const interruption = await completed(interrupted.turnId);
  check(
    interruption.type === 'turn_completed' && interruption.status === 'interrupted',
    'Interrupt did not finish with interrupted status',
  );
  release(3, 'KIMI_INTERRUPT_LATE_RESPONSE');
  const snapshot = kimiSnapshotSchema.parse(await client!.request('GET', `${path}snapshot`));
  const wirePath = join(
    nativeHome,
    'sessions',
    snapshot.session.workspace_id,
    sessionId,
    'agents/main/wire.jsonl',
  );
  check(
    !(await readFile(wirePath, 'utf8')).includes(refusedId),
    'Refused prompt persisted to wire',
  );
  check(requests.slice().length === 4, `Expected four model requests, got ${requests.length}`);
  check(
    requests.every(
      (r) => !JSON.stringify(r.body.messages).includes('KIMI_INPUT_LOCK_MUST_NOT_RUN'),
    ),
    'Occupied input reached the provider',
  );
  // A normal owner shutdown releases the lease. Reusing the refused prompt ID
  // then establishes that the failed POST did not reserve or consume that ID.
  await app.isles.runtime.stop(id);
  const retrySnapshot = kimiSnapshotSchema.parse(
    await competitor.request('GET', `${path}snapshot`),
  );
  await competitor.subscribe(sessionId, {
    seq: retrySnapshot.as_of_seq,
    epoch: retrySnapshot.epoch,
  });
  const retried = kimiPromptSchema.parse(
    await competitor.request('POST', `${path}prompts`, {
      prompt_id: refusedId,
      content: [{ type: 'text', text: 'KIMI_INPUT_LOCK_RELEASED_RETRY' }],
      model: agent.model,
      thinking: agent.reasoningEffort,
    }),
  );
  check(retried.prompt_id === refusedId, 'Retry changed the refused prompt ID');
  const retryRequest = await until('released owner retry request', () => requests[4]);
  check(
    JSON.stringify(retryRequest.body.messages).includes('KIMI_INPUT_LOCK_RELEASED_RETRY'),
    'Retry did not reach provider',
  );
  release(4, 'KIMI_LOCK_RETRY_OK');
  const retryCompletion = await until('retry completion', () =>
    competitorFrames.find((frame) => frame.type === 'turn.ended'),
  );
  check(retryCompletion.payload.reason === 'completed', 'Retry failed after owner released');
  check(requests.length === 5, `Expected five total model requests, got ${requests.length}`);
  const textOnlyCreated = await app.inject({
    method: 'POST',
    url: '/api/agents',
    payload: {
      harness: 'kimi',
      name: 'Kimi text-only input check',
      model: 'input/text-only',
      reasoningEffort: 'high',
      steerEnabled: false,
    },
  });
  check(
    textOnlyCreated.statusCode === 201,
    `Text-only Agent create failed: ${textOnlyCreated.body}`,
  );
  const textOnlyId = (textOnlyCreated.json() as { id: string }).id;
  const textOnly = await until('text-only agent ready', () => {
    const current = app.isles.store.publicAgent(textOnlyId);
    check(current.status !== 'error', current.error ?? 'Text-only Agent failed');
    return current.status === 'ready' ? current : undefined;
  });
  check(textOnly.threadId, 'Text-only native session missing');
  let imageRefusal: unknown;
  try {
    await session!.submit({
      sessionId: textOnly.threadId,
      runId: randomUUID(),
      text: 'KIMI_UNSUPPORTED_IMAGE',
      model: textOnly.model,
      reasoningEffort: textOnly.reasoningEffort,
      workspace: textOnly.workspace,
      images: [
        {
          id: 'image-one',
          path: imagePath,
          mimeType: 'image/png',
          data: imageData,
          label: imageLabel,
        },
      ],
    });
  } catch (error) {
    imageRefusal = error;
  }
  check(
    imageRefusal instanceof HarnessImageInputUnsupported,
    'Text-only model did not reject image',
  );
  check(
    imageRefusal.message.includes('请选择支持图片输入的模型并恢复 Agent'),
    'Image refusal lacks next step',
  );
  check(requests.length === 5, 'Text-only image reached the model provider');
  Object.assign(report, {
    sessionId,
    interrupt: true,
    occupiedCode: refusal.code,
    occupiedInputAbsentFromInboxAndWire: true,
    refusedPromptIdReusableAfterOwnerRelease: true,
    inferenceRequests: requests.length,
    textOnlyImageRejected: true,
    wirePath,
  });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await competitor?.close();
  await app.close();
  provider.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve())),
  );
  await writeFile(
    join(root, 'events.json'),
    `${JSON.stringify({ events, frames, competitorFrames }, null, 2)}\n`,
  );
  await writeFile(
    join(root, 'provider.json'),
    `${JSON.stringify(
      requests.map((r) => r.body),
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
