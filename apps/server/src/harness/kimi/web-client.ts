import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import type { Redactor } from '../../errors.js';
import type { Logger } from '../../logging.js';
import type { CliCommand } from '../shared/executable.js';
import { stopProcessTree } from '../shared/process.js';

export type KimiWebMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface KimiWebCursor {
  seq: number;
  epoch?: string;
}
export interface KimiWebHandlers {
  event(frame: unknown): void;
  exit(error: Error): void;
}
export interface KimiWebConnection {
  start(): Promise<void>;
  request(method: KimiWebMethod, path: string, body?: unknown): Promise<unknown>;
  subscribe(sessionId: string, cursor?: KimiWebCursor): Promise<void>;
  close(): Promise<void>;
}
export type KimiWebClientFactory = (
  command: CliCommand,
  cwd: string,
  env: Record<string, string>,
  handlers: KimiWebHandlers,
  redactor: Redactor,
  log: Logger,
) => KimiWebConnection;

/** A definite native envelope refusal, including refusals carried by HTTP 200. */
export class KimiWebError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: unknown,
    readonly status: number,
  ) {
    super(message);
  }
}

const envelopeSchema = z.object({ code: z.number().int(), msg: z.string(), data: z.unknown() });
const frameSchema = z.object({ type: z.string().min(1) }).passthrough();
const ackSchema = z.object({
  type: z.literal('ack'),
  id: z.string(),
  code: z.number().int(),
  msg: z.string(),
  payload: z.unknown().optional(),
});
const helloSchema = z.object({
  type: z.literal('server_hello'),
  payload: z.object({ protocol_version: z.literal(2) }),
});
const heartbeatSchema = z.object({
  type: z.enum(['ping', 'pong']),
  payload: z.object({ nonce: z.string() }),
});
const subscriptionSchema = z.object({
  accepted: z.array(z.string()),
  not_found: z.array(z.string()),
  resync_required: z.array(z.string()),
});

/** One owned local web server. Its access URL and token never leave the client. */
export class KimiWebClient implements KimiWebConnection {
  private child?: ChildProcessWithoutNullStreams;
  private terminated?: Promise<void>;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private origin?: string;
  private token?: string;
  private socket?: WebSocket;
  private readonly abort = new AbortController();
  private failed = false;
  private nextId = 0;
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  constructor(
    private command: CliCommand,
    private cwd: string,
    private env: Record<string, string>,
    private handlers: KimiWebHandlers,
    private redactor: Redactor,
    private log: Logger,
  ) {}

  start(): Promise<void> {
    return (this.starting ??= this.launch().catch((error: unknown) => {
      const reason = new Error(this.redactor.text(error));
      this.fail(reason);
      throw reason;
    }));
  }

  private async launch() {
    if (this.abort.signal.aborted) throw new Error('Kimi Code 连接已关闭');
    const child = spawn(
      this.command.file,
      [...this.command.args, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
      {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    );
    this.child = child;
    this.log.debug({ pid: child.pid }, 'Kimi Code web started');
    const stdout = createInterface({ input: child.stdout });
    const stderr = createInterface({ input: child.stderr });
    let rejectStart: (error: Error) => void = () => {};
    this.terminated = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        stdout.close();
        stderr.close();
        const error = new Error(`Kimi Code 已退出（${code ?? signal ?? 'unknown'}）`);
        rejectStart(error);
        this.fail(error);
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new Error('Kimi Code 连接已关闭'));
      const timer = setTimeout(
        () => finish(new Error('Kimi Code web 启动超时，请检查原生 CLI')),
        30_000,
      );
      rejectStart = finish;
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
      child.once('error', () => finish(new Error('无法启动 Kimi Code，请检查 CLI 路径')));
      const line = (value: string) => {
        // Native banners print the bearer token both in a URL and on its own line.
        // Consume stdio locally; logging even an early banner could expose a token.
        if (this.origin || this.abort.signal.aborted) return;
        const plain = stripVTControlCharacters(value);
        const match = plain.match(/http:\/\/127\.0\.0\.1:\d+\/?#token=[A-Za-z0-9._~%-]+/);
        if (!match) return;
        const url = new URL(match[0]);
        const token = new URLSearchParams(url.hash.slice(1)).get('token');
        if (!token || Number(url.port) <= 0 || Number(url.port) > 65535) {
          finish(new Error('Kimi Code web 返回了无效本机地址'));
          return;
        }
        this.redactor.add(token);
        this.origin = url.origin;
        this.token = token;
        finish();
      };
      stdout.on('line', line);
      stderr.on('line', line);
    });
    if (this.abort.signal.aborted) throw new Error('Kimi Code 连接已关闭');
    await this.connectSocket();
  }

