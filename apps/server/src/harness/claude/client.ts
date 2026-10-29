import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { Redactor } from '../../errors.js';
import { stopProcessTree } from '../shared/process.js';
import { MAX_NATIVE_FRAME_LENGTH } from '../shared/native-limits.js';
import type { Logger } from '../../logging.js';
import type { ClaudeCommand } from './executable.js';
import type { HarnessInputImage } from '../types.js';

export type ClaudeFrame = Record<string, unknown>;
export interface ClaudeUserOptions {
  waitForConsumption?: boolean;
  images?: HarnessInputImage[];
}
export interface ClaudeHandlers {
  event(frame: ClaudeFrame): void;
  request(id: string, request: ClaudeFrame): void;
  cancel(id: string): void;
  exit(error: Error): void;
}
export interface ClaudeConnection {
  control(subtype: string, params?: ClaudeFrame): Promise<unknown>;
  sendUser(
    sessionId: string,
    messageId: string,
    text: string,
    options?: ClaudeUserOptions,
  ): Promise<void>;
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
    {
      sessionId: string;
      waitForConsumption: boolean;
      resolve(): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
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
    private log: Logger,
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
    this.log.debug({ pid: this.child.pid }, 'Claude Code started');
    // Stderr is not an execution item. Native diagnostics can contain config/auth
    // material, so lines are redacted and logged only at debug level.
    createInterface({ input: this.child.stderr }).on('line', (line) =>
      this.log.debug({ stderr: this.redactor.text(line) }, 'Claude Code stderr'),
    );
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      if (this.closed) return;
      try {
        if (line.length > MAX_NATIVE_FRAME_LENGTH) throw new Error('协议帧超出大小限制');
        this.receive(frameSchema.parse(JSON.parse(line)));
      } catch (error) {
        this.log.warn({ err: error }, 'Failed to process a Claude Code protocol frame');
        this.fail(new Error('Claude Code 原生协议消息无效，连接已关闭'));
        void this.close();
      }
    });
    this.child.once('error', (error) => {
      this.log.error({ err: error }, 'Failed to start Claude Code');
      this.fail(new Error('无法启动 Claude Code，请检查 CLI 路径'));
    });
    this.terminated = new Promise((resolve) =>
      this.child.once('close', (code, signal) => {
        this.log.debug({ code, signal }, 'Claude Code exited');
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
    if (frame.type === 'command_lifecycle' && frame.state === 'queued') {
      const id = frame.command_uuid;
      const pending = typeof id === 'string' ? this.inputs.get(id) : undefined;
      if (
        pending?.waitForConsumption &&
        frame.session_id === pending.sessionId &&
        !frame.parent_tool_use_id
      )
        // The transport receipt is known; consumption waits for a tool boundary or the
        // next native turn. Cancellation or connection close still settles this input.
        clearTimeout(pending.timer);
    }
    const id =
      frame.type === 'user' && frame.isReplay === true
        ? frame.uuid
        : frame.type === 'command_lifecycle' && frame.state === 'started'
          ? frame.command_uuid
          : frame.type === 'result'
            ? frame.user_message_uuid
            : undefined;
    const ids = new Set([
      id,
      ...(frame.type === 'result' && Array.isArray(frame.user_message_uuids)
        ? frame.user_message_uuids
        : []),
    ]);
    for (const id of ids) {
      if (typeof id !== 'string' || frame.parent_tool_use_id) continue;
      const pending = this.inputs.get(id);
      if (pending && frame.session_id === pending.sessionId) {
        this.inputs.delete(id);
        clearTimeout(pending.timer);
        pending.resolve();
      }
    }
    if (frame.type === 'command_lifecycle' && frame.state === 'cancelled') {
      const id = frame.command_uuid;
      const pending = typeof id === 'string' ? this.inputs.get(id) : undefined;
      if (pending && frame.session_id === pending.sessionId && !frame.parent_tool_use_id) {
        this.inputs.delete(id as string);
        clearTimeout(pending.timer);
        pending.reject(new ClaudeInputRejected('Claude Code 已撤回尚未消费的输入'));
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
  sendUser(
    sessionId: string,
    messageId: string,
    text: string,
    options: ClaudeUserOptions = {},
  ): Promise<void> {
    if (this.inputs.has(messageId))
      return Promise.reject(new ClaudeInputRejected('Claude Code 输入 UUID 已在投递中'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inputs.delete(messageId);
        reject(new Error('Claude Code 输入确认超时，结果待核对'));
      }, 60_000);
      this.inputs.set(messageId, {
        sessionId,
        waitForConsumption: options.waitForConsumption === true,
        resolve,
        reject,
        timer,
      });
      try {
        this.send({
          type: 'user',
          uuid: messageId,
          session_id: sessionId,
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: options.images?.length
              ? [
                  { type: 'text', text },
                  ...options.images.flatMap((image) => [
                    { type: 'text', text: image.label },
                    {
                      type: 'image',
                      source: { type: 'base64', media_type: image.mimeType, data: image.data },
                    },
                  ]),
                ]
              : text,
          },
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
    await stopProcessTree(this.child, this.terminated);
  }
}
