import fastifyStatic from '@fastify/static';
import { ConfigurationError, isCliHarness, type ConfigManager } from '@isles/config';
import {
  addMembersSchema,
  answerQuestionSchema,
  createAgentSchema,
  cliConfigurationUpdateSchema,
  createGroupSchema,
  sendMessageSchema,
  updateAgentSchema,
  updateChannelSchema,
  type HealthResponse,
} from '@isles/contracts';
import { sql } from 'drizzle-orm';
import Fastify, { LogController } from 'fastify';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { HttpError, Redactor } from './errors.js';
import { chatExportFormatter } from './chat/markdown.js';
import { defaultAdapters } from './harness/defaults.js';
import { HarnessRegistry } from './harness/registry.js';
import type { HarnessAdapter } from './harness/types.js';
import type { LogStream } from './logging.js';
import { registerMcp } from './mcp/server.js';
import { Runtime } from './runtime/runtime.js';
import { AgentWorkspace } from './runtime/workspace.js';
import { openDatabase } from './storage/database.js';
import { acquireDataLock } from './storage/lock.js';
import { Store } from './storage/store.js';

export interface AppOptions {
  config: ConfigManager;
  webRoot?: string;
  /** Receives JSON log lines at the configured level; logging is off without it. */
  logStream?: LogStream;
  adapterFactory?: (workspace: AgentWorkspace, config: ConfigManager) => HarnessAdapter[];
  runtimeUrl?: string;
}

