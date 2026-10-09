import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { setImmediate } from 'node:timers';

// Resolve against the installed carrier, including Desktop's bundled runtime.
// The plugin itself is a deployment resource and has no npm dependency tree.
const carrierRequire = createRequire(process.argv[1]);
const native = (name) => import(pathToFileURL(carrierRequire.resolve(name)).href);
const [
  { JsonRpcLineTransport },
  { createUserMessage, BlockAssembler },
  { installModelSelection },
  { UserQuestionError },
] = await Promise.all([
  native('@deepseek-ai/dsh-sdk-protocol'),
  native('@deepseek-ai/dsh-llm'),
  native('@deepseek-ai/dsh-agent'),
  native('@deepseek-ai/dsh-user-questions'),
]);

export const name = 'isles-dsh-bridge';
export const inject = ['agents', 'llm', 'tools', 'sdkAppStartup'];

const inputId = (message) =>
  message.source?.kind === 'user' &&
  typeof message.source.rpcId === 'string' &&
  message.source.rpcId.startsWith('isles:')
    ? message.source.rpcId.slice(6)
    : undefined;
const rejection = (reason) => ({ rejected: true, reason });
const textOf = (blocks = []) =>
  blocks
    .map((block) => {
      if (typeof block.text === 'string') return block.text;
      if (block.type === 'tool-call') return `${block.name}: ${JSON.stringify(block.arguments)}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');

/** One native runtime, with externally controlled root sessions and native inboxes. */
export function apply(ctx, config = {}) {
  const transport = new JsonRpcLineTransport(
    config.input ?? process.stdin,
    config.output ?? process.stdout,
  );
  const sessions = new Map();
  const questions = new Map();
  const creations = new Map();
  const disposers = [];
  let stopping = false;
  let shutdownTask;
  let exitTask;
  const ready = () => ctx.get('loader')?.await();
  const emit = (rec, event, eventId) =>
    transport.notify('isles/event', {
      sessionId: rec.id,
      event,
      ...(eventId === undefined ? {} : { eventId }),
    });
  const emitAssistant = (rec, turnId, step, blocks, status, eventId) => {
    for (const [blockType, itemType, prefix] of [
      ['text', 'agentMessage', 'assistant'],
      ['reasoning', 'reasoning', 'reasoning'],
    ]) {
      const text = textOf(blocks.filter((block) => block.type === blockType));
      if (!text) continue;
      emit(
        rec,
        {
          type: 'item',
          turnId,
          append: false,
          item: { id: `${prefix}:${turnId}:${step}`, type: itemType, status, text },
        },
        `${eventId}:${prefix}`,
      );
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
        if (nativeEvent.type === 'turn/start') {
          rec.activeTurn = String(data.turn);
          emit(rec, { type: 'turn_started', turnId: rec.activeTurn }, eventId);
        } else if (nativeEvent.type === 'turn/end') {
          const turnId = String(data.turn);
          // A steer can remain queued when the current turn aborts or closes.
          // Cancel it durably before publishing completion; it must not silently
          // become input for a later native turn.
          clearOwnPending(rec);
          for (const [id, receipt] of rec.inputs) {
            if (receipt.status === 'claimed' && receipt.turnId === turnId)
              rejectInput(rec, id, '本次执行未接收该输入', `${eventId}:input:${id}`);
          }
          if (rec.activeTurn === turnId) rec.activeTurn = undefined;
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
                text: `${data.name}: ${JSON.stringify(data.arguments)}`,
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
        if (frame.type === 'start')
          rec.streams.set(frame.attemptId, {
            turnId: String(frame.turn),
            step: frame.step,
            assembler: new BlockAssembler(),
          });
        const stream = rec.streams.get(frame.attemptId);
        if (!stream) return;
        if (frame.type === 'chunk') {
          stream.assembler.push(frame.chunk);
          if (frame.chunk.type === 'text-delta' || frame.chunk.type === 'reasoning-delta')
            emitAssistant(
              rec,
              stream.turnId,
              stream.step,
              stream.assembler.interruptedBlocks(),
              'running',
              `${rec.id}:stream:${frame.attemptId}:${frame.revision}`,
            );
        } else if (frame.type === 'end') {
          if (frame.outcome.kind !== 'committed' || frame.outcome.eventType !== 'assistant/message')
            emitAssistant(
              rec,
              stream.turnId,
              stream.step,
              stream.assembler.interruptedBlocks(),
              frame.outcome.kind === 'committed' ? 'completed' : 'failed',
              `${rec.id}:stream:${frame.attemptId}:${frame.revision}`,
            );
          rec.streams.delete(frame.attemptId);
        }
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
          const finish = (error, answer) => {
            if (!questions.delete(requestId)) return;
            hold.abort();
            request.signal?.removeEventListener('abort', aborted);
            if (error) rejectAnswer(error);
            else resolveAnswer(answer);
          };
          const aborted = () => finish(new UserQuestionError('问题已取消', 'ASK_ABORTED'));
          questions.set(requestId, { rec, nativeQuestions: request.questions, finish });
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
    return { ...selection };
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
    const existing = sessions.get(params.sessionId);
    if (existing?.handle) {
      if (existing.cwd !== resolve(params.cwd))
        throw new Error('DSH 会话工作目录与 Agent 工作目录不一致');
      return { sessionId: existing.id, cwd: existing.cwd };
    }
    if (creations.has(params.sessionId)) return creations.get(params.sessionId);
    const task = (async () => {
      const selection = { current: await validateSelection(params.selection) };
      const rec = {
        id: params.sessionId,
        cwd: resolve(params.cwd),
        selection,
        inputs: new Map(),
        streams: new Map(),
        tools: new Map(),
        interrupting: false,
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
        return { sessionId: rec.id, cwd: rec.cwd };
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
    if (selection) rec.selection.current = selection;
    const message = createUserMessage({
      source: { kind: 'user', rpcId: `isles:${params.messageId}` },
      content: [{ type: 'text', text: params.text }],
    });
    rec.inputs.set(params.messageId, { nativeId: message.id, status: 'queued' });
    // An exception after native enqueue is ambiguous and remains a RPC error.
    if (steer) rec.agent.steer(message);
    else rec.agent.followup(message);
    return { sessionId: rec.id, messageId: params.messageId };
  }
  async function interrupt(params) {
    const rec = liveSession(params.sessionId);
    if (!rec || rec.activeTurn === undefined || rec.activeTurn !== params.expectedTurnId)
      return rejection('目标执行已经结束');
    rec.interrupting = true;
    clearOwnPending(rec);
    rec.agent.cancel({ kind: 'user' }, { keepInbox: true });
    try {
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
  async function shutdown() {
    return (shutdownTask ??= (async () => {
      stopping = true;
      await Promise.allSettled([...creations.values()]);
      for (const question of [...questions.values()])
        question.finish(new UserQuestionError('DSH 已关闭', 'ASK_ABORTED'));
      for (const rec of sessions.values()) if (rec.agent) clearOwnPending(rec);
      await Promise.all([...sessions.values()].map((rec) => rec.handle?.dispose()));
      sessions.clear();
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
    transport.start();
    return async () => {
      await shutdown();
      transport.close();
    };
  }, 'isles.jsonrpc.serve');
}
