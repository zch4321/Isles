import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Redactor } from '../../errors.js';
import type { Logger } from '../../logging.js';
import type { CliCommand } from '../shared/executable.js';
import { stopProcessTree } from '../shared/process.js';
import { MAX_NATIVE_FRAME_LENGTH } from '../shared/native-limits.js';

export type OpenCodeMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export interface OpenCodeStream {
  done: Promise<void>;
  close(): void;
}
export interface OpenCodeConnection {
  start(): Promise<void>;
  request(method: OpenCodeMethod, path: string, body?: unknown): Promise<unknown>;
  watch(path: string, event: (frame: unknown) => void): Promise<OpenCodeStream>;
  close(): Promise<void>;
}
export interface OpenCodeHandlers {
  exit(error: Error): void;
}
export type OpenCodeClientFactory = (
  command: CliCommand,
  cwd: string,
  env: Record<string, string>,
  handlers: OpenCodeHandlers,
  redactor: Redactor,
  log: Logger,
) => OpenCodeConnection;

/** A native HTTP rejection with a known status, distinct from transport/protocol loss. */
export class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** An owned OpenCode v2 server. Stdio carries its address; all operations use native HTTP. */
export class OpenCodeClient implements OpenCodeConnection {
  private child?: ChildProcessWithoutNullStreams;
  private terminated?: Promise<void>;
  private starting?: Promise<void>;
  private url?: string;
  private readonly abort = new AbortController();
  private readonly password = randomBytes(32).toString('base64url');
  private closing?: Promise<void>;
  private failed = false;
  constructor(
    private command: CliCommand,
    private cwd: string,
    private env: Record<string, string>,
    private handlers: OpenCodeHandlers,
    private redactor: Redactor,
    private log: Logger,
  ) {
    this.redactor.add(this.password);
  }
  start(): Promise<void> {
    return (this.starting ??= this.launch());
  }
  private launch(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.reject(new Error('OpenCode 连接已关闭'));
    const child = spawn(
      this.command.file,
      [...this.command.args, 'serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'],
      {
        cwd: this.cwd,
        env: { ...process.env, ...this.env, OPENCODE_PASSWORD: this.password },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    );
    this.child = child;
    this.log.debug({ pid: child.pid }, 'OpenCode server started');
    const stdout = createInterface({ input: child.stdout });
    const stderr = createInterface({ input: child.stderr });
    stderr.on('line', (line) =>
      this.log.debug({ stderr: this.redactor.text(line) }, 'OpenCode stderr'),
    );
    let rejectStart: (error: Error) => void = () => {};
    this.terminated = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        stdout.close();
        stderr.close();
        const error = new Error(`OpenCode 已退出（${code ?? signal ?? 'unknown'}）`);
        rejectStart(error);
        this.fail(error);
        resolve();
      });
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('OpenCode server 启动超时，请检查原生 CLI 日志');
        rejectStart(error);
        this.fail(error);
        void this.close();
      }, 30_000);
      rejectStart = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.abort.signal.addEventListener(
        'abort',
        () => rejectStart(new Error('OpenCode 连接已关闭')),
        { once: true },
      );
      child.once('error', (error) => {
        this.log.warn({ err: error }, 'Failed to start OpenCode');
        const reason = new Error('无法启动 OpenCode，请检查 CLI 路径');
        rejectStart(reason);
        this.fail(reason);
      });
      stdout.on('line', (line) => {
        if (this.url || this.abort.signal.aborted) return;
        try {
          const frame = JSON.parse(line) as { url?: unknown };
          if (typeof frame.url !== 'string') return;
          const url = new URL(frame.url);
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port)
            throw new Error('OpenCode server 返回了无效本机地址');
          this.url = url.origin;
          clearTimeout(timer);
          resolve();
        } catch (error) {
          // Native startup may print ordinary diagnostics alongside the address.
          if (error instanceof SyntaxError) return;
          rejectStart(error as Error);
          this.fail(error as Error);
          void this.close();
        }
      });
    });
  }
  private fail(error: Error) {
    if (this.failed) return;
    this.failed = true;
    this.abort.abort();
    if (!this.closing) this.handlers.exit(error);
  }
  private headers() {
    return {
      Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`,
      'Content-Type': 'application/json',
    };
  }
  private async response(
    method: OpenCodeMethod,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    await this.start();
    this.log.debug({ method, path: path.split('?')[0] }, 'OpenCode request started');
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([this.abort.signal, signal ?? AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) {
      const reason = this.redactor.text(await response.text());
      throw new OpenCodeHttpError(response.status, `OpenCode HTTP ${response.status}: ${reason}`);
    }
    this.log.debug(
      { method, path: path.split('?')[0], status: response.status },
      'OpenCode request completed',
    );
    return response;
  }
  async request(method: OpenCodeMethod, path: string, body?: unknown): Promise<unknown> {
    const response = await this.response(method, path, body);
    return response.status === 204 ? {} : response.json();
  }
  async watch(path: string, event: (frame: unknown) => void): Promise<OpenCodeStream> {
    const abort = new AbortController();
    const response = await this.response('GET', path, undefined, abort.signal);
    if (!response.body) throw new Error('OpenCode 未返回事件流');
    const done = readSse(response.body, event).catch((error: unknown) => {
      if (!abort.signal.aborted && !this.abort.signal.aborted) throw error;
    });
    // Watchers own handling of a lost stream; avoid an unhandled rejection before subscription.
    void done.catch(() => {});
    return { done, close: () => abort.abort() };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      this.abort.abort();
      if (this.child && this.terminated) await stopProcessTree(this.child, this.terminated);
    });
    return this.closing;
  }
}

/** SSE preserves frame boundaries across arbitrary chunks, UTF-8 splits and CRLF. */
export async function readSse(body: ReadableStream<Uint8Array>, event: (frame: unknown) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let dataLength = 0;
  const line = (value: string) => {
    if (!value) {
      if (data.length) event(JSON.parse(data.join('\n')) as unknown);
      data = [];
      dataLength = 0;
    } else if (value.startsWith('data:')) {
      const part = value.slice(5).replace(/^ /, '');
      dataLength += part.length + (data.length ? 1 : 0);
      if (dataLength > MAX_NATIVE_FRAME_LENGTH) throw new Error('OpenCode 事件帧超出大小限制');
      data.push(part);
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, end).replace(/\r$/, ''));
        buffer = buffer.slice(end + 1);
      }
      if (buffer.length + dataLength > MAX_NATIVE_FRAME_LENGTH)
        throw new Error('OpenCode 事件帧超出大小限制');
      if (chunk.done) {
        // A frame without its final blank line is incomplete and must not be accepted.
        if (data.length || buffer.trim()) throw new Error('OpenCode 事件流在完整帧前断开');
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
