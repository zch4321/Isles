import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { Redactor } from '../errors.js';
import type { ClaudeCommand } from './executable.js';

export type ClaudeFrame = Record<string, unknown>;
export interface ClaudeHandlers {
  event(frame: ClaudeFrame): void;
  request(id: string, request: ClaudeFrame): void;
  cancel(id: string): void;
  exit(error: Error): void;
}
export interface ClaudeConnection {
  control(subtype: string, params?: ClaudeFrame): Promise<unknown>;
  sendUser(sessionId: string, messageId: string, text: string): Promise<void>;
  respond(id: string, response: ClaudeFrame): void;
  reject(id: string, reason: string): void;
  close(): Promise<void>;
}
export class ClaudeInputRejected extends Error {}
export class ClaudeControlError extends Error {}
const frameSchema = z.object({ type: z.string() }).passthrough();
const responseSchema = z.object({
  subtype: z.string(),
  request_id: z.string(),
  response: z.unknown().optional(),
  error: z.string().optional(),
});
const requestSchema = z.object({
  request_id: z.string(),
  request: z.record(z.string(), z.unknown()),
});

/** The CLI's bidirectional stream protocol, without an Agent SDK dependency. */
export class ClaudeClient implements ClaudeConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly terminated: Promise<void>;
  private readonly controls = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private readonly inputs = new Map<
    string,
    { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private closed = false;
  private closing = false;
  private exitError: Error | undefined;
  constructor(
    command: ClaudeCommand,
    args: string[],
    workspace: string,
    env: Record<string, string>,
    private handlers: ClaudeHandlers,
    private redactor: Redactor,
  ) {
    this.child = spawn(
      command.file,
      [
        ...command.args,
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--replay-user-messages',
        '--forward-subagent-text',
        ...args,
      ],
      {
        cwd: workspace,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    );
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      if (this.closed) return;
      try {
        if (line.length > 8_000_000) throw new Error('协议帧超出大小限制');
        this.receive(frameSchema.parse(JSON.parse(line)));
      } catch {
        this.fail(new Error('Claude Code 原生协议消息无效，连接已关闭'));
        void this.close();
      }
    });
    this.child.once('error', () => this.fail(new Error('无法启动 Claude Code，请检查 CLI 路径')));
    this.terminated = new Promise((resolve) =>
      this.child.once('close', (code) => {
        lines.close();
        this.fail(this.exitError ?? new Error(`Claude Code 已退出（${code ?? 'signal'}）`));
        resolve();
      }),
    );
  }
  private receive(frame: ClaudeFrame) {
    if (frame.type === 'result' && frame.is_error === true && !frame.user_message_uuid) {
      const message =
        typeof frame.result === 'string'
          ? frame.result
          : Array.isArray(frame.errors)
            ? frame.errors.filter((value) => typeof value === 'string').join('\n')
            : 'Claude Code 启动失败';
      this.exitError = new Error(this.redactor.text(message));
    }
    if (frame.type === 'control_response') {
      const response = responseSchema.parse(frame.response);
      const pending = this.controls.get(response.request_id);
      if (!pending) return;
      this.controls.delete(response.request_id);
      clearTimeout(pending.timer);
      if (response.subtype === 'error')
        pending.reject(
          new ClaudeControlError(this.redactor.text(response.error ?? 'Claude 控制请求失败')),
        );
      else pending.resolve(response.response ?? {});
      return;
    }
    if (frame.type === 'control_request') {
      const request = requestSchema.parse(frame);
      this.handlers.request(request.request_id, request.request);
      return;
    }
    if (frame.type === 'control_cancel_request') {
      if (typeof frame.request_id === 'string') this.handlers.cancel(frame.request_id);
      return;
    }
    const id =
      frame.type === 'user' && frame.isReplay === true
        ? frame.uuid
        : frame.type === 'command_lifecycle' && frame.state === 'started'
          ? frame.command_uuid
          : frame.type === 'result'
            ? frame.user_message_uuid
            : undefined;
    if (typeof id === 'string') {
      const pending = this.inputs.get(id);
      if (pending) {
        this.inputs.delete(id);
        clearTimeout(pending.timer);
        pending.resolve();
      }
    }
    this.handlers.event(frame);
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.controls.values(), ...this.inputs.values()]) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.controls.clear();
    this.inputs.clear();
    if (!this.closing) this.handlers.exit(error);
  }
  private send(frame: unknown) {
    if (this.closed || !this.child.stdin.writable)
      throw new ClaudeInputRejected('Claude Code 连接已关闭');
    this.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
      if (error) this.fail(new Error('Claude Code 协议写入失败，结果待核对'));
    });
  }
  control(subtype: string, params: ClaudeFrame = {}): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(id);
        reject(new Error(`Claude Code ${subtype} 响应超时，结果待核对`));
      }, 60_000);
      this.controls.set(id, { resolve, reject, timer });
      try {
        this.send({ type: 'control_request', request_id: id, request: { subtype, ...params } });
      } catch (error) {
        clearTimeout(timer);
        this.controls.delete(id);
        reject(error);
      }
    });
  }
  sendUser(sessionId: string, messageId: string, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inputs.delete(messageId);
        reject(new Error('Claude Code 输入确认超时，结果待核对'));
      }, 60_000);
      this.inputs.set(messageId, { resolve, reject, timer });
      try {
        this.send({
          type: 'user',
          uuid: messageId,
          session_id: sessionId,
          parent_tool_use_id: null,
          message: { role: 'user', content: text },
        });
      } catch (error) {
        clearTimeout(timer);
        this.inputs.delete(messageId);
        reject(error);
      }
    });
  }
  respond(id: string, response: ClaudeFrame) {
    this.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: id, response },
    });
  }
  reject(id: string, reason: string) {
    this.send({
      type: 'control_response',
      response: { subtype: 'error', request_id: id, error: reason },
    });
  }
  async close() {
    if (this.closing) return this.terminated;
    this.closing = true;
    this.fail(new Error('Claude Code 连接已关闭'));
    const signal = (name: NodeJS.Signals) => {
      if (!this.child.pid) return;
      try {
        if (process.platform === 'win32') this.child.kill(name);
        else process.kill(-this.child.pid, name);
      } catch {
        /* The owned process already exited. */
      }
    };
    this.child.stdin.end();
    if (
      process.platform === 'win32' &&
      this.child.pid &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      execFile(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(this.child.pid), '/T', '/F'],
        { windowsHide: true },
        (error) => {
          if (error) signal('SIGTERM');
        },
      );
    } else signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), 2_000);
    await this.terminated;
    clearTimeout(timer);
  }
}