  private connectSocket(): Promise<void> {
    const socket = new WebSocket(`${this.origin!.replace(/^http:/, 'ws:')}/api/v1/ws`, [
      `kimi-code.bearer.${this.token}`,
    ]);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      let ready = false;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new Error('Kimi Code 连接已关闭'));
      const timer = setTimeout(() => finish(new Error('Kimi Code WebSocket 握手超时')), 30_000);
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
      socket.addEventListener('message', (event) => {
        if (this.abort.signal.aborted) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 8_000_000)
            throw new Error('Kimi Code WebSocket 消息无效');
          const frame = frameSchema.parse(JSON.parse(event.data));
          if (frame.type === 'server_hello') {
            helloSchema.parse(frame);
            ready = true;
            finish();
          } else if (frame.type === 'ping' || frame.type === 'pong') {
            if (!ready) throw new Error('Kimi Code WebSocket 尚未完成握手');
            const heartbeat = heartbeatSchema.parse(frame);
            if (heartbeat.type === 'ping')
              socket.send(JSON.stringify({ type: 'pong', payload: heartbeat.payload }));
          } else if (frame.type === 'ack') {
            const ack = ackSchema.parse(frame);
            const pending = this.pending.get(ack.id);
            if (!pending) return;
            this.pending.delete(ack.id);
            clearTimeout(pending.timer);
            if (ack.code !== 0)
              pending.reject(
                new KimiWebError(ack.code, this.redactor.text(ack.msg), ack.payload, 200),
              );
            else pending.resolve(ack.payload);
          } else {
            if (!ready) throw new Error('Kimi Code WebSocket 尚未完成握手');
            this.handlers.event(frame);
          }
        } catch {
          const error = new Error('Kimi Code WebSocket 消息无效，连接已关闭');
          finish(error);
          this.fail(error);
        }
      });
      socket.addEventListener('error', () => {
        const error = new Error('Kimi Code WebSocket 连接失败');
        finish(error);
        this.fail(error);
      });
      socket.addEventListener('close', () => {
        const error = new Error('Kimi Code WebSocket 已关闭');
        finish(error);
        if (!this.abort.signal.aborted) this.fail(error);
      });
    });
  }

  async request(method: KimiWebMethod, path: string, body?: unknown): Promise<unknown> {
    await this.start();
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Kimi Code 请求路径无效');
    const response = await fetch(`${this.origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]),
      redirect: 'error',
    });
    const parsed = envelopeSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Kimi Code HTTP 响应格式无效，结果待核对');
    const envelope = parsed.data;
    if (!response.ok || envelope.code !== 0)
      throw new KimiWebError(
        envelope.code || response.status,
        this.redactor.text(envelope.msg),
        envelope.data,
        response.status,
      );
    return envelope.data;
  }

  async subscribe(sessionId: string, cursor?: KimiWebCursor): Promise<void> {
    await this.start();
    if (this.abort.signal.aborted || this.socket?.readyState !== WebSocket.OPEN)
      throw new Error('Kimi Code WebSocket 已关闭');
    const id = String(++this.nextId);
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Kimi Code 事件订阅超时'));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket!.send(
          JSON.stringify({
            type: 'subscribe',
            id,
            payload: {
              session_ids: [sessionId],
              ...(cursor ? { cursors: { [sessionId]: cursor } } : {}),
            },
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Kimi Code 事件订阅失败'));
      }
    });
    const subscription = subscriptionSchema.parse(result);
    if (subscription.not_found.includes(sessionId))
      throw new KimiWebError(40401, 'Kimi Code 原 session 不存在', result, 200);
    if (subscription.resync_required.includes(sessionId))
      throw new Error('Kimi Code 事件游标需要重新同步');
    if (!subscription.accepted.includes(sessionId))
      throw new Error('Kimi Code 未确认原 session 的事件订阅');
  }

  private fail(error: Error) {
    if (this.failed) return;
    this.failed = true;
    this.abort.abort();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closing) this.handlers.exit(error);
    void this.close();
  }

  close(): Promise<void> {
    return (this.closing ??= Promise.resolve().then(async () => {
      this.abort.abort();
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Kimi Code 连接已关闭'));
      }
      this.pending.clear();
      this.socket?.close();
      if (this.child && this.terminated) await stopProcessTree(this.child, this.terminated);
    }));
  }
}
