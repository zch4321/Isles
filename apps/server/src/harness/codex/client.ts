import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  NativeRpcError,
  rpcFrameSchema,
  type NativeClient,
  type NativeHandlers,
  type RequestId,
} from './protocol.js';
import type { Redactor } from '../../errors.js';
import { stopProcessTree } from '../shared/process.js';
import type { Logger } from '../../logging.js';
import type { NativeCommand } from './executable.js';

export class StdioClient implements NativeClient {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    RequestId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private nextId = 0;
  private closed = false;
  private closing = false;
  private terminated: Promise<void>;
  constructor(
    binary: string | NativeCommand,
    workspace: string,
    env: Record<string, string>,
    private handlers: NativeHandlers,
    private redactor: Redactor,
    private log: Logger,
  ) {
    const command = typeof binary === 'string' ? { file: binary, args: [] } : binary;
    this.child = spawn(command.file, [...command.args, 'app-server', '--listen', 'stdio://'], {
      cwd: workspace,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    this.log.debug({ pid: this.child.pid }, 'Codex app-server started');
    // Stderr is not an execution item. Native diagnostics can contain config/auth
    // material, so lines are redacted and logged only at debug level.
    createInterface({ input: this.child.stderr }).on('line', (line) =>
      this.log.debug({ stderr: this.redactor.text(line) }, 'Codex app-server stderr'),
    );
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      if (this.closed) return;
      try {
        if (line.length > 8_000_000) throw new Error('原生协议帧超出大小限制');
        const frame = rpcFrameSchema.parse(JSON.parse(line));
        if (frame.method) {
          if (frame.id !== undefined)
            this.handlers.request(frame.id, frame.method, frame.params ?? {});
          else this.handlers.notification(frame.method, frame.params ?? {});
        } else if (frame.id !== undefined) {
          const pending = this.pending.get(frame.id);
          if (!pending) return;
          this.pending.delete(frame.id);
          clearTimeout(pending.timer);
          if (frame.error)
            pending.reject(
              new NativeRpcError(this.redactor.text(frame.error.message), frame.error.code),
            );
          else pending.resolve(frame.result);
        }
      } catch (error) {
        this.log.warn({ err: error }, 'Failed to process a Codex protocol frame');
        this.fail(new Error('Codex 原生协议消息无效，连接已关闭'));
        void this.close();
      }
    });
    this.child.once('error', (error) => {
      this.log.error({ err: error }, 'Failed to start Codex app-server');
      this.fail(new Error('无法启动 Codex app-server，请检查 CLI 路径'));
    });
    this.terminated = new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        this.log.debug({ code, signal }, 'Codex app-server exited');
        lines.close();
        this.fail(new Error(`Codex app-server 已退出（${code ?? 'signal'}）`));
        resolve();
      });
    });
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    if (!this.closing) this.handlers.exit(error);
  }
  private send(frame: unknown) {
    if (this.closed || !this.child.stdin.writable) throw new Error('Codex 连接已断开');
    this.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
      if (error) this.fail(new Error('Codex 协议写入失败'));
    });
  }
  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'isles', title: 'Isles', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.send({ method: 'initialized', params: {} });
  }
  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 响应超时，结果待核对`));
      }, 60_000);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  respond(id: RequestId, result: unknown) {
    this.send({ id, result });
  }
  reject(id: RequestId, message: string) {
    this.send({ id, error: { code: -32601, message } });
  }
  async close() {
    if (this.closing) return this.terminated;
    this.closing = true;
    this.fail(new Error('Codex 连接已关闭'));
    await stopProcessTree(this.child, this.terminated);
  }
}
