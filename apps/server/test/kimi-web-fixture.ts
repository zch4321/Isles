import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface KimiWebFixtureRecord {
  type: string;
  args?: string[];
  cwd?: string;
  home?: string;
  method?: string;
  path?: string;
  body?: Record<string, unknown>;
  frame?: Record<string, unknown>;
  url?: string;
  mcp?: Record<string, unknown>;
  hasToken?: boolean;
}

/** An isolated CLI with real HTTP and WebSocket transport, using Kimi Code 2.1.1 shapes. */
export async function kimiWebFixture(root: string) {
  const home = join(root, 'kimi-web-home');
  await mkdir(join(home, 'sessions'), { recursive: true });
  const binary = join(root, 'kimi-web-fixture.cjs');
  const scenario = join(home, 'fixture.json');
  const log = join(home, 'wire.jsonl');
  await writeFile(scenario, '{}');
  await writeFile(
    binary,
    String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
if (process.argv.includes('--version')) { console.log('2.1.1'); process.exit(0); }
const home = process.env.KIMI_CODE_HOME;
const settings = () => JSON.parse(fs.readFileSync(path.join(home, 'fixture.json'), 'utf8'));
const record = entry => fs.appendFileSync(path.join(home, 'wire.jsonl'), JSON.stringify(entry) + '\n');
record({ type: 'launch', args: process.argv.slice(2), cwd: process.cwd(), home, hasToken: Boolean(process.env.ISLES_KIMI_MCP_TOKEN) });
const token = 'fixture-' + crypto.randomUUID();
const sessions = path.join(home, 'sessions');
const now = () => new Date().toISOString();
const peers = new Set();
const read = id => { try { return JSON.parse(fs.readFileSync(path.join(sessions, id + '.json'), 'utf8')); } catch { return null; } };
const save = s => fs.writeFileSync(path.join(sessions, s.id + '.json'), JSON.stringify(s));
const list = () => fs.readdirSync(sessions).filter(n => n.endsWith('.json')).map(n => read(n.slice(0, -5)));
const models = () => settings().models ?? [
  { provider: 'kimi-code', model: 'kimi-code/k3', display_name: 'K3', max_context_size: 262144, capabilities: ['thinking'], support_efforts: ['low', 'high', 'max'], default_effort: 'max' },
  { provider: 'kimi-code', model: 'kimi-code/fast', display_name: 'Fast', max_context_size: 131072, capabilities: [] },
];
const workspace = root => ({ id: 'wd_fixture_' + crypto.createHash('sha256').update(root).digest('hex').slice(0,12), root, name: 'Fixture', created_at: now(), last_opened_at: now(), session_count: 0 });
const wireSession = s => ({ id: s.id, workspace_id: workspace(s.metadata.cwd).id, title: s.title, created_at: s.created_at, updated_at: now(), metadata: s.metadata, agent_config: s.agent_config, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, context_tokens: s.context_tokens ?? 0, context_limit: 262144 }, permission_rules: [], message_count: 0, last_seq: s.seq, busy: Boolean(s.active), main_turn_active: Boolean(s.active), pending_interaction: s.questions.length ? 'question' : 'none', ...(s.active ? { current_prompt_id: s.active.prompt_id } : {}) });
const frame = (s, type, fields = {}, transport = {}) => {
  const volatile = ['assistant.delta', 'thinking.delta', 'tool.call.delta', 'tool.progress', 'shell.output', 'shell.started', 'shell.completed', 'agent.status.updated'].includes(type);
  if (!volatile) s.seq++;
  let offset;
  if ((fields.agentId ?? 'main') === 'main') {
    s.offsets ??= {};
    const offsets = s.offsets[fields.turnId ?? s.turn] ??= {};
    if (type === 'turn.started' || type === 'turn.step.started') { offsets.assistant = 0; offsets.thinking = 0; }
    if (type === 'assistant.delta' || type === 'thinking.delta') {
      const key = type === 'assistant.delta' ? 'assistant' : 'thinking';
      offset = transport.offset ?? offsets[key] ?? 0;
      offsets[key] = Math.max(offsets[key] ?? 0, offset + fields.delta.length);
    }
  }
  const payload = { type, sessionId: s.id, agentId: 'main', ...fields };
  save(s);
  return { type, session_id: s.id, seq: s.seq, epoch: s.epoch, timestamp: now(), payload, ...(volatile ? { volatile: true } : {}), ...(offset === undefined ? {} : { offset }), ...transport };
};
const send = (peer, obj) => {
  if (peer.socket.destroyed) return;
  const body = Buffer.from(JSON.stringify(obj));
  const prefix = body.length < 126 ? Buffer.from([0x81,body.length]) : Buffer.from([0x81,126,body.length >> 8,body.length & 255]);
  peer.socket.write(Buffer.concat([prefix,body]));
};
const emit = (s, type, fields = {}, transport = {}) => {
  if (type === 'agent.status.updated' && (fields.agentId ?? 'main') === 'main' && fields.contextTokens !== undefined) s.context_tokens = fields.contextTokens;
  const event = frame(s, type, fields, transport);
  record({ type: 'event', frame: event });
  for (const peer of peers) if (peer.ids.has(s.id)) send(peer,event);
};
const begin = (s, p) => {
  s.queue = s.queue.filter(pending => pending.prompt_id !== p.prompt_id);
  s.active = { ...p, status: 'running' };
  s.turn++;
  emit(s, 'turn.started', { turnId: s.turn, promptId: p.prompt_id, origin: { kind: 'user' }, prompt: p.content.map(part => part.text ?? '').join('') });
};
const scheduleOutput = (s, p) => setTimeout(() => {
  const current = read(s.id);
  if (current?.active?.prompt_id === p.prompt_id) output(current,p.content.map(part => part.text ?? '').join(''));
}, 15);
const finish = (s, reason = 'completed', error) => {
  if (!s.active) return;
  const promptId = s.active.prompt_id;
  const turnId = s.turn;
  s.active = null;
  s.questions = [];
  const next = s.queue[0];
  if (next && settings().nextTurnBeforeEnd) begin(s,next);
  const terminal = current => {
    emit(current, 'turn.ended', { turnId, reason, ...(error === undefined ? {} : { error }) });
    if (reason === 'cancelled') emit(current, 'prompt.aborted', { promptId, abortedAt: now() });
    else emit(current, 'prompt.completed', { promptId, finishedAt: now(), reason });
  };
  if (next && settings().nextTurnBeforeEnd && settings().oldTurnEndDelayMs)
    setTimeout(() => terminal(read(s.id)),settings().oldTurnEndDelayMs);
  else terminal(s);
  if (next && !s.active) begin(s,next);
  save(s);
  if (next) scheduleOutput(s,next);
};
const question = (s, many, fields = {}) => {
  const options = [{ id: 'one', label: 'One', description: 'First' }, { id: 'two', label: 'Two', description: 'Second' }];
  const value = { question_id: 'question-' + crypto.randomUUID(), session_id: s.id, agent_id: 'main', turn_id: s.turn, tool_call_id: 'ask-1', created_at: now(), questions: [{ id: 'q0', header: 'Result', question: 'Which result?', options, multi_select: false, allow_other: true }, ...(many ? [{ id: 'q1', header: 'Extras', question: 'Which extras?', options, multi_select: true, allow_other: true }] : [])], ...fields };
  s.questions.push(value);
  emit(s, 'event.question.requested', value);
};
const output = (s, text) => {
  if (settings().manualOutput) return;
  if (text === 'ask' || text === 'ask-many') { question(s, text === 'ask-many'); return; }
  emit(s, 'assistant.delta', { turnId: s.turn, delta: 'Reply: ' });
  emit(s, 'assistant.delta', { turnId: s.turn, delta: text });
  if (!settings().holdTurn) finish(s);
};
const envelope = (res, data = {}, code = 0, msg = 'OK', status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code, msg, data, request_id: crypto.randomUUID() }));
};
const server = http.createServer(async (req,res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body && req.headers['content-type'] === 'application/json') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'FST_ERR_CTP_EMPTY_JSON_BODY', message: 'Body cannot be empty when content-type is set to application/json' }));
    return;
  }
  body = body ? JSON.parse(body) : undefined;
  const url = new URL(req.url, 'http://localhost');
  const route = decodeURIComponent(url.pathname);
  if (route === '/fixture') {
    const s = read(body.sessionId);
    if (body.op === 'drop') { for (const peer of peers) peer.socket.destroy(); return envelope(res); }
    if (!s) return envelope(res, {}, 40401, 'Unknown session');
    if (body.op === 'begin') { const p = s.queue.find(p => p.prompt_id === body.promptId); if (p) begin(s,p); }
    if (body.op === 'finish') finish(s,body.reason,body.error);
    if (body.op === 'question') question(s,body.many,body.fields);
    if (body.op === 'emit') emit(s,body.event,body.fields,body.transport);
    if (body.op === 'emitBatch') for (const event of body.events) emit(s,event.type,event.fields,event.transport);
    if (body.op === 'queue') { s.queue.push(body.prompt); save(s); }
    return envelope(res);
  }
  record({ type: 'http', method: req.method, path: route, body });
  if (req.headers.authorization !== 'Bearer ' + token) return envelope(res,{},40101,'Unauthorized',401);
  if (route === '/api/v1/auth') return envelope(res,{ models_ready: !settings().unauthenticated, providers_count: settings().unauthenticated ? 0 : 1, managed_provider: { name: 'kimi-code', status: settings().unauthenticated ? 'unauthenticated' : 'authenticated' } });
  if (route === '/api/v1/models') return envelope(res,{ items: models() });
  if (route === '/api/v1/config') return envelope(res,{ providers: {}, default_model: 'kimi-code/k3' });
  if (route === '/api/v1/meta') return envelope(res,{ server_version: '2.1.1', server_id: 'fixture', capabilities: { websocket: true, mcp: true }, started_at: now() });
  if (req.method === 'POST' && route === '/api/v1/workspaces') return envelope(res,workspace(body.root));
  if (/^\/api\/v1\/workspaces\/[^/]+\/trust$/.test(route)) return envelope(res,{ trusted: true });
  if (route === '/api/v1/sessions' && req.method === 'POST') {
    const s = { id: 'session_' + crypto.randomUUID(), title: body.title ?? 'Fixture', metadata: body.metadata, agent_config: body.agent_config ?? { model: 'kimi-code/k3' }, created_at: now(), seq: 0, epoch: 'epoch-' + crypto.randomUUID(), turn: 0, active: null, queue: [], questions: [] };
    save(s);
    return envelope(res,wireSession(s));
  }
  if (route === '/api/v1/sessions' && req.method === 'GET') return envelope(res,{ items: list().map(wireSession), has_more: false });
  const match = route.match(/^\/api\/v1\/sessions\/([^/]+)(.*)$/);
  if (!match) return envelope(res,{},40401,'Unknown route ' + route);
  const s = read(match[1]);
  if (!s) return envelope(res,{},40401,'Unknown session ' + match[1]);
  const tail = match[2];
  if (!tail && req.method === 'GET') return envelope(res,wireSession(s));
  if (tail === '/profile') {
    const model = body.agent_config.model ?? s.agent_config.model;
    const chosen = models().find(m => m.model === model);
    if (!chosen || (body.agent_config.thinking && !(chosen.support_efforts ?? []).includes(body.agent_config.thinking))) return envelope(res,{},40001,'Unsupported model or thinking');
    Object.assign(s.agent_config,body.agent_config); save(s); return envelope(res,wireSession(s));
  }
  if (tail === '/status') {
    const mcpPath = path.join(s.metadata.cwd,'.kimi-code','mcp.json');
    record({ type: 'loaded', cwd: s.metadata.cwd, mcp: fs.existsSync(mcpPath) ? JSON.parse(fs.readFileSync(mcpPath,'utf8')) : null });
    const status = { busy: Boolean(s.active), model: s.agent_config.model, thinking_level: s.agent_config.thinking ?? 'max', permission: s.agent_config.permission_mode ?? 'manual', plan_mode: false, swarm_mode: false, context_tokens: s.context_tokens ?? 0, max_context_tokens: 262144 };
    if (settings().statusDelayMs) return setTimeout(() => envelope(res,status),settings().statusDelayMs);
    return envelope(res,status);
  }
  if (tail === '/snapshot') return envelope(res,{ session: wireSession(s), as_of_seq: s.seq, epoch: s.epoch, messages: { items: [], has_more: false }, in_flight_turn: s.active ? { turn_id: s.turn, current_prompt_id: s.active.prompt_id, assistant_text: '', thinking_text: '', running_tools: [] } : null, pending_approvals: [], pending_questions: s.questions, subagents: [] });
  if (tail === '/prompts' && req.method === 'GET') return envelope(res,{ active: s.active, queued: s.queue });
  if (tail === '/prompts' && req.method === 'POST') {
    const cfg = settings();
    if (cfg.rejectPrompt) return envelope(res,{},40001,'Prompt refused');
    if (cfg.loseBeforeAcceptance) { req.socket.destroy(); return; }
    const p = { prompt_id: body.prompt_id, user_message_id: 'message-' + body.prompt_id, status: 'queued', content: body.content, created_at: now() };
    if (!p.prompt_id) return envelope(res,{},40001,'prompt_id required');
    if (s.active?.prompt_id === p.prompt_id || s.queue.some(q => q.prompt_id === p.prompt_id)) return envelope(res,{},40927,'prompt_id conflict');
    s.queue.push(p);
    emit(s,'prompt.submitted',{ promptId: p.prompt_id, userMessageId: p.user_message_id, status: 'queued', content: p.content, createdAt: p.created_at });
    const wasQueued = Boolean(s.active);
    if (!s.active && !cfg.holdAdmission) {
      begin(s,p);
      if (cfg.loseAfterAcceptance) { req.socket.destroy(); for (const peer of peers) peer.socket.destroy(); return; }
      scheduleOutput(s,p);
    }
    const receipt = cfg.invalidReceipt ? { ...p, prompt_id: 'wrong-prompt' } : { ...p, status: s.active?.prompt_id === p.prompt_id ? 'running' : 'queued' };
    if (wasQueued && cfg.loseQueuedReceipt) { req.socket.destroy(); for (const peer of peers) peer.socket.destroy(); return; }
    if (wasQueued && cfg.finishOnQueuedPrompt) finish(s);
    if (wasQueued && cfg.queuedPromptResponseDelayMs) setTimeout(() => envelope(res,receipt),cfg.queuedPromptResponseDelayMs);
    else envelope(res,receipt);
    return;
  }
  const action = tail.match(/^\/prompts\/([^/:]+):(abort|steer)$/);
  if (action) {
    const id = action[1];
    if (action[2] === 'abort') {
      const active = s.active?.prompt_id === id;
      s.queue = s.queue.filter(p => p.prompt_id !== id);
      if (active) finish(s,'cancelled');
      else emit(s,'prompt.aborted',{ promptId: id, abortedAt: now() });
      save(s);
      return envelope(res,{ aborted: true, at_seq: s.seq });
    }
    if (settings().boundaryOnSteer) { finish(s); return envelope(res,{},40402,'Prompt is not pending'); }
    if (!s.active) return envelope(res,{},40402,'Prompt is not pending');
    const p = s.queue.find(q => q.prompt_id === id);
    if (!p) return envelope(res,{},40402,'Prompt is not pending');
    if (settings().suppressSteerReceipt) return envelope(res,{},40402,'Prompt is not pending');
    s.queue = s.queue.filter(q => q.prompt_id !== id);
    emit(s,'prompt.steered',{ activePromptId: s.active.prompt_id, promptIds: [id], messageId: p.user_message_id, content: p.content, steeredAt: now() });
    return envelope(res,{ steered: true, prompt_ids: [id] });
  }
  if (tail === '/questions') return envelope(res,{ items: s.questions });
  const questionAction = tail.match(/^\/questions\/([^/:]+)(?::(dismiss|resolve))?$/);
  if (questionAction) {
    const id = questionAction[1];
    const pendingQuestion = s.questions.find(q => q.question_id === id);
    s.questions = s.questions.filter(q => q.question_id !== id);
    emit(s,'event.question.' + (questionAction[2] === 'dismiss' ? 'dismissed' : 'answered'),{ question_id: id });
    if (questionAction[2] === 'dismiss') return envelope(res,{ dismissed: true, dismissed_at: now() },40909,'Question dismissed');
    emit(s,'assistant.delta',{ agentId: pendingQuestion?.agent_id ?? 'main', turnId: pendingQuestion?.turn_id ?? s.turn, delta: 'Answer: ' + JSON.stringify(body) });
    if (!settings().holdTurn && (pendingQuestion?.agent_id ?? 'main') === 'main') finish(s);
    return envelope(res,{ resolved: true, resolved_at: now() });
  }
  return envelope(res,{},40401,'Unknown route ' + route);
});
server.on('upgrade',(req,socket) => {
  const protocol = req.headers['sec-websocket-protocol'];
  record({ type: 'upgrade', path: req.url });
  if (req.url !== '/api/v1/ws' || protocol !== 'kimi-code.bearer.' + token) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nSec-WebSocket-Protocol: ' + protocol + '\r\n\r\n');
  const peer = { socket, ids: new Set(), lastInbound: Date.now(), lastPing: Date.now() };
  const heartbeat = setInterval(() => {
    const ms = settings().heartbeatMs;
    if (!ms || socket.destroyed || Date.now() - peer.lastPing < ms) return;
    if (Date.now() - peer.lastInbound >= ms * 2) { socket.destroy(); return; }
    peer.lastPing = Date.now();
    send(peer,{ type: 'ping', timestamp: now(), payload: { nonce: crypto.randomUUID() } });
  },5);
  heartbeat.unref();
  peers.add(peer);
  socket.on('close',() => { clearInterval(heartbeat); peers.delete(peer); });
  socket.on('error',() => peers.delete(peer));
  let buffer = Buffer.alloc(0);
  socket.on('data',chunk => {
    buffer = Buffer.concat([buffer,chunk]);
    while (buffer.length >= 2) {
      const op = buffer[0] & 15;
      let size = buffer[1] & 127;
      let cursor = 2;
      if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); cursor = 4; }
      if (size === 127) { if (buffer.length < 10) return; size = Number(buffer.readBigUInt64BE(2)); cursor = 10; }
      const masked = Boolean(buffer[1] & 128);
      if (buffer.length < cursor + (masked ? 4 : 0) + size) return;
      const mask = masked ? buffer.subarray(cursor,cursor + 4) : null;
      if (masked) cursor += 4;
      const data = Buffer.from(buffer.subarray(cursor,cursor + size));
      buffer = buffer.subarray(cursor + size);
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      if (op === 8) { socket.end(Buffer.from([0x88,0])); return; }
      if (op !== 1) continue;
      const value = JSON.parse(data.toString());
      record({ type: 'ws', frame: value });
      peer.lastInbound = Date.now();
      if (value.type === 'client_hello') send(peer,{ type: 'ack', id: value.id, code: 0, msg: 'OK', payload: { accepted_subscriptions: [], resync_required: [] } });
      if (value.type === 'subscribe') {
        const ids = value.payload.session_ids;
        const found = ids.filter(id => read(id));
        for (const id of found) peer.ids.add(id);
        send(peer,{ type: 'ack', id: value.id, code: 0, msg: 'OK', payload: { accepted: found, not_found: ids.filter(id => !read(id)), resync_required: [], cursors: Object.fromEntries(found.map(id => [id,{ seq: read(id).seq, epoch: read(id).epoch }])) } });
      }
      if (value.type === 'ping') send(peer,{ type: 'pong', id: value.id, payload: {} });
    }
  });
  send(peer,{ type: 'server_hello', timestamp: now(), payload: { ws_connection_id: crypto.randomUUID(), protocol_version: 2, heartbeat_ms: settings().heartbeatMs ?? 30000, max_event_buffer_size: 10000, capabilities: { event_batching: false, compression: false } } });
});
server.listen(0,'127.0.0.1',() => {
  const url = 'http://127.0.0.1:' + server.address().port;
  record({ type: 'ready', url });
  console.log('Kimi server: ' + url + '/#token=' + token);
});
setInterval(() => { if (settings().releaseHeld) for (const s of list()) if (s.active) finish(s); },10).unref();
process.on('SIGTERM',() => { for (const peer of peers) peer.socket.destroy(); server.close(() => process.exit(0)); });
`,
  );
  const records = async (): Promise<KimiWebFixtureRecord[]> =>
    (await readFile(log, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as KimiWebFixtureRecord);
  const control = async (body: Record<string, unknown>) => {
    const ready = (await records()).filter((value) => value.type === 'ready').at(-1);
    if (!ready?.url) throw new Error('Kimi Web fixture has not started');
    const response = await fetch(`${ready.url}/fixture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as { code: number; msg: string };
    if (result.code !== 0) throw new Error(result.msg);
  };
  return {
    home,
    binary,
    records,
    set: async (settings: Record<string, unknown>) => {
      const temporary = `${scenario}.tmp`;
      await writeFile(temporary, JSON.stringify(settings));
      await rename(temporary, scenario);
    },
    emit: (
      sessionId: string,
      event: string,
      fields: Record<string, unknown> = {},
      transport: { volatile?: boolean; offset?: number } = {},
    ) => control({ op: 'emit', sessionId, event, fields, transport }),
    begin: (sessionId: string, promptId: string) => control({ op: 'begin', sessionId, promptId }),
    emitBatch: (
      sessionId: string,
      events: {
        type: string;
        fields?: Record<string, unknown>;
        transport?: { volatile?: boolean; offset?: number };
      }[],
    ) => control({ op: 'emitBatch', sessionId, events }),
    finish: (sessionId: string, reason = 'completed', error?: unknown) =>
      control({ op: 'finish', sessionId, reason, error }),
    question: (sessionId: string, many = false, fields: Record<string, unknown> = {}) =>
      control({ op: 'question', sessionId, many, fields }),
    drop: () => control({ op: 'drop' }),
    queue: (sessionId: string, prompt: Record<string, unknown>) =>
      control({ op: 'queue', sessionId, prompt }),
  };
}
