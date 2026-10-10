import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { Redactor } from '../../errors.js';
import type { Logger } from '../../logging.js';
import type { CliCommand } from '../shared/executable.js';
import { stopProcessTree } from '../shared/process.js';
import type { DshRuntime } from './environment.js';

const frameSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional(),
});
export class DshRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}
export interface DshHandlers {
  notification(method: string, params: unknown): void;
  exit(error: Error): void;
}
export interface DshConnection {
  request(method: string, params: unknown, timeout?: number): Promise<unknown>;
  close(): Promise<void>;
}
export type DshClientFactory = (
  command: CliCommand,
  cwd: string,
  runtime: DshRuntime,
  handlers: DshHandlers,
  redactor: Redactor,
  log: Logger,
) => DshConnection;

/** Owned SDK stdio process; the native bridge adds session and steer operations. */
export class DshClient implements DshConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly terminated: Promise<void>;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private nextId = 0;
  private failed = false;
  private closing?: Promise<void>;
  constructor(
    command: CliCommand,
    cwd: string,
    runtime: DshRuntime,
    private readonly handlers: DshHandlers,
    private readonly redactor: Redactor,
    private readonly log: Logger,
  ) {
    this.child = spawn(command.file, [...command.args, ...runtime.args], {
      cwd,
      env: { ...process.env, ...command.env, ...runtime.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    this.log.debug({ pid: this.child.pid }, 'DSH SDK started');
    const stdout = createInterface({ input: this.child.stdout });
    const stderr = createInterface({ input: this.child.stderr });
    stderr.on('line', (line) => this.log.debug({ stderr: this.redactor.text(line) }, 'DSH stderr'));
    stdout.on('line', (line) => {
      if (this.failed || !line.trim()) return;
      try {
        if (line.length > 8_000_000) throw new Error('DSH 原生协议帧超出大小限制');
        const frame = frameSchema.parse(JSON.parse(line));
        if (frame.method) {
          if (frame.id !== undefined)
            this.write({
              id: frame.id,
              error: { code: -32601, message: 'Use Isles native question notifications' },
            });
          else this.handlers.notification(frame.method, frame.params);
        } else if (typeof frame.id === 'number') {
          const pending = this.pending.get(frame.id);
          if (!pending) return;
          this.pending.delete(frame.id);
          clearTimeout(pending.timer);
          if (frame.error)
            pending.reject(
              new DshRpcError(this.redactor.text(frame.error.message), frame.error.code),
            );
          else pending.resolve(frame.result);
        }
      } catch (error) {
        this.log.warn({ err: error }, 'DSH protocol frame failed');
        this.fail(new Error('DSH 原生协议消息无效，执行结果待核对'));
        void this.close();
      }
    });
    this.child.once('error', (error) => {
      this.log.warn({ err: error }, 'Failed to start DSH');
      this.fail(new Error('无法启动 DSH，请检查 CLI 路径'));
    });
    this.terminated = new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        stdout.close();
        stderr.close();
        this.log.debug({ code, signal }, 'DSH SDK exited');
        this.fail(new Error(`DSH 已退出（${code ?? signal ?? 'unknown'}）`));
        resolve();
      });
    });
  }
  private write(frame: Record<string, unknown>) {
    if (this.failed || !this.child.stdin.writable) throw new Error('DSH 连接已关闭');
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`, (error) => {
      if (error) this.fail(new Error('DSH 协议写入失败，结果待核对'));
    });
  }
  request(method: string, params: unknown, timeout = 30_000): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DSH ${method} 响应超时，结果待核对`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private fail(error: Error) {
    if (this.failed) return;
    this.failed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closing) this.handlers.exit(error);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      if (!this.failed) {
        try {
          await this.request('shutdown', {}, 5_000);
        } catch (error) {
          this.log.debug({ err: error }, 'DSH native shutdown incomplete');
        }
      }
      this.fail(new Error('DSH 连接已关闭'));
      await stopProcessTree(this.child, this.terminated);
    });
    return this.closing;
  }
}