export async function buildApp(options: AppOptions) {
  const { dataDir, workspaceDir, sharedDir } = options.config.current;
  await mkdir(sharedDir, { recursive: true });
  const releaseDataLock = acquireDataLock(dataDir);
  const redactor = new Redactor();
  const app = Fastify({
    logger: options.logStream
      ? {
          level: options.config.current.logLevel,
          stream: options.logStream,
          // Errors may carry native credentials; every logged `err` passes the shared redactor.
          serializers: { err: (error: unknown) => redactor.error(error) },
        }
      : false,
    bodyLimit: 100_000,
    logController: new LogController({ disableRequestLogging: true }),
  });
  let database;
  try {
    database = openDatabase(dataDir);
  } catch (error) {
    releaseDataLock();
    throw error;
  }
  const workspace = new AgentWorkspace(options.config, app.log, redactor);
  const store = new Store(database, workspaceDir);
  let runtime: Runtime;
  try {
    const harnesses = new HarnessRegistry(
      options.adapterFactory?.(workspace, options.config) ??
        defaultAdapters(options.config, workspace),
    );
    runtime = new Runtime(store, harnesses, workspace);
  } catch (error) {
    database.sqlite.close();
    releaseDataLock();
    throw error;
  }
  if (options.runtimeUrl) runtime.start(options.runtimeUrl);
  app.decorate('isles', { runtime, store });

  app.addHook('onListen', async () => {
    const address = app.server.address();
    if (address && typeof address !== 'string') runtime.start(`http://127.0.0.1:${address.port}`);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ConfigurationError)
      return reply.code(400).send({ error: workspace.redactor.text(error.message) });
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: '请求参数无效',
        details: error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    if (error instanceof HttpError)
      return reply.code(error.statusCode).send({ error: error.message });
    const status =
      error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    if (status >= 500)
      request.log.error(
        { err: error, method: request.method, url: request.url.split('?')[0] },
        'Request failed',
      );
    return reply
      .code(status)
      .send({ error: status < 500 ? '请求无效' : '服务处理失败，请检查运行状态' });
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const origin = request.headers.origin;
    if (origin) {
      let hostname: string;
      try {
        hostname = new URL(origin).hostname;
      } catch {
        throw new HttpError(403, '请求来源无效');
      }
      if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]')
        throw new HttpError(403, '仅允许本机 Web 来源');
    }
  });

  app.addHook('onClose', async () => {
    try {
      database.sqlite.close();
    } finally {
      releaseDataLock();
    }
  });

  app.get<{ Reply: HealthResponse }>('/api/health', async (_request, reply) => {
    database.db.get(sql`select 1`);
    reply.header('Cache-Control', 'no-store');
    return { status: 'ok', service: 'isles', database: 'ready' };
  });

  app.get('/api/harnesses', () => ({ harnesses: runtime.harnesses.list() }));
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    '/api/harnesses/:id/status',
    (request) => {
      const adapter = runtime.harnesses.get(request.params.id);
      if (request.query.refresh === 'true') adapter.invalidate();
      return adapter.catalog.status();
    },
  );
  app.get<{ Params: { id: string } }>('/api/harnesses/:id/models', async (request) => ({
    models: await runtime.harnesses.get(request.params.id).catalog.models(),
  }));
  const cliHarness = (id: string) => {
    const adapter = runtime.harnesses.get(id);
    if (adapter.descriptor.configuration !== 'cli-path' || !isCliHarness(id))
      throw new HttpError(404, `${id} 没有可执行路径设置`);
    return { adapter, id };
  };
  app.get<{ Params: { id: string } }>('/api/harnesses/:id/config', (request) =>
    options.config.cliConfiguration(cliHarness(request.params.id).id),
  );
  app.put<{ Params: { id: string } }>('/api/harnesses/:id/config', async (request) => {
    const { adapter, id } = cliHarness(request.params.id);
    const { binaryPath } = cliConfigurationUpdateSchema.parse(request.body);
    const configuration = await options.config.configureCliBinary(id, binaryPath);
    adapter.invalidate();
    return configuration;
  });
  app.get('/api/agents', (request) => {
    const { includeDeleted } = z
      .object({ includeDeleted: z.enum(['true', 'false']).optional() })
      .strict()
      .parse(request.query);
    return { agents: store.listAgents(includeDeleted === 'true'), cursor: store.cursor() };
  });
  app.post('/api/agents', async (request, reply) =>
    reply.code(201).send(await runtime.createAgent(createAgentSchema.parse(request.body))),
  );
  app.get<{ Params: { id: string } }>('/api/agents/:id', (request) =>
    store.agentDetail(request.params.id),
  );
  app.patch<{ Params: { id: string } }>('/api/agents/:id', (request) =>
    runtime.updateAgent(request.params.id, updateAgentSchema.parse(request.body)),
  );
  app.delete<{ Params: { id: string } }>('/api/agents/:id', (request) =>
    runtime.deleteAgent(request.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/agents/:id/stop', async (request) => {
    await runtime.stop(request.params.id);
    return store.publicAgent(request.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/agents/:id/resume', async (request) => {
    await runtime.resume(request.params.id);
    return store.publicAgent(request.params.id);
  });
  app.post<{ Params: { id: string; questionId: string } }>(
    '/api/agents/:id/questions/:questionId/answer',
    (request) => {
      runtime.answer(
        request.params.id,
        request.params.questionId,
        answerQuestionSchema.parse(request.body),
      );
      return { status: 'answered' };
    },
  );
  app.get('/api/channels', (request) => {
    const { includeDeleted } = z
      .object({ includeDeleted: z.enum(['true', 'false']).optional() })
      .strict()
      .parse(request.query);
    return { channels: store.listChannels(includeDeleted === 'true'), cursor: store.cursor() };
  });
  app.post('/api/channels', (request, reply) =>
    reply.code(201).send(runtime.createGroup('user', createGroupSchema.parse(request.body))),
  );
  app.get<{ Params: { id: string } }>('/api/channels/:id', (request) =>
    store.channelDetail(request.params.id),
  );
  app.get<{ Params: { id: string } }>('/api/channels/:id/export', (request, reply) => {
    const { timeZone } = z
      .strictObject({ timeZone: z.string().min(1).max(100).default('UTC') })
      .parse(request.query);
    const format = chatExportFormatter(timeZone);
    const { filename, markdown } = format(store.chatExportSnapshot(request.params.id));
    const encoded = encodeURIComponent(filename).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return reply
      .type('text/markdown; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="chat-history.md"; filename*=UTF-8''${encoded}`,
      )
      .send(markdown);
  });
  app.patch<{ Params: { id: string } }>('/api/channels/:id', (request) =>
    runtime.updateChannel(request.params.id, updateChannelSchema.parse(request.body)),
  );
  app.delete<{ Params: { id: string } }>('/api/channels/:id', (request) =>
    runtime.deleteGroup(request.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/channels/:id/members', (request) =>
    runtime.addMembers(request.params.id, 'user', addMembersSchema.parse(request.body).agentIds),
  );
  app.delete<{ Params: { id: string; agentId: string } }>(
    '/api/channels/:id/members/:agentId',
    (request) => runtime.removeMember(request.params.id, request.params.agentId),
  );
  const pageSchema = z
    .object({
      after: z.coerce.number().int().min(0).optional(),
      before: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(100),
    })
    .refine((q) => q.after === undefined || q.before === undefined, '不能同时指定 after 和 before');
  app.get<{ Params: { id: string } }>('/api/channels/:id/messages', (request) => {
    const query = pageSchema.parse(request.query);
    const all = store.listMessages(request.params.id, {
      ...(query.after !== undefined ? { after: query.after } : {}),
      ...(query.before !== undefined ? { before: query.before } : {}),
      limit: query.limit + 1,
    });
    const recent = query.after === undefined;
    const messages = recent ? all.slice(-query.limit) : all.slice(0, query.limit);
    return { messages, nextAfter: all.length > query.limit ? messages.at(-1)!.seq : null };
  });
  app.post<{ Params: { id: string } }>('/api/channels/:id/messages', (request, reply) =>
    reply.code(201).send(runtime.send(request.params.id, sendMessageSchema.parse(request.body))),
  );

  const sseConnections = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const close of sseConnections) close();
  });
  app.get('/api/events', (request, reply) => {
    const query = z
      .object({ after: z.coerce.number().int().min(0).optional() })
      .parse(request.query);
    const last = request.headers['last-event-id'];
    let after =
      typeof last === 'string' ? z.coerce.number().int().min(0).parse(last) : (query.after ?? 0);
    if (!request.headers.accept?.includes('text/event-stream')) {
      const events = store.eventsAfter(after);
      return { events, cursor: events.at(-1)?.id ?? after, latestCursor: store.cursor() };
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 1000\n\n');
    let unsubscribe = () => {};
    let heartbeat: NodeJS.Timeout | undefined;
    const close = () => {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      sseConnections.delete(close);
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    sseConnections.add(close);
    reply.raw.once('close', close);
    reply.raw.on('error', close);
    const send = (event: ReturnType<Store['eventsAfter']>[number]) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      if (event.id <= after) return;
      after = event.id;
      // A slow consumer reconnects and catches up from the durable cursor.
      if (!reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)) close();
    };
    unsubscribe = store.subscribe(send);
    let page;
    do {
      page = store.eventsAfter(after);
      for (const event of page) {
        if (reply.raw.writableEnded || reply.raw.destroyed) break;
        send(event);
      }
    } while (page.length === 500 && !reply.raw.writableEnded && !reply.raw.destroyed);
    if (!reply.raw.writableEnded && !reply.raw.destroyed)
      heartbeat = setInterval(() => {
        if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
      }, 15_000);
  });
  const closeMcpConnections = registerMcp(app, runtime);
  // Native MCP clients can hold SSE requests open. Release processes and transports
  // before Fastify waits for the HTTP server's connections to close.
  app.addHook('preClose', async () => {
    await Promise.all([runtime.close(), closeMcpConnections()]);
  });

  if (options.webRoot && existsSync(join(options.webRoot, 'index.html'))) {
    try {
      await app.register(fastifyStatic, { root: options.webRoot });
    } catch (error) {
      await app.close();
      throw error;
    }
    app.setNotFoundHandler((request, reply) => {
      const pathname = request.url.split('?')[0] ?? request.url;
      if (
        request.method === 'GET' &&
        pathname !== '/api' &&
        !pathname.startsWith('/api/') &&
        !pathname.startsWith('/mcp/') &&
        request.headers.accept?.includes('text/html')
      ) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not Found' });
    });
  }

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    isles: { runtime: Runtime; store: Store };
  }
}
