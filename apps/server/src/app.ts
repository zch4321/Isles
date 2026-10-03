import fastifyStatic from '@fastify/static';
import { ConfigurationError, type ConfigManager } from '@isles/config';
import {
  addMembersSchema,
  answerQuestionSchema,
  createAgentSchema,
  codexConfigurationUpdateSchema,
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
import { NativeCatalog, type Catalog } from './codex/catalog.js';
import { NativeEnvironment } from './codex/environment.js';
import { HttpError } from './errors.js';
import { registerMcp } from './mcp/server.js';
import { Runtime, type ClientFactory } from './runtime/runtime.js';
import { openDatabase } from './storage/database.js';
import { acquireDataLock } from './storage/lock.js';
import { Store } from './storage/store.js';

export interface AppOptions {
  config: ConfigManager;
  webRoot?: string;
  logger?: boolean;
  catalog?: Catalog;
  clientFactory?: ClientFactory;
  runtimeUrl?: string;
}

export async function buildApp(options: AppOptions) {
  const { dataDir, workspaceDir, sharedDir } = options.config.current;
  await mkdir(sharedDir, { recursive: true });
  const releaseDataLock = acquireDataLock(dataDir);
  const app = Fastify({
    logger: options.logger ?? false,
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
  const environment = new NativeEnvironment(options.config);
  const store = new Store(database, workspaceDir);
  const catalog = options.catalog ?? new NativeCatalog(environment, dataDir);
  let runtime: Runtime;
  try {
    runtime = new Runtime(store, catalog, environment, options.clientFactory);
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

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ConfigurationError)
      return reply.code(400).send({ error: environment.redactor.text(error.message) });
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
      await runtime.close();
    } finally {
      database.sqlite.close();
      releaseDataLock();
    }
  });

  app.get<{ Reply: HealthResponse }>('/api/health', async (_request, reply) => {
    database.db.get(sql`select 1`);
    reply.header('Cache-Control', 'no-store');
    return { status: 'ok', service: 'isles', database: 'ready' };
  });

  app.get<{ Querystring: { refresh?: string } }>('/api/codex/status', (request) => {
    if (request.query.refresh === 'true') catalog.invalidate?.();
    return catalog.status();
  });
  app.get('/api/codex/config', () => environment.configuration());
  app.put('/api/codex/config', async (request) => {
    const { binaryPath } = codexConfigurationUpdateSchema.parse(request.body);
    const configuration = await environment.configure(binaryPath);
    catalog.invalidate?.();
    return configuration;
  });
  app.get('/api/codex/models', async () => ({ models: await catalog.models() }));
  app.get('/api/agents', () => ({ agents: store.listAgents(), cursor: store.cursor() }));
  app.post('/api/agents', async (request, reply) =>
    reply.code(201).send(await runtime.createAgent(createAgentSchema.parse(request.body))),
  );
  app.get<{ Params: { id: string } }>('/api/agents/:id', (request) =>
    store.agentDetail(request.params.id),
  );
  app.patch<{ Params: { id: string } }>('/api/agents/:id', (request) =>
    runtime.updateAgent(request.params.id, updateAgentSchema.parse(request.body)),
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
  app.get('/api/channels', () => ({ channels: store.listChannels(), cursor: store.cursor() }));
  app.post('/api/channels', (request, reply) =>
    reply.code(201).send(runtime.createGroup('user', createGroupSchema.parse(request.body))),
  );
  app.get<{ Params: { id: string } }>('/api/channels/:id', (request) =>
    store.channelDetail(request.params.id),
  );
  app.patch<{ Params: { id: string } }>('/api/channels/:id', (request) =>
    runtime.updateChannel(request.params.id, updateChannelSchema.parse(request.body)),
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
  registerMcp(app, runtime);

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
