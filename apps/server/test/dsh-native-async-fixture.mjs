import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
const require = createRequire(process.argv[1]);
const { LlmAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
export const name = 'isles-async-child-fixture';
export const inject = ['llm', 'subagents', 'agents', 'tools'];
export function apply(ctx, config = {}) {
  const audit = (event) =>
    appendFileSync(process.env.ISLES_DSH_ASYNC_AUDIT, JSON.stringify(event) + '\n');
  class ScriptedAdapter extends LlmAdapter {
    async listModels(provider) {
      return [
        { provider, id: 'scripted', name: 'scripted', inputModalities: ['text', 'image'] },
        { provider, id: 'text-only', name: 'text-only', inputModalities: ['text'] },
      ];
    }
    async resolveModel(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        inputModalities: model === 'text-only' ? ['text'] : ['text', 'image'],
      };
    }
    async *stream(options) {
      const content = options.messages
        .filter((message) => message.role === 'user')
        .flatMap((message) => message.content);
      const images = await Promise.all(
        content
          .filter((block) => block.type === 'image')
          .map(async (block) => {
            const stored = await ctx.get('attachments').readImage(block.attachment);
            return {
              attachment: block.attachment,
              bytes: stored.data.byteLength,
              signature: Buffer.from(stored.data).subarray(0, 8).toString('hex'),
            };
          }),
      );
      audit({ type: 'scripted-stream', content, images });
      const text = 'scripted parent answer';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['isles-scripted'], new ScriptedAdapter());
  if (config.mcpMarker)
    ctx.tools.register({
      name: 'mcp__isles__send_message',
      description: 'Fixture readiness marker',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => null,
    });
  ctx.subagents.registerProvider({
    name: 'isles-scripted-child',
    capabilities: {
      agentOptions: false,
      agentPreset: false,
      outputSchema: false,
      depthLimit: false,
    },
    inheritsParentContext: false,
    async start() {
      const cancellation = new globalThis.AbortController();
      const result = delay(500, undefined, { signal: cancellation.signal }).then(
        () => ({
          output: [{ type: 'text', text: 'scripted child answer' }],
          stopReason: 'completed',
        }),
        (error) => {
          if (error.name !== 'AbortError') throw error;
          return { output: [], stopReason: 'aborted' };
        },
      );
      return {
        id: 'external-child',
        result,
        dispose: async () => {
          cancellation.abort();
          await result;
        },
      };
    },
  });
  let started = false;
  ctx.on(
    'agent/pre-step',
    async ({ agent }, next) => {
      if (!started) {
        started = true;
        await ctx.subagents.startActivation({
          provider: 'isles-scripted-child',
          label: 'Scripted child',
          signal: new globalThis.AbortController().signal,
          delivery: 'parent',
          request: { parent: agent, prompt: [{ type: 'text', text: 'child task' }] },
        });
      }
      return next();
    },
    { global: true },
  );
  ctx.on(
    'session/event',
    (session, event) => {
      if (['turn/start', 'turn/end'].includes(event.type))
        audit({ sessionId: session.id, type: event.type, data: event.data });
    },
    { global: true },
  );
  for (const type of ['subagent/start', 'subagent/end'])
    ctx.on(type, (info) => audit({ type, info }), { global: true });
}
