import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A real stdio process replaying the Kimi Code 2.1.1 ACP shapes captured in native probes. */
export async function kimiFixture(root: string) {
  const home = join(root, 'kimi-home');
  await mkdir(home, { recursive: true });
  const binary = join(root, 'kimi-fixture.cjs');
  const scenario = join(home, 'fixture.json');
  const log = join(home, 'wire.jsonl');
  await writeFile(scenario, '{}');
  await writeFile(
    binary,
    String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('2.1.1'); process.exit(0); }
const home = process.env.KIMI_CODE_HOME;
const settings = () => JSON.parse(fs.readFileSync(path.join(home, 'fixture.json'), 'utf8'));
const record = (entry) => fs.appendFileSync(path.join(home, 'wire.jsonl'), JSON.stringify(entry) + '\n');
record({ type: 'launch', args: process.argv.slice(2), cwd: process.cwd(), home, hasToken: Boolean(process.env.ISLES_MCP_TOKEN) });
const sessions = path.join(home, 'sessions');
fs.mkdirSync(sessions, { recursive: true });
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } });
const chunk = (sessionId, text, kind = 'agent_message_chunk') => update(sessionId, { sessionUpdate: kind, content: { type: 'text', text } });
const models = [
  { value: 'kimi-code/k3', name: 'K3', thinking: ['low', 'high', 'max'] },
  { value: 'kimi-code/fast', name: 'Fast', thinking: [] },
];
const modes = ['default', 'plan', 'auto', 'yolo'];
const state = new Map();
const options = (s) => {
  const model = models.find((entry) => entry.value === s.model);
  return [
    { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: s.model, options: models.map(({ value, name }) => ({ value, name })) },
    ...(model.thinking.length ? [{ type: 'select', id: 'thinking', name: 'Thinking', category: 'thought_level', currentValue: s.thinking, options: model.thinking.map((value) => ({ value, name: 'Thinking ' + value })) }] : []),
    { type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: s.mode, options: modes.map((value) => ({ value, name: value })) },
  ];
};
// Like Kimi, model, thinking and mode are per process and reset on resume.
const open = (id, cwd, mcpServers) => {
  const s = { id, cwd, mcpServers, model: 'kimi-code/k3', thinking: 'max', mode: 'default' };
  state.set(id, s);
  return { configOptions: options(s), modes: { currentModeId: s.mode, availableModes: modes.map((id) => ({ id, name: id })) } };
};
let active;
const pending = new Map();
let nextId = 0;
const ask = (method, params, onResult) => {
  const id = 'kimi-' + ++nextId;
  pending.set(id, onResult);
  send({ id, method, params });
};
const end = (stopReason) => {
  if (!active) return;
  const current = active;
  active = undefined;
  send({ id: current.id, result: { stopReason } });
  if (settings().lateAfterEnd) chunk(current.sessionId, 'late output');
};
const begin = (frame) => {
  const config = settings();
  const { sessionId } = frame.params;
  const text = frame.params.prompt.map((block) => block.text).join('');
  fs.writeFileSync(path.join(sessions, sessionId + '.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(sessions, sessionId + '.json'), 'utf8')), turns: true }));
  if (text === 'rpc-error') { send({ id: frame.id, error: { code: -32603, message: 'session prompt failed' } }); return; }
  active = { id: frame.id, sessionId, text };
  if (text === 'hold' || config.holdTurn) { if (config.chunkBeforeHold) chunk(sessionId, 'Working'); return; }
  if (text === 'silent') { end('end_turn'); return; }
  if (text === 'exit') { chunk(sessionId, 'Starting'); setTimeout(() => process.exit(1), 20); return; }
  if (text === 'refuse') { end('refusal'); return; }
  if (text === 'limit') { chunk(sessionId, 'Partial'); end('max_turn_requests'); return; }
  if (text === 'ask' || text === 'ask-many') {
    const choices = [{ const: 'One', title: 'One', description: 'First result' }, { const: 'Two', title: 'Two', description: 'Second result' }];
    const properties = text === 'ask'
      ? { q0: { type: 'string', title: 'Result', description: 'Pick one', oneOf: choices } }
      : { q0: { type: 'string', title: 'Result', oneOf: choices }, q1: { type: 'array', title: 'Extras', minItems: 1, items: { anyOf: choices } } };
    const message = text === 'ask' ? 'Which result?' : 'Which result?\nWhich extras?';
    ask('elicitation/create', { sessionId, toolCallId: 't1:ask', mode: 'form', message, requestedSchema: { type: 'object', properties, required: Object.keys(properties) } }, (result) => {
      chunk(sessionId, 'Answer: ' + JSON.stringify(result));
      end('end_turn');
    });
    return;
  }
  if (text === 'permission' || text === 'ask-permission') {
    const permissionOptions = text === 'permission'
      ? [{ optionId: 'approve_always', name: 'Always', kind: 'allow_always' }, { optionId: 'approve_once', name: 'Once', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }]
      : [{ optionId: 'q0_opt_0', name: 'One', kind: 'allow_once' }, { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' }];
    ask('session/request_permission', { sessionId, toolCall: { toolCallId: 't1:perm', title: text === 'permission' ? 'Shell' : 'AskUserQuestion' }, options: permissionOptions }, (result) => {
      chunk(sessionId, 'Permission: ' + JSON.stringify(result.outcome));
      end('end_turn');
    });
    return;
  }
  if (text === 'tools') {
    chunk(sessionId, 'Thinking about it', 'agent_thought_chunk');
    chunk(sessionId, 'Let me ');
    chunk(sessionId, 'check.');
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1:shell', title: 'Shell', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo hi' }, content: [{ type: 'content', content: { type: 'text', text: '{"command":"echo hi"}' } }] });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1:shell', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'hi' } }], rawOutput: 'hi' });
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1:edit', title: 'Edit notes.md', kind: 'edit', status: 'in_progress', rawInput: { path: 'notes.md' } });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1:edit', status: 'failed', content: [{ type: 'diff', path: '/tmp/notes.md', oldText: '', newText: 'x' }] });
    update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'Check', priority: 'high', status: 'completed' }, { content: 'Report', priority: 'high', status: 'in_progress' }] });
    chunk(sessionId, 'Done');
    end('end_turn');
    return;
  }
  chunk(sessionId, 'Reply: ');
  chunk(sessionId, text);
  end('end_turn');
};
const handlers = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: settings().noResume ? { delete: {} } : { list: {}, resume: {}, close: {}, delete: {} }, mcpCapabilities: { http: !settings().noHttpMcp, sse: true } }, authMethods: [{ id: 'login', type: 'terminal', name: 'Login with Kimi account' }], agentInfo: { name: 'Kimi Code CLI', version: '2.1.1' } }),
  authenticate: () => { if (settings().unauthenticated) throw { code: -32000, message: 'Authentication required' }; return {}; },
  'session/new': ({ cwd, mcpServers }) => {
    const id = 'session_' + crypto.randomUUID();
    fs.writeFileSync(path.join(sessions, id + '.json'), JSON.stringify({ id, cwd }));
    return { sessionId: id, ...open(id, cwd, mcpServers) };
  },
  'session/resume': ({ sessionId, cwd, mcpServers }) => {
    if (!fs.existsSync(path.join(sessions, sessionId + '.json'))) throw { code: -32602, message: 'Invalid params: Unknown sessionId: ' + sessionId, data: { sessionId } };
    return open(sessionId, cwd, mcpServers);
  },
  'session/load': ({ sessionId, cwd, mcpServers }) => {
    if (!fs.existsSync(path.join(sessions, sessionId + '.json'))) throw { code: -32602, message: 'Invalid params: Unknown sessionId: ' + sessionId };
    update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed' } });
    chunk(sessionId, 'replayed answer');
    return open(sessionId, cwd, mcpServers);
  },
  'session/delete': ({ sessionId }) => { fs.rmSync(path.join(sessions, sessionId + '.json'), { force: true }); return {}; },
  'session/set_config_option': ({ sessionId, configId, value }) => {
    const s = state.get(sessionId);
    if (!s) throw { code: -32602, message: 'Unknown sessionId' };
    if (configId === 'model') {
      const model = models.find((entry) => entry.value === value);
      if (!model) throw { code: -32602, message: 'Unknown model' };
      s.model = value;
      if (model.thinking.length && !model.thinking.includes(s.thinking)) s.thinking = model.thinking.at(-1);
    } else if (configId === 'thinking') {
      if (!models.find((entry) => entry.value === s.model).thinking.includes(value)) throw { code: -32602, message: 'Unsupported thinking' };
      s.thinking = value;
    } else if (configId === 'mode') {
      s.mode = value;
      update(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: value });
    } else throw { code: -32602, message: 'Unknown config option' };
    update(sessionId, { sessionUpdate: 'config_option_update', configOptions: options(s) });
    return { configOptions: options(s) };
  },
};
let busy = 0;
setInterval(() => {
  if (active && settings().releaseHeld) { chunk(active.sessionId, 'Released'); end('end_turn'); }
}, 10).unref();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  record(frame);
  if (frame.jsonrpc !== '2.0') { process.exit(3); }
  if (!frame.method) {
    const onResult = pending.get(frame.id);
    pending.delete(frame.id);
    onResult?.(frame.result);
    return;
  }
  if (frame.method === 'session/cancel') {
    if (active && active.sessionId === frame.params.sessionId) {
      end('cancelled');
      if (settings().lateAfterCancel) chunk(frame.params.sessionId, 'late after cancel');
    }
    return;
  }
  if (frame.method === 'session/prompt') {
    if (settings().busy > busy || active) {
      busy++;
      send({ id: frame.id, error: { code: -32600, message: 'Invalid request', data: { code: 'turn.agent_busy' } } });
      return;
    }
    if (settings().exitOnPrompt) process.exit(1);
    begin(frame);
    return;
  }
  const handler = handlers[frame.method];
  if (!handler) { send({ id: frame.id, error: { code: -32601, message: 'Method not found' } }); return; }
  try {
    send({ id: frame.id, result: handler(frame.params) });
  } catch (error) {
    send({ id: frame.id, error });
  }
});
`,
  );
  return {
    home,
    binary,
    set: (settings: Record<string, unknown>) => writeFile(scenario, JSON.stringify(settings)),
    records: async () =>
      (await readFile(log, 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
