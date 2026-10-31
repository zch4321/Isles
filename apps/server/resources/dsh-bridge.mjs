import { createRequire } from 'node:module';
import { Console } from 'node:console';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { setImmediate } from 'node:timers';
import { additionalRoots } from './dsh-shared-roots.mjs';

// Resolve against the installed carrier, including Desktop's bundled runtime.
// The plugin itself is a deployment resource and has no npm dependency tree.
const carrierRequire = createRequire(process.argv[1]);
const native = (name) => import(pathToFileURL(carrierRequire.resolve(name)).href);
const [
  { JsonRpcLineTransport },
  { createUserMessage, BlockAssembler },
  { installModelSelection },
  { UserQuestionError },
  { carrierKeyOf },
] = await Promise.all([
  native('@deepseek-ai/dsh-sdk-protocol'),
  native('@deepseek-ai/dsh-llm'),
  native('@deepseek-ai/dsh-agent'),
  native('@deepseek-ai/dsh-user-questions'),
  native('@deepseek-ai/dsh-scope'),
]);

export const name = 'isles-dsh-bridge';
export const inject = ['agents', 'llm', 'tools', 'sdkAppStartup', 'permissionPresets', 'approval'];

const inputId = (message) =>
  message.source?.kind === 'user' &&
  typeof message.source.rpcId === 'string' &&
  message.source.rpcId.startsWith('isles:')
    ? message.source.rpcId.slice(6)
    : undefined;
