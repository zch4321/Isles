import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Redactor } from '../../errors.js';
import type { CliCommand } from '../shared/executable.js';
import { stopProcessTree } from '../shared/process.js';
import { MAX_NATIVE_FRAME_LENGTH } from '../shared/native-limits.js';
import type { Logger } from '../../logging.js';
import {
  ACP_PROTOCOL_VERSION,
  initializeResultSchema,
  rpcFrameSchema,
  type AcpRequestId,
} from './protocol.js';

export class AcpRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data: unknown,
  ) {
    super(message);
  }
}
export interface AcpHandlers {
  notification(method: string, params: unknown): void;
  request(id: AcpRequestId, method: string, params: unknown): void;
  exit(error: Error): void;
}
export interface AcpConnection {
  /** `timeout: null` waits for the response indefinitely, as prompt turns do. */
  request(method: string, params: unknown, options?: { timeout: number | null }): Promise<unknown>;
  notify(method: string, params: unknown): void;
  respond(id: AcpRequestId, result: unknown): void;
  reject(id: AcpRequestId, code: number, message: string): void;
  close(): Promise<void>;
}

/** JSON-RPC 2.0 over the agent's stdio, without an ACP SDK dependency. */
export class AcpClient implements AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly terminated: Promise<void>;
  private readonly pending = new Map<
    AcpRequestId,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout | undefined }
  >();
  private nextId = 0;
  private closed = false;
  private closing = false;
  constructor(
    private readonly name: string,
    command: CliCommand,
    args: string[],
    workspace: string,
    env: Record<string, string>,
    private readonly handlers: AcpHandlers,
    private readonly redactor: Redactor,
    private readonly log: Logger,
  ) {
    this.child = spawn(command.file, [...command.args, ...args], {
      cwd: workspace,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    this.log.debug({ pid: this.child.pid }, `${name} started`);
    // Stderr is not an execution item. Native diagnostics can contain config/auth
    // material, so lines are redacted and logged only at debug level.
    createInterface({ input: this.child.stderr }).on('line', (line) =>
      this.log.debug({ stderr: this.redactor.text(line) }, `${name} stderr`),
    );
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      if (this.closed || !line.trim()) return;
      try {
        if (line.length > MAX_NATIVE_FRAME_LENGTH) throw new Error('原生协议帧超出大小限制');
        const frame = rpcFrameSchema.parse(JSON.parse(line));
        if (frame.method) {
          if (frame.id !== undefined) this.handlers.request(frame.id, frame.method, frame.params);
          else this.handlers.notification(frame.method, frame.params);
        } else if (frame.id !== undefined) {
          const pending = this.pending.get(frame.id);
          if (!pending) return;
          this.pending.delete(frame.id);
          clearTimeout(pending.timer);
          if (frame.error)
            pending.reject(
              new AcpRpcError(
                this.redactor.text(frame.error.message),
                frame.error.code,
                frame.error.data,
              ),
            );
          else pending.resolve(frame.result);
        }
      } catch (error) {
        this.log.warn({ err: error }, `Failed to process a ${name} protocol frame`);
        this.fail(new Error(`${name} 原生协议消息无效，连接已关闭`));
        void this.close();
      }
    });
    this.child.once('error', (error) => {
      this.log.error({ err: error }, `Failed to start ${name}`);
      this.fail(new Error(`无法启动 ${name}，请检查 CLI 路径`));
    });
    this.terminated = new Promise((resolve) =>
      this.child.once('close', (code, signal) => {
        this.log.debug({ code, signal }, `${name} exited`);
        lines.close();
        this.fail(new Error(`${name} 已退出（${code ?? 'signal'}）`));
        resolve();
      }),
    );
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closing) this.handlers.exit(error);
  }
  private send(frame: Record<string, unknown>) {
    if (this.closed || !this.child.stdin.writable) throw new Error(`${this.name} 连接已关闭`);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`, (error) => {
      if (error) this.fail(new Error(`${this.name} 协议写入失败，结果待核对`));
    });
  }
  request(method: string, params: unknown, options = { timeout: 60_000 as number | null }) {
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        options.timeout === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`${this.name} ${method} 响应超时，结果待核对`));
            }, options.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method: string, params: unknown) {
    this.send({ method, params });
  }
  respond(id: AcpRequestId, result: unknown) {
    this.send({ id, result });
  }
  reject(id: AcpRequestId, code: number, message: string) {
    this.send({ id, error: { code, message } });
  }
  async close() {
    if (this.closing) return this.terminated;
    this.closing = true;
    this.fail(new Error(`${this.name} 连接已关闭`));
    await stopProcessTree(this.child, this.terminated);
  }
}

export type AcpClientFactory = (
  command: CliCommand,
  workspace: string,
  handlers: AcpHandlers,
  log: Logger,
) => AcpConnection;

/**
 * Isles answers native questions through forms. It offers no file system or terminal, so
 * agents use their own local tools.
 */
export const ACP_CLIENT_CAPABILITIES = { elicitation: { form: {} } };
export const ACP_CLIENT_INFO = { name: 'isles', title: 'Isles', version: '0.1.0' };

export async function initializeAcp(client: AcpConnection, name: string) {
  const result = initializeResultSchema.parse(
    await client.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: ACP_CLIENT_CAPABILITIES,
      clientInfo: ACP_CLIENT_INFO,
    }),
  );
  if (result.protocolVersion !== ACP_PROTOCOL_VERSION)
    throw new Error(
      `${name} 使用 ACP v${result.protocolVersion}，Isles 需要 v${ACP_PROTOCOL_VERSION}`,
    );
  return result;
}
