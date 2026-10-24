import { ConfigManager } from '@isles/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DshClientFactory, DshConnection, DshHandlers } from '../src/harness/dsh/client.js';
import type { DshRuntime } from '../src/harness/dsh/environment.js';

export const fixtureModel = {
  provider: 'fixture',
  id: 'nested/model',
  name: 'Fixture Model',
  reasoning: {
    efforts: [
      { id: 'high', name: 'High' },
      { id: 'max', name: 'Max' },
    ],
    defaultEffort: 'high',
  },
};

export async function dshConfig(root: string) {
  const binary = join(root, 'dsh-fixture.mjs');
  const home = join(root, 'native-home');
  await mkdir(home, { recursive: true });
  await writeFile(binary, 'console.log("0.2.0-rc.2");\n');
  const config = new ConfigManager({
    configFilePath: join(root, 'config.toml'),
    homeDir: root,
    environment: { ISLES_DATA_DIR: root, ISLES_DSH_HOME: home },
  });
  await config.configureCliBinary('dsh', binary);
  return { config, binary, home };
}

/** A real stdio transport peer; no native SDK or provider is loaded. */
export async function dshTransport(root: string) {
  const script = join(root, 'dsh-rpc-fixture.mjs');
  const audit = join(root, 'rpc-calls.jsonl');
  await writeFile(
    script,
    String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const output = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  appendFileSync(process.env.DSH_FIXTURE_AUDIT, JSON.stringify(frame) + '\n');
  if (frame.method === 'shutdown') {
    output({ id: frame.id, result: {} });
    return;
  }
  if (frame.method === 'malformed') {
    process.stdout.write('{invalid-json}\n');
    return;
  }
  if (frame.method === 'refuse') {
    output({ id: frame.id, error: { code: -32603, message: 'Failure ' + process.env.DSH_FIXTURE_TOKEN } });
    return;
  }
  process.stderr.write('Diagnostic ' + process.env.DSH_FIXTURE_TOKEN + '\n');
  const notification = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'fixture/notice', params: { text: '中文' } }) + '\n');
  for (const byte of notification) process.stdout.write(Buffer.from([byte]));
  output({ id: frame.id, result: { params: frame.params, cwd: process.cwd(), home: process.env.DSH_HOME, args: process.argv.slice(2) } });
});
`,
  );
  return { command: { file: process.execPath, args: [script] }, audit };
}

export interface NativeCall {
  method: string;
  params: Record<string, unknown>;
}

/** RPC admission and native consumption deliberately have independent clocks. */
export class DshFixture implements DshConnection {
  readonly calls: NativeCall[] = [];
  readonly sessions = new Map<string, { sessionId: string; cwd: string }>();
  readonly runtimes: { cwd: string; runtime: DshRuntime }[] = [];
  readonly factory: DshClientFactory = (_command, cwd, runtime, handlers) => {
    this.runtimes.push({ cwd, runtime });
    this.handlers = handlers;
    this.closed = false;
    return this;
  };
  closed = false;
  private handlers?: DshHandlers;
  private sequence = 0;
  onRequest?: (call: NativeCall) => unknown | Promise<unknown>;
  async request(method: string, params: unknown): Promise<unknown> {
    const call = { method, params: params as Record<string, unknown> };
    this.calls.push(call);
    if (this.onRequest) {
      const result = await this.onRequest(call);
      if (result !== undefined) return result;
    }
    if (method === 'isles/catalog')
      return {
        models: [fixtureModel],
        defaultSelection: {
          provider: fixtureModel.provider,
          model: fixtureModel.id,
          reasoningEffort: 'high',
        },
      };
    if (method === 'isles/session/create') {
      const sessionId = call.params.sessionId as string;
      const session = { sessionId, cwd: call.params.cwd as string };
      this.sessions.set(sessionId, session);
      return session;
    }
    if (method === 'isles/session/resume') {
      if (!this.sessions.has(call.params.sessionId as string))
        throw new Error('Native session missing');
      return this.sessions.get(call.params.sessionId as string);
    }
    if (method === 'isles/session/submit' || method === 'isles/session/steer')
      return { sessionId: call.params.sessionId, messageId: call.params.messageId };
    if (
      method === 'isles/session/interrupt' ||
      method.startsWith('isles/question/') ||
      method.startsWith('isles/permission/') ||
      method === 'shutdown'
    )
      return {};
    throw new Error(`Unexpected DSH fixture request: ${method}`);
  }
  event(sessionId: string, event: Record<string, unknown>, rootSessionId = sessionId) {
    this.notify('isles/event', {
      rootSessionId,
      sessionId,
      event,
      eventId: `evt_${++this.sequence}`,
    });
  }
  start(sessionId: string, turnId = `turn_${++this.sequence}`) {
    this.event(sessionId, { type: 'turn_started', turnId });
    return turnId;
  }
  accept(sessionId: string, messageId: string, turnId: string) {
    this.event(sessionId, { type: 'input_accepted', messageId, turnId });
  }
  complete(sessionId: string, turnId: string, status = 'completed') {
    this.event(sessionId, { type: 'turn_completed', turnId, status, error: null });
  }
  notify(method: string, params: unknown) {
    const value = params as Record<string, unknown>;
    this.handlers?.notification(method, { rootSessionId: value.sessionId, ...value });
  }
  loseConnection(error = new Error('Native SDK stream lost')) {
    this.handlers?.exit(error);
  }
  async close() {
    this.closed = true;
  }
}