const rejection = (reason, code) => ({
  rejected: true,
  reason,
  ...(code === undefined ? {} : { code }),
});
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const textOf = (blocks = []) =>
  blocks
    .map((block) => {
      if (typeof block.text === 'string') return block.text;
      if (block.type === 'tool-call') return `${block.name}: ${block.arguments}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');

/** One native runtime, with externally controlled root sessions and native inboxes. */
export function apply(ctx, config = {}) {
  const output = config.output ?? process.stdout;
  const transport = new JsonRpcLineTransport(config.input ?? process.stdin, output);
  const sessions = new Map();
  const questions = new Map();
  const permissions = new Map();
  const creations = new Map();
  const subagents = new Map();
  const seenSubagents = new Set();
  const disposers = [];
  let stopping = false;
  let shutdownTask;
  let exitTask;
  const ready = () => ctx.get('loader')?.await();
  const emit = (rec, event, eventId, sourceSessionId = rec.id) =>
    transport.notify('isles/event', {
      rootSessionId: rec.id,
      sessionId: sourceSessionId,
      event,
      ...(eventId === undefined ? {} : { eventId }),
    });
  const contextUsage = (rec) => {
    try {
      const meter = ctx.get('tokenMeter');
      if (!meter || !rec.agent) return undefined;
      const measurement = meter.measure(rec.agent.session);
      return {
        usedTokens: measurement.totalTokens,
        maxTokens: rec.contextWindow ?? null,
        estimated:
          measurement.baseline.kind === 'estimated' || measurement.surfaceDeltaTokens !== 0,
      };
    } catch {
      // Provider diagnostics can contain credentials; metrics never abort the loop.
      ctx.logger.warn('Isles DSH context usage read failed');
      return undefined;
    }
  };
  const sessionInfo = (rec) => ({
    sessionId: rec.id,
    cwd: rec.cwd,
    contextUsage: contextUsage(rec),
  });
  const emitAssistant = (rec, turnId, step, blocks, status, eventId, type = 'item') => {
    for (const [blockType, itemType, prefix] of [
      ['text', 'agentMessage', 'assistant'],
      ['reasoning', 'reasoning', 'reasoning'],
    ]) {
      const text = textOf(blocks.filter((block) => block.type === blockType));
      if (!text) continue;
      emit(
        rec,
        {
          type,
          turnId,
          append: false,
          item: { id: `${prefix}:${turnId}:${step}`, type: itemType, status, text },
        },
        `${eventId}:${prefix}`,
      );
      if (type === 'item_delta') rec.streamKinds.get(`${turnId}:${step}`)?.add(prefix);
    }
  };
  const clearOwnPending = (rec) => {
    for (const message of [...rec.agent.inbox.nextStep, ...rec.agent.inbox.nextTurn]) {
      if (inputId(message) !== undefined) rec.agent.inbox.remove(message.id);
    }
  };
  const record = (agent) => {
    const rec = sessions.get(String(agent.session.id));
    return rec?.agent === agent ? rec : undefined;
  };
  // Native ownership, rather than durable fork lineage, identifies live children.
  const ownedRecord = (agent) => {
    const seen = new Set();
    for (let current = agent; current && !seen.has(current);) {
      if (ctx.agents.get(current.id) !== current) return;
      seen.add(current);
      const rec = record(current);
      if (rec) return rec;
      current = ctx.agents.list().find((parent) => ctx.agents.isOwnedBy(current.id, parent));
    }
  };
  const setPermissions = (rec, agent) =>
    ctx.permissionPresets.set(
      agent.session,
      rec.dangerFullAccess ? 'danger-full-access' : 'workspace-write',
    );
  const activityOf = (agent) => {
    const rec = record(agent);
    if (rec?.activeTurn !== undefined) return { rec, sessionId: rec.id, turnId: rec.activeTurn };
    for (const run of subagents.values())
      if (run.local && ctx.agents.get(run.id) === agent)
        return { rec: run.rec, sessionId: String(run.id), turnId: run.turnId };
  };
  disposers.push(
    ctx.on(
      'subagent/start',
      function (info) {
        const parent = carrierKeyOf(this);
        const rec = parent && ownedRecord(parent);
        if (!rec || stopping || seenSubagents.has(info.runId)) return;
        seenSubagents.add(info.runId);
        const run = { rec, parent, turnId: String(info.runId), ...info };
        subagents.set(info.runId, run);
        emit(
          rec,
          { type: 'turn_started', turnId: run.turnId },
          `${rec.id}:subagent:${info.runId}:started`,
          String(info.id),
        );
        emit(
          rec,
          {
            type: 'item',
            turnId: run.turnId,
            append: false,
            item: {
              id: `subagent:${info.runId}`,
              type: 'subagent',
              status: 'running',
              text: `${info.provider} · ${info.id}`,
            },
          },
          `${rec.id}:subagent:${info.runId}:start`,
          String(info.id),
        );
      },
      { global: true },
    ),
    ctx.on(
      'subagent/end',
      function (info) {
        const run = subagents.get(info.runId);
        if (
          !run ||
          run.parent !== carrierKeyOf(this) ||
          run.id !== info.id ||
          run.provider !== info.provider ||
          run.local !== info.local
        )
          return;
        subagents.delete(info.runId);
        expireInteractions(run.rec, run.turnId, String(run.id));
        const status =
          info.stopReason === 'completed'
            ? 'completed'
            : info.stopReason === 'aborted'
              ? 'interrupted'
              : 'failed';
        emit(
          run.rec,
          {
            type: 'item',
            turnId: run.turnId,
            append: false,
            item: {
              id: `subagent:${info.runId}`,
              type: 'subagent',
              status,
              text: `${info.provider} · ${info.id}\n${textOf(info.lastAssistantMessage) || info.stopReason}`,
            },
          },
          `${run.rec.id}:subagent:${info.runId}:end`,
          String(info.id),
        );
        emit(
          run.rec,
          {
            type: 'turn_completed',
            turnId: run.turnId,
            status,
            error: status === 'failed' ? `DSH 子代理执行结束：${info.stopReason}` : null,
          },
          `${run.rec.id}:subagent:${info.runId}:completed`,
          String(info.id),
        );
      },
      { global: true },
    ),
  );
  const expireInteractions = (rec, turnId, sessionId = rec.id) => {
    for (const pending of [...permissions.values()])
      if (pending.rec === rec && pending.sessionId === sessionId && pending.turnId === turnId)
        pending.finish('cancelled', true);
    for (const pending of [...questions.values()])
      if (pending.rec === rec && pending.turnId === turnId)
        pending.finish(new UserQuestionError('问题已取消', 'ASK_ABORTED'), undefined, true);
  };
  disposers.push(
    ctx.on(
      'agent/created',
      ({ agent }) => {
        const rec = ownedRecord(agent);
        if (rec) setPermissions(rec, agent);
      },
      { global: true },
    ),
    ctx.on(
      'agent/disposed',
      ({ agent }) => {
        for (const pending of [...permissions.values()])
          if (pending.agent === agent) pending.finish('cancelled', true);
      },
      { global: true },
    ),
  );
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'isles:shared-permissions',
      order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
      text: ({ agent }) => {
        const rec = agent && ownedRecord(agent);
        if (!rec || rec.dangerFullAccess) return '';
        return `Isles writable directories under workspace-write mode: ${JSON.stringify([rec.cwd, ...additionalRoots(config)])}. To request approval for another directory, retry with sandbox_permissions and justification in Isles.`;
      },
    });
  });
  const rejectInput = (rec, id, reason, eventId) => {
    const receipt = rec.inputs.get(id);
    if (!receipt || receipt.status === 'accepted' || receipt.status === 'rejected') return;
    receipt.status = 'rejected';
    receipt.reason = reason;
    emit(rec, { type: 'input_rejected', messageId: id, reason }, eventId);
  };

  disposers.push(
    ctx.on(
      'agent/inbox/claimed',
      ({ agent, message, turn }) => {
        const rec = record(agent);
        const id = inputId(message);
        if (!rec || id === undefined) return;
        const receipt = rec.inputs.get(id);
        if (receipt) {
          receipt.turnId = String(turn);
          receipt.status = 'claimed';
        }
      },
      { global: true },
    ),
  );
  disposers.push(
    ctx.on(
      'agent/inbox/discarded',
      ({ agent, message }) => {
        const rec = record(agent);
        const id = inputId(message);
        if (rec && id !== undefined)
          rejectInput(rec, id, '输入已取消', `${rec.id}:discard:${message.id}`);
      },
      { global: true },
    ),
  );
  disposers.push(
    ctx.on(
      'session/event',
      (session, nativeEvent) => {
        const rec = sessions.get(String(session.id));
        if (!rec || rec.agent?.session !== session) return;
        const data = nativeEvent.data;
        const eventId = `${rec.id}:${nativeEvent.seq}`;
        if (nativeEvent.type === 'request/context') rec.contextWindow = data.contextWindow;
        if (
          nativeEvent.surfaceOp !== undefined ||
          ['request/context', 'request/header', 'compaction/end', 'image/offload'].includes(
            nativeEvent.type,
          )
        ) {
          const usage = contextUsage(rec);
          if (usage) emit(rec, { type: 'context_usage', usage }, `${eventId}:context`);
        }
        if (nativeEvent.type === 'turn/start') {
          rec.activeTurn = String(data.turn);
          emit(rec, { type: 'turn_started', turnId: rec.activeTurn }, eventId);
        } else if (nativeEvent.type === 'turn/end') {
          const turnId = String(data.turn);
          expireInteractions(rec, turnId);
          // A steer can remain queued when the current turn aborts or closes.
          // Cancel it durably before publishing completion; it must not silently
          // become input for a later native turn.
          clearOwnPending(rec);
          for (const [id, receipt] of rec.inputs) {
            if (receipt.status === 'claimed' && receipt.turnId === turnId)
              rejectInput(rec, id, '本次执行未接收该输入', `${eventId}:input:${id}`);
          }
          if (rec.activeTurn === turnId) rec.activeTurn = undefined;
          rec.streamKinds.clear();
          const kind = data.reason?.kind;
          emit(
            rec,
            {
              type: 'turn_completed',
              turnId,
              status:
                kind === 'aborted' ? 'interrupted' : kind === 'completed' ? 'completed' : 'failed',
              error:
                kind === 'error'
                  ? (data.reason.error?.message ?? 'DSH 执行失败')
                  : kind === 'completed' || kind === 'aborted'
                    ? null
                    : `DSH 执行结束：${kind ?? 'unknown'}`,
            },
            eventId,
          );
        } else if (nativeEvent.type === 'user/message') {
          const id = inputId(data);
          const receipt = id === undefined ? undefined : rec.inputs.get(id);
          // Claim identifies the owner; user/message proves admission past pre-step hooks.
          if (receipt?.status === 'claimed' && receipt.turnId !== undefined) {
            receipt.status = 'accepted';
            emit(rec, { type: 'input_accepted', messageId: id, turnId: receipt.turnId }, eventId);
          }
        } else if (nativeEvent.type === 'assistant/message') {
          emitAssistant(
            rec,
            String(data.turn),
            data.step,
            data.message.content,
            data.interrupted ? 'interrupted' : 'completed',
            eventId,
          );
          rec.streamKinds.delete(`${data.turn}:${data.step}`);
        } else if (nativeEvent.type === 'tool/call') {
          const type = data.name.startsWith('mcp__') ? 'mcpToolCall' : 'toolCall';
          rec.tools.set(String(data.callId), type);
          emit(
            rec,
            {
              type: 'item',
              turnId: String(data.turn),
              append: false,
              item: {
                id: String(data.callId),
                type,
                status: 'running',
                text: `${data.name}: ${data.arguments}`,
              },
            },
            eventId,
          );
        } else if (nativeEvent.type === 'tool/result') {
          emit(
            rec,
            {
              type: 'item',
              turnId: String(data.turn),
              append: false,
              item: {
                id: String(data.message.source.callId),
                type: rec.tools.get(String(data.message.source.callId)) ?? 'toolCall',
                status: data.message.isError ? 'failed' : 'completed',
                text: textOf(data.message.content),
              },
            },
            eventId,
          );
        }
      },
      { global: true },
    ),
  );

  disposers.push(
    ctx.on(
      'agent/assistant-stream',
      ({ agent, frame }) => {
        const rec = record(agent);
        if (!rec) return;
        if (frame.type === 'start') {
          const turnId = String(frame.turn);
          const key = `${turnId}:${frame.step}`;
          for (const prefix of rec.streamKinds.get(key) ?? [])
            emit(
              rec,
              {
                type: 'item_delta',
                turnId,
                append: false,
                item: {
                  id: `${prefix}:${turnId}:${frame.step}`,
                  type: prefix === 'reasoning' ? 'reasoning' : 'agentMessage',
                  status: 'running',
                  text: '',
                },
              },
              `${rec.id}:stream:${frame.attemptId}:${frame.revision}:reset:${prefix}`,
            );
          const emitted = new Set();
          rec.streamKinds.set(key, emitted);
          rec.streams.set(frame.attemptId, {
            turnId,
            step: frame.step,
            assembler: new BlockAssembler(),
            emitted,
          });
        }
        const stream = rec.streams.get(frame.attemptId);
        if (!stream) return;
        if (frame.type === 'chunk') {
          stream.assembler.push(frame.chunk);
          if (
            (frame.chunk.type === 'text-delta' || frame.chunk.type === 'reasoning-delta') &&
            frame.chunk.text !== ''
          ) {
            const reasoning = frame.chunk.type === 'reasoning-delta';
            const prefix = reasoning ? 'reasoning' : 'assistant';
            emit(
              rec,
              {
                type: 'item_delta',
                turnId: stream.turnId,
                // Retries keep turn/step identity but start a fresh native attempt.
                append: stream.emitted.has(prefix),
                item: {
                  id: `${prefix}:${stream.turnId}:${stream.step}`,
                  type: reasoning ? 'reasoning' : 'agentMessage',
                  status: 'running',
                  text: frame.chunk.text,
                },
              },
              `${rec.id}:stream:${frame.attemptId}:${frame.revision}:${prefix}`,
            );
            stream.emitted.add(prefix);
          }
        } else if (frame.type === 'end') {
          if (frame.outcome.kind !== 'committed' || frame.outcome.eventType !== 'assistant/message')
            emitAssistant(
              rec,
              stream.turnId,
              stream.step,
              stream.assembler.interruptedBlocks(),
              frame.outcome.kind === 'committed' ? 'completed' : 'failed',
              `${rec.id}:stream:${frame.attemptId}:${frame.revision}`,
              'item_delta',
            );
          rec.streams.delete(frame.attemptId);
        }
      },
      { global: true },
    ),
  );

  // DSH owns the approval/asked + approval/decided audit pair and the one-shot
  // sandbox grant. Isles answers the standard waterfall without replacing it.
  disposers.push(
    ctx.on(
      'approval/request',
      (request, next) => {
        const activity = activityOf(request.agent);
        if (!activity || activity.rec.interrupting || stopping) return next();
        const { rec, turnId, sessionId } = activity;
        const requestId = randomUUID();
        return new Promise((resolveAnswer) => {
          const finish = (outcome, expired = false) => {
            if (!permissions.delete(requestId)) return;
            request.signal?.removeEventListener('abort', aborted);
            if (expired)
              emit(rec, { type: 'question_expired', turnId, requestId }, undefined, sessionId);
            resolveAnswer(outcome);
          };
          const aborted = () => finish('cancelled', true);
          permissions.set(requestId, { rec, agent: request.agent, sessionId, turnId, finish });
          request.signal?.addEventListener('abort', aborted, { once: true });
          if (request.signal?.aborted) return aborted();
          const reason =
            request.displayReason?.zh ?? request.reason ?? `允许本次 ${request.toolName} 操作`;
          const call =
            request.callId === undefined
              ? undefined
              : request.agent.session
                  .snapshotEvents()
                  .findLast(
                    (event) =>
                      event.type === 'tool/call' &&
                      String(event.data.callId) === String(request.callId),
                  );
          transport.notify('isles/permission', {
            rootSessionId: rec.id,
            sessionId,
            turnId,
            requestId,
            text:
              `${reason}\n\n工具：${request.toolName}` +
              (call ? `\n操作：${call.data.arguments}` : ''),
          });
        });
      },
      { global: true },
    ),
  );

  // The standard native question waterfall remains the owner of the tool wait.
  disposers.push(
    ctx.on(
      'user-questions/request',
      (request, next) => {
        const rec = request.agent && record(request.agent);
        if (!rec || rec.activeTurn === undefined) return next();
        const requestId = randomUUID();
        return new Promise((resolveAnswer, rejectAnswer) => {
          const hold = new globalThis.AbortController();
          const turnId = rec.activeTurn;
          const finish = (error, answer, expired = false) => {
            if (!questions.delete(requestId)) return;
            hold.abort();
            request.signal?.removeEventListener('abort', aborted);
            if (expired) emit(rec, { type: 'question_expired', turnId, requestId });
            if (error) rejectAnswer(error);
            else resolveAnswer(answer);
          };
          const aborted = () =>
            finish(new UserQuestionError('问题已取消', 'ASK_ABORTED'), undefined, true);
          questions.set(requestId, { rec, turnId, nativeQuestions: request.questions, finish });
          request.signal?.addEventListener('abort', aborted, { once: true });
          if (request.signal?.aborted) {
            aborted();
            return;
          }
          if (request.wait?.timed) {
            // Hold a native timed foreground wait while Isles displays the question.
            void (async () => {
              for await (const frame of ctx.userQuestions.attachWait(
                request.agent,
                request.wait.callId,
                hold.signal,
              )) {
                void frame;
              }
            })().catch((error) => finish(error));
          }
          transport.notify('isles/question', {
            rootSessionId: rec.id,
            sessionId: rec.id,
            turnId: rec.activeTurn,
            requestId,
            questions: request.questions.map((question) => ({
              id: question.id,
              header: question.header ?? '',
              question: question.detail
                ? `${question.question}\n\n${question.detail}`
                : question.question,
              isOther: true,
              isSecret: false,
              multiSelect: question.multiSelect ?? false,
              options:
                question.options?.map((option) => ({
                  label: option.label,
                  description: option.description ?? '',
                })) ?? null,
            })),
          });
        });
      },
      { global: true },
    ),
  );

  async function validateSelection(selection) {
    if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string')
      throw new Error('DSH 模型选择缺少 provider 或 model');
    await ctx.llm.resolveCallConfig(selection);
    // resolveCallConfig returns request controls only. Capacity belongs to the
    // adapter's resolved model metadata, also available before a resumed call.
    let contextWindow;
    try {
      const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model);
      contextWindow = info.context?.contextWindow;
    } catch {
      ctx.logger.warn('Isles DSH context model read failed');
    }
    return { selection: { ...selection }, contextWindow };
  }
  function recoverInputs(rec) {
    let turnId;
    const pending = { 'next-step': [], 'next-turn': [] };
    for (const event of rec.agent.session.snapshotEvents()) {
      if (event.type === 'turn/start') turnId = String(event.data.turn);
      if (event.type === 'agent/inbox/spliced') {
        const splice = event.data;
        const removed = pending[splice.target].splice(
          splice.start,
          splice.removedCount ?? 0,
          ...splice.inserted,
        );
        for (const message of splice.inserted) {
          const id = inputId(message);
          if (id !== undefined) rec.inputs.set(id, { nativeId: message.id, status: 'queued' });
        }
        for (const message of removed) {
          const id = inputId(message);
          if (id === undefined) continue;
          const receipt = rec.inputs.get(id);
          receipt.status = splice.outcome === 'canceled' ? 'rejected' : 'claimed';
          receipt.reason = splice.outcome === 'canceled' ? '输入已取消' : undefined;
          receipt.turnId = turnId;
        }
      }
      if (event.type === 'user/message') {
        const id = inputId(event.data);
        if (id !== undefined)
          rec.inputs.set(id, { nativeId: event.data.id, status: 'accepted', turnId });
      }
      if (event.type === 'turn/end') {
        for (const receipt of rec.inputs.values()) {
          if (receipt.status === 'claimed' && receipt.turnId === String(event.data.turn)) {
            receipt.status = 'rejected';
            receipt.reason = '本次执行未接收该输入';
          }
        }
      }
    }
    // Previously unconsumed Isles work belongs to a disconnected invocation.
    // Cancel it durably before the resumed root can be woken by a new prompt.
    clearOwnPending(rec);
  }
  async function openSession(params, resume) {
    await ready();
    if (stopping) throw new Error('DSH 正在关闭');
    // Loader settlement also includes failed optional plugins. The official
    // tools.get(name) global view proves the MCP tool actually registered.
    if (ctx.tools.get('mcp__isles__send_message') === undefined)
      return rejection('Isles MCP 尚未就绪，请检查 Isles 服务与连接配置');
    if (typeof params.sessionId !== 'string' || !params.sessionId)
      throw new Error('缺少 sessionId');
    if (typeof params.dangerFullAccess !== 'boolean') throw new Error('缺少 DSH 权限模式');
    const existing = sessions.get(params.sessionId);
    if (existing?.handle) {
      if (existing.cwd !== resolve(params.cwd))
        throw new Error('DSH 会话工作目录与 Agent 工作目录不一致');
      existing.dangerFullAccess = params.dangerFullAccess;
      setPermissions(existing, existing.agent);
      return sessionInfo(existing);
    }
    if (creations.has(params.sessionId)) return creations.get(params.sessionId);
    const task = (async () => {
      const resolved = await validateSelection(params.selection);
      const selection = { current: resolved.selection };
      const rec = {
        id: params.sessionId,
        cwd: resolve(params.cwd),
        dangerFullAccess: params.dangerFullAccess,
        selection,
        inputs: new Map(),
        streams: new Map(),
        streamKinds: new Map(),
        tools: new Map(),
        interrupting: false,
        contextWindow: resolved.contextWindow,
      };
      sessions.set(rec.id, rec);
      try {
        const options = {
          agentOptions: selection.current,
          setup(agentCtx, agent) {
            rec.agent = agent;
            if (resume && resolve(agent.session.header.cwd ?? rec.cwd) !== rec.cwd)
              throw new Error('DSH 会话工作目录与 Agent 工作目录不一致');
            installModelSelection(agentCtx, selection);
            if (resume) recoverInputs(rec);
          },
        };
        rec.handle = await (resume
          ? ctx.agents.resume({ ...options, resumeSessionId: rec.id })
          : ctx.agents.create({ ...options, sessionId: rec.id, meta: { cwd: rec.cwd } }));
        setPermissions(rec, rec.agent);
        return sessionInfo(rec);
      } catch (error) {
        sessions.delete(rec.id);
        throw error;
      }
    })();
    creations.set(params.sessionId, task);
    try {
      return await task;
    } finally {
      creations.delete(params.sessionId);
    }
  }
  function liveSession(id) {
    const rec = sessions.get(id);
    return !stopping && rec?.handle && ctx.agents.get(rec.agent.id) === rec.agent ? rec : undefined;
  }
  async function admit(params, steer) {
    const rec = liveSession(params.sessionId);
    if (!rec) return rejection('DSH 会话当前不可用');
    if (
      typeof params.messageId !== 'string' ||
      !params.messageId ||
      typeof params.text !== 'string' ||
      !params.text.trim()
    )
      return rejection('输入需要 messageId 和非空文本');
    if (params.images !== undefined && steer) return rejection('追加消息使用文本和图片路径');
    if (params.images !== undefined && !Array.isArray(params.images))
      return rejection('图片信息无效，请检查格式和内容');
    const images = params.images ?? [];
    if (
      images.some(
        (image) =>
          !image ||
          typeof image !== 'object' ||
          typeof image.id !== 'string' ||
          !image.id.trim() ||
          typeof image.path !== 'string' ||
          !image.path.trim() ||
          typeof image.label !== 'string' ||
          !image.label.trim() ||
          !imageTypes.has(image.mimeType) ||
          typeof image.data !== 'string' ||
          !image.data,
      )
    )
      return rejection('图片信息无效，请检查格式和内容');
    if (steer && (rec.activeTurn === undefined || rec.activeTurn !== params.expectedTurnId))
      return rejection('目标执行已经结束');
    const prior = rec.inputs.get(params.messageId);
    if (prior) {
      if (prior.status === 'rejected') return rejection(prior.reason ?? '输入已取消');
      if (prior.status === 'accepted') return rejection('该输入批次已接收，重复投递已拒绝');
      return { sessionId: rec.id, messageId: params.messageId };
    }
    let selection;
    if (!steer && params.selection) {
      try {
        selection = await validateSelection(params.selection);
      } catch (error) {
        return rejection(error instanceof Error ? error.message : String(error));
      }
    }
    let imageRefs = [];
    if (images.length) {
      const attachments = ctx.get('attachments');
      if (!attachments) return rejection('DSH 图片服务尚未就绪');
      const route = selection?.selection ?? rec.selection.current;
      let model;
      try {
        model = await ctx.llm.resolveModelInfo(route.provider, route.model);
      } catch {
        return rejection('DSH 模型信息暂不可用，请重试');
      }
      if (model.inputModalities !== undefined && !model.inputModalities.includes('image'))
        return rejection('请选择支持图片输入的 DSH 模型并恢复 Agent', 'image_input_unsupported');
      try {
        const uploads = images.map((image) => {
          const data = Buffer.from(image.data, 'base64');
          if (data.toString('base64') !== image.data) throw new Error('invalid image encoding');
          return { data, mediaType: image.mimeType };
        });
        imageRefs = await attachments.saveImages(uploads);
        if (imageRefs.length !== images.length) throw new Error('invalid image admission');
      } catch {
        return rejection('DSH 图片保存失败，请检查图片格式、大小和磁盘状态');
      }
    }
    // No asynchronous boundary between CAS and the native inbox mutation.
    if (liveSession(params.sessionId) !== rec) return rejection('DSH 会话当前不可用');
    if (rec.interrupting) return rejection('DSH 正在停止当前执行');
    if (steer && (rec.activeTurn === undefined || rec.activeTurn !== params.expectedTurnId))
      return rejection('目标执行已经结束');
    if (params.expectedTurnId !== undefined && rec.activeTurn !== params.expectedTurnId)
      return rejection('目标执行已经结束');
    const concurrent = rec.inputs.get(params.messageId);
    if (concurrent)
      return concurrent.status === 'rejected'
        ? rejection(concurrent.reason ?? '输入已取消')
        : concurrent.status === 'accepted'
          ? rejection('该输入批次已接收，重复投递已拒绝')
          : { sessionId: rec.id, messageId: params.messageId };
    if (!steer && rec.activeTurn !== undefined) return rejection('DSH 会话仍在执行');
    if (selection) {
      rec.selection.current = selection.selection;
      rec.contextWindow = selection.contextWindow;
    }
    const message = createUserMessage({
      source: { kind: 'user', rpcId: `isles:${params.messageId}` },
      content: [
        { type: 'text', text: params.text },
        ...images.flatMap((image, index) => [
          { type: 'text', text: `图片 ${image.id}（${image.label}）\n文件路径：${image.path}` },
          { type: 'image', attachment: imageRefs[index] },
        ]),
      ],
    });
    rec.inputs.set(params.messageId, { nativeId: message.id, status: 'queued' });
    // An exception after native enqueue is ambiguous and remains a RPC error.
    if (steer) rec.agent.steer(message);
    else rec.agent.followup(message);
    return { sessionId: rec.id, messageId: params.messageId };
  }
  async function interrupt(params) {
    const rec = liveSession(params.sessionId);
    if (!rec) return rejection('DSH 会话当前不可用');
    rec.interrupting = true;
    for (const pending of [...permissions.values()])
      if (pending.rec === rec) pending.finish('cancelled', true);
    for (const pending of [...questions.values()])
      if (pending.rec === rec)
        pending.finish(new UserQuestionError('问题已取消', 'ASK_ABORTED'), undefined, true);
    clearOwnPending(rec);
    rec.agent.cancel({ kind: 'user' }, { keepInbox: true });
    try {
      await ctx.get('subagents')?.drainDescendants([rec.agent]);
      await rec.agent.whenIdle();
    } finally {
      rec.interrupting = false;
    }
    return {};
  }
  function answerQuestion(params, reject) {
    const question = questions.get(String(params.requestId));
    if (!question) return rejection('问题已经结束');
    if (params.sessionId !== question.rec.id) return rejection('问题不属于该 DSH 会话');
    if (params.expectedTurnId !== question.turnId || question.rec.activeTurn !== question.turnId)
      return rejection('问题所属执行已经结束');
    if (reject)
      question.finish(new UserQuestionError(params.reason ?? '用户取消了问题', 'ASK_ABORTED'));
    else {
      const answers = params.answers;
      if (
        !answers ||
        question.nativeQuestions.some(
          (q) =>
            !Array.isArray(answers[q.id]?.answers) ||
            answers[q.id].answers.some((value) => typeof value !== 'string'),
        )
      )
        return rejection('请回答所有问题');
      question.finish(undefined, {
        answers: question.nativeQuestions.map((q) => {
          const values = answers[q.id].answers;
          const labels = new Set(q.options?.map((option) => option.label) ?? []);
          const custom = values.filter((value) => !labels.has(value)).join('\n');
          return {
            id: q.id,
            selected: custom && !q.multiSelect ? [] : values.filter((value) => labels.has(value)),
            ...(custom ? { custom } : {}),
          };
        }),
      });
    }
    return {};
  }
  function answerPermission(params, reject) {
    const pending = permissions.get(String(params.requestId));
    if (!pending) return rejection('权限请求已经结束');
    if (params.sessionId !== pending.sessionId) return rejection('权限请求不属于该 DSH 活动');
    const activity = activityOf(pending.agent);
    if (
      params.expectedTurnId !== pending.turnId ||
      activity?.turnId !== pending.turnId ||
      pending.rec.interrupting ||
      stopping ||
      ctx.agents.get(pending.agent.id) !== pending.agent
    )
      return rejection('权限请求所属执行已经结束');
    if (!reject && typeof params.allow !== 'boolean') return rejection('请选择允许本次或拒绝');
    pending.finish(reject ? 'rejected' : params.allow ? 'allowed-once' : 'rejected');
    return {};
  }
  async function shutdown() {
    return (shutdownTask ??= (async () => {
      stopping = true;
      await Promise.allSettled([...creations.values()]);
      for (const question of [...questions.values()])
        question.finish(new UserQuestionError('DSH 已关闭', 'ASK_ABORTED'), undefined, true);
      for (const pending of [...permissions.values()]) pending.finish('cancelled', true);
      for (const rec of sessions.values()) if (rec.agent) clearOwnPending(rec);
      for (const rec of sessions.values()) rec.agent?.cancel({ kind: 'user' }, { keepInbox: true });
      await ctx
        .get('subagents')
        ?.drainDescendants([...sessions.values()].map((rec) => rec.agent).filter(Boolean));
      await Promise.all([...sessions.values()].map((rec) => rec.handle?.dispose()));
      sessions.clear();
      subagents.clear();
      seenSubagents.clear();
      while (disposers.length) disposers.pop()();
      return {};
    })());
  }
  transport.onRequest(async (method, params) => {
    switch (method) {
      case 'isles/catalog': {
        await ready();
        if (params.requireMcp === true && ctx.tools.get('mcp__isles__send_message') === undefined)
          return rejection('Isles MCP 尚未就绪，请检查 Isles 服务与连接配置');
        const models = [];
        for (const provider of ctx.llm.listProviders()) {
          for (const listed of await ctx.llm.listModels(provider.id)) {
            const info = await ctx.llm.resolveModelInfo(provider.id, listed.id);
            models.push({
              provider: info.provider,
              id: info.id,
              name: info.name,
              ...(info.description === undefined ? {} : { description: info.description }),
              ...(info.reasoning === undefined ? {} : { reasoning: info.reasoning }),
            });
          }
        }
        const defaultSelection = ctx.get('agentDefaultModel')?.currentSelection();
        return { models, ...(defaultSelection === undefined ? {} : { defaultSelection }) };
      }
      case 'isles/session/create':
        return openSession(params, false);
      case 'isles/session/resume':
        return openSession(params, true);
      case 'isles/session/submit':
        return admit(params, false);
      case 'isles/session/steer':
        return admit(params, true);
      case 'isles/session/interrupt':
        return interrupt(params);
      case 'isles/question/answer':
        return answerQuestion(params, false);
      case 'isles/question/reject':
        return answerQuestion(params, true);
      case 'isles/permission/answer':
        return answerPermission(params, false);
      case 'isles/permission/reject':
        return answerPermission(params, true);
      case 'shutdown': {
        const result = await shutdown();
        setImmediate(() => {
          exitTask ??= (async () => {
            await transport.flush();
            await ctx.root.fiber.dispose();
            (config.exit ?? process.exit)(0);
          })();
        });
        return result;
      }
      default:
        throw new Error(`未知 Isles DSH 方法：${method}`);
    }
  });
  ctx.effect(() => {
    // Account model discovery and background refresh use console.info. Keep
    // diagnostics on stderr while this bridge owns stdout for JSON-RPC frames.
    let restoreConsole = () => {};
    if (output === process.stdout) {
      const diagnostics = new Console({ stdout: process.stderr, stderr: process.stderr });
      const nativeConsole = globalThis.console;
      const previous = new Map(
        ['log', 'info', 'debug'].map((method) => [method, nativeConsole[method]]),
      );
      for (const method of previous.keys()) nativeConsole[method] = diagnostics[method];
      restoreConsole = () => {
        for (const [method, original] of previous)
          if (nativeConsole[method] === diagnostics[method]) nativeConsole[method] = original;
      };
    }
    try {
      transport.start();
    } catch (error) {
      restoreConsole();
      throw error;
    }
    return async () => {
      try {
        await shutdown();
      } finally {
        try {
          transport.close();
        } finally {
          restoreConsole();
        }
      }
    };
  }, 'isles.jsonrpc.serve');
}
