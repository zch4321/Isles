import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

interface Tool {
  function: { name: string; parameters: { properties?: Record<string, unknown> } };
}
interface Message {
  role: string;
  content: unknown;
}
interface Request {
  tools?: Tool[];
  messages: Message[];
}

/** Scripted model responses exercise the real OpenCode CLI and tools without a remote account. */
export async function localOpenCodeProvider() {
  let groupChannel = '';
  const completed = new Set<string>();
  const questioned = new Set<string>();
  const searched = new Set<string>();
  let slept = false;
  let requests = 0;
  let guidanceLoaded = false;
  let backgroundLaunched = false;
  let nativeImageInput = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      let text = '';
      for await (const chunk of request) text += String(chunk);
      const input = JSON.parse(text) as Request;
      requests++;
      guidanceLoaded ||= JSON.stringify(input.messages).includes('# Isles Agent environment');
      // Native instruction updates are also model-facing user messages. Locate the
      // most recent acceptance task rather than mistaking a registry notice for it.
      const user = input.messages
        .slice()
        .reverse()
        .find(
          (message) =>
            message.role === 'user' && JSON.stringify(message.content).includes('OPENCODE_'),
        );
      const prompt =
        typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? '');
      nativeImageInput ||=
        prompt.includes('OPENCODE_PRIVATE_OK') &&
        prompt.includes('image_url') &&
        prompt.includes('data:image/png;base64,') &&
        prompt.includes('native.png');
      let marker =
        /OPENCODE_(?:PRIVATE|RESUME|QUESTION|GROUP|STEER|RESTART)_OK/.exec(prompt)?.[0] ??
        (prompt.includes('OPENCODE_STEER_DONE') ? 'OPENCODE_STEER_DONE' : undefined);
      if (
        marker === 'OPENCODE_STEER_OK' &&
        completed.has(marker) &&
        slept &&
        !completed.has('OPENCODE_STEER_DONE')
      )
        marker = 'OPENCODE_STEER_DONE';
      const tools = input.tools ?? [];
      const find = (name: RegExp) => tools.find((tool) => name.test(tool.function.name));
      let call: { name: string; arguments: string } | undefined;
      let content = 'Native acceptance complete.';
      let delay = 500;
      if (prompt.includes('OPENCODE_BACKGROUND_START')) {
        if (!backgroundLaunched) {
          const tool = find(/subagent$/);
          if (!tool) throw new Error('Native subagent tool missing');
          backgroundLaunched = true;
          call = {
            name: tool.function.name,
            arguments: JSON.stringify({
              agent: 'general',
              description: 'Background activity acceptance',
              prompt: 'Return OPENCODE_CHILD_COMPLETE as your final response.',
              background: true,
            }),
          };
        }
        content = 'OPENCODE_ROOT_YIELDED';
      } else if (prompt.includes('OPENCODE_CHILD_COMPLETE')) {
        if (prompt.includes('<subagent ')) content = 'OPENCODE_ROOT_WOKEN';
        else {
          delay = 4000;
          content = 'OPENCODE_CHILD_COMPLETE';
        }
      } else if (tools.length && marker && !completed.has(marker)) {
        if (marker === 'OPENCODE_QUESTION_OK' && !questioned.has(prompt)) {
          const tool = find(/(?:question|ask_user)$/);
          if (!tool) throw new Error('Native question tool missing');
          const args = {
            questions: [
              {
                header: '颜色',
                question: '选择蓝色还是绿色',
                options: [
                  { label: '蓝色', description: 'Blue' },
                  { label: '绿色', description: 'Green' },
                ],
                multiple: false,
              },
            ],
          };
          questioned.add(prompt);
          call = { name: tool.function.name, arguments: JSON.stringify(args) };
        } else if (marker === 'OPENCODE_STEER_DONE' && !slept) {
          const tool = find(/(?:bash|shell|terminal)$/);
          if (!tool) throw new Error('Native terminal tool missing');
          slept = true;
          call = {
            name: tool.function.name,
            arguments: JSON.stringify({
              command: 'sleep 12',
            }),
          };
        } else {
          const tool = find(/execute$/);
          if (!tool) throw new Error('Native execute tool missing');
          const payload = {
            channelId: marker === 'OPENCODE_GROUP_OK' ? groupChannel : 'private',
            body: marker === 'OPENCODE_QUESTION_OK' ? `${marker} 蓝色` : marker,
            clientId: randomUUID(),
          };
          if (!searched.has(marker)) {
            searched.add(marker);
            call = {
              name: tool.function.name,
              arguments: JSON.stringify({
                code: `return search({namespace:'isles',query:'send_message',limit:20});`,
              }),
            };
          } else {
            completed.add(marker);
            call = {
              name: tool.function.name,
              arguments: JSON.stringify({
                code: `return await tools.isles.send_message(${JSON.stringify(payload)});`,
              }),
            };
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const base = {
        id: `chatcmpl_${randomUUID()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'fixture-model',
      };
      const frame = (data: object) =>
        response.write(`data: ${JSON.stringify({ ...base, ...data })}\n\n`);
      frame({
        choices: [
          {
            index: 0,
            delta: call
              ? {
                  role: 'assistant',
                  tool_calls: [
                    { index: 0, id: `call_${randomUUID()}`, type: 'function', function: call },
                  ],
                }
              : { role: 'assistant', content },
            finish_reason: null,
          },
        ],
      });
      frame({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] });
      frame({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
      response.end('data: [DONE]\n\n');
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      console.log(
        'Native fixture protocol error:',
        error instanceof Error ? error.message : String(error),
      );
      response.end(
        JSON.stringify({
          error: { message: error instanceof Error ? error.message : String(error) },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local model fixture did not bind');
  return {
    model: 'isles-fixture/fixture-model',
    overlay: {
      model: 'isles-fixture/fixture-model',
      providers: {
        'isles-fixture': {
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'isles-fixture-key' },
          models: {
            'fixture-model': {
              capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
              limit: { context: 32768, output: 4096 },
            },
          },
        },
      },
    },
    setGroup(channelId: string) {
      groupChannel = channelId;
    },
    get guidanceLoaded() {
      return guidanceLoaded;
    },
    get nativeImageInput() {
      return nativeImageInput;
    },
    get requests() {
      return requests;
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
