import { ConfigManager } from '@isles/config';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  OpenCodeClientFactory,
  OpenCodeConnection,
  OpenCodeMethod,
  OpenCodeStream,
} from '../src/harness/opencode/client.js';
import type { OpenCodeEvent } from '../src/harness/opencode/protocol.js';

export const fixtureModel = {
  id: 'fixture-model',
  modelID: 'fixture-model',
  providerID: 'fixture',
  name: 'Fixture Model',
  enabled: true,
  variants: [{ id: 'high' }, { id: 'max' }],
  capabilities: { tools: true, input: ['text'], output: ['text'] },
};

export async function opencodeConfig(root: string) {
  const binary = join(root, 'opencode-fixture');
  const home = join(root, 'native-home');
  await mkdir(home, { recursive: true });
  await writeFile(binary, '#!/bin/sh\nprintf "opencode v2.0.25\\n"\n');
  await chmod(binary, 0o755);
  const config = new ConfigManager({
    configFilePath: join(root, 'config.toml'),
    homeDir: root,
    environment: { ISLES_DATA_DIR: root, ISLES_OPENCODE_HOME: home },
  });
  await config.configureCliBinary('opencode', binary);
  return { config, binary, home };
}

export interface NativeCall {
  method: OpenCodeMethod;
  path: string;
  body?: unknown;
}
/** A controllable native connection: HTTP acknowledgement and durable delivery are independent. */
export class OpenCodeFixture implements OpenCodeConnection {
  readonly calls: NativeCall[] = [];
  readonly sessions = new Map<string, Record<string, unknown>>();
  readonly watchers = new Map<
    string,
    { event: (frame: unknown) => void; end: () => void; fail: (error: Error) => void }
  >();
  readonly factory: OpenCodeClientFactory = (_command, _cwd, env) => {
    this.env = env;
    if (this.closed) this.watchers.clear();
    this.closed = false;
    return this;
  };
  env: Record<string, string> = {};
  closed = false;
  sequence = 0;
  onRequest?: (call: NativeCall) => Promise<unknown> | unknown;
  autoConnected = true;
  async start() {}
  async request(method: OpenCodeMethod, path: string, body?: unknown): Promise<unknown> {
    const call = { method, path, body };
    this.calls.push(call);
    if (this.onRequest) {
      const result = await this.onRequest(call);
      if (result !== undefined) return result;
    }
    const route = path.split('?')[0];
    if (route === '/api/credential' || route === '/api/integration') return { data: [] };
    if (route === '/api/model') return { data: [fixtureModel] };
    if (route === '/api/model/default') return { data: fixtureModel };
    if (route === '/api/mcp') return { data: [{ name: 'isles', status: { status: 'connected' } }] };
    if (route === '/api/session' && method === 'POST') {
      const info: Record<string, unknown> = {
        ...(body as Record<string, unknown>),
        time: { created: Date.now(), updated: Date.now() },
      };
      this.sessions.set(info.id as string, info);
      return { data: info };
    }
    if (route === '/api/session/active') return { data: {} };
    if (route?.startsWith('/api/session/') && method === 'GET' && route.split('/').length === 4) {
      const info = this.sessions.get(route.split('/')[3]!);
      if (!info) throw new Error('Native session missing');
      return { data: info };
    }
    if (route?.endsWith('/context') || route?.endsWith('/inbox') || route === '/api/form')
      return { data: [] };
    if (
      method === 'PATCH' ||
      method === 'DELETE' ||
      route?.endsWith('/interrupt') ||
      route?.endsWith('/model') ||
      route?.endsWith('/reply')
    )
      return {};
    throw new Error(`Unexpected OpenCode fixture request: ${method} ${path}`);
  }
  async watch(path: string, event: (frame: unknown) => void): Promise<OpenCodeStream> {
    let end = () => {};
    let fail: (error: Error) => void = () => {};
    const done = new Promise<void>((resolve, reject) => {
      end = resolve;
      fail = reject;
    });
    void done.catch(() => {});
    this.watchers.set(path, { event, end, fail });
    if (path.split('?')[0] !== '/api/event') throw new Error('Use the native global event stream');
    if (this.autoConnected) queueMicrotask(() => this.connected());
    return { done, close: end };
  }
  frame(sessionID: string, type: string, data: Record<string, unknown> = {}): OpenCodeEvent {
    return {
      id: `evt_${++this.sequence}`,
      type,
      created: Date.now(),
      durable: { aggregateID: sessionID, seq: this.sequence, version: 1 },
      data: { sessionID, ...data },
    };
  }
  connected() {
    this.emit({ type: 'server.connected', id: 'evt_connected', data: {} });
  }
  emit(frame: unknown) {
    for (const [path, watcher] of this.watchers)
      if (path.split('?')[0] === '/api/event')
        try {
          watcher.event(frame);
        } catch (error) {
          watcher.fail(error as Error);
        }
  }
  execution(sessionID: string) {
    const frame = this.frame(sessionID, 'session.execution.started');
    this.emit(frame);
    return frame.id;
  }
  deliver(sessionID: string, inboxID: string) {
    this.emit(this.frame(sessionID, 'session.inbox.delivered', { inboxID }));
  }
  loseEvents(error = new Error('Native global event stream lost')) {
    for (const [path, watcher] of this.watchers)
      if (path.split('?')[0] === '/api/event') watcher.fail(error);
  }
  async close() {
    this.closed = true;
    for (const watcher of this.watchers.values()) watcher.end();
  }
}

export const inboxReceipt = (sessionID: string, text: string, id = `msg_${randomUUID()}`) => ({
  data: {
    id,
    sessionID,
    type: 'user',
    payload: { text },
    delivery: 'steer',
    time: { created: Date.now() },
  },
});
