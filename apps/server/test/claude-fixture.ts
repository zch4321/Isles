import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A real stdio process replaying the CLI 2.1.285 wire shapes captured in native probes. */
export async function claudeFixture(root: string) {
  const home = join(root, 'claude-home');
  await mkdir(home, { recursive: true });
  const binary = join(root, 'claude-fixture.cjs');
  const scenario = join(home, 'fixture.json');
  const log = join(home, 'wire.jsonl');
  await writeFile(scenario, '{}');
  await writeFile(
    binary,
    String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('2.1.285 (Claude Code)'); process.exit(0); }
const home = process.env.CLAUDE_CONFIG_DIR;
const settings = () => JSON.parse(fs.readFileSync(path.join(home, 'fixture.json'), 'utf8'));
if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: !settings().unauthenticated, authMethod: 'oauth_token' })); process.exit(0); }
const args = process.argv.slice(2);
const value = (flag) => {
  const equal = args.find((arg) => arg.startsWith(flag + '='));
  return equal ? equal.slice(flag.length + 1) : args[args.indexOf(flag) + 1];
};
const resume = args.some((arg) => arg === '--resume' || arg.startsWith('--resume='));
const sid = value(resume ? '--resume' : '--session-id') || crypto.randomUUID();
const record = (entry) => fs.appendFileSync(path.join(home, 'wire.jsonl'), JSON.stringify(entry) + '\n');
record({ type: 'launch', args, cwd: process.cwd(), home, hasToken: Boolean(process.env.ISLES_MCP_TOKEN), sessionId: sid });
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
const sessions = path.join(home, 'sessions');
fs.mkdirSync(sessions, { recursive: true });
if (resume && !fs.existsSync(path.join(sessions, sid + '.json'))) {
  send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, errors: ['No conversation found with session ID: ' + sid] });
  process.exit(1);
}
let active;
let question;
let folded = [];
const queued = new Map();
let mcpReads = 0;
let pendingContextResponse;
const acknowledge = (frame) => {
  send({ type: 'command_lifecycle', state: 'started', command_uuid: frame.uuid, session_id: sid });
  send({ type: 'user', uuid: frame.uuid, isReplay: true, session_id: sid, parent_tool_use_id: null, message: frame.message });
};
const finish = (message, error = false) => {
  if (!active) return;
  const current = active;
  active = undefined;
  const consumed = [current.uuid, ...folded];
  const representative = settings().resultUsesSteerUuid && folded.length ? folded.at(-1) : current.uuid;
  send({ type: 'assistant', uuid: crypto.randomUUID(), session_id: sid, parent_tool_use_id: null, user_message_uuid: representative, message: { id: 'msg-' + current.uuid, content: [{ type: 'text', text: message }] } });
  send({ type: 'result', subtype: 'success', is_error: error, result: message, session_id: sid, uuid: crypto.randomUUID(), user_message_uuid: representative, user_message_uuids: consumed, queued_turn_count: queued.size, usage: { input_tokens: 900000, output_tokens: 100000 } });
  folded = [];
  // Like the CLI, run queued input as the next turn shortly after the result.
  if (queued.size && !settings().holdQueued) setTimeout(next, 20);
};
const next = () => {
  if (active || !queued.size) return;
  const [uuid, frame] = queued.entries().next().value;
  queued.delete(uuid);
  begin(frame);
};
setInterval(() => {
  if (active && !active.message.content.startsWith('Isles session initialized.') && settings().releaseHeld) finish('Released');
}, 10).unref();
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const frame = JSON.parse(line);
  record(frame);
  const config = settings();
  if (frame.type === 'control_request') {
    let response = {};
    const request = frame.request;
    if (request.subtype === 'initialize') {
      if (config.blockInitialize) return;
      response = { hooks_applied: true, models: [
        { value: 'default', displayName: 'Default', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'] },
        { value: 'haiku', displayName: 'Haiku' },
      ] };
    } else if (request.subtype === 'get_context_usage') {
      if (config.contextError) { send({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: config.contextError } }); return; }
      response = { totalTokens: config.contextTokens ?? 1024, maxTokens: 200000, rawMaxTokens: 200000, memoryFiles: ['CLAUDE.md', ...(config.missingGuidance ? [] : ['AGENTS.md'])].map((name) => ({ path: path.join(process.cwd(), name), type: 'Project', tokens: 10 })) };
      if (config.reverseContextResponses) {
        response.totalTokens = config.reverseContextResponses[pendingContextResponse ? 1 : 0];
        const reply = () => send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } });
        if (!pendingContextResponse) { pendingContextResponse = reply; return; }
        reply();
        pendingContextResponse();
        pendingContextResponse = undefined;
        send({ type: 'system', subtype: 'context_responses_replayed', session_id: sid });
        return;
      }
    } else if (request.subtype === 'mcp_status') {
      response = { mcpServers: [{ name: 'isles', status: config.failedMcp ? 'failed' : config.pendingMcp && !mcpReads++ ? 'pending' : 'connected' }] };
    } else if (request.subtype === 'interrupt') {
      const cancelled = request.cancel_queued ? [...queued.keys()] : [];
      for (const id of cancelled) {
        queued.delete(id);
        send({ type: 'command_lifecycle', state: 'cancelled', command_uuid: id, session_id: sid });
      }
      response = { still_queued: [...queued.keys()], cancelled };
      finish('Interrupted', true);
    }
    send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } });
    return;
  }
  if (frame.type === 'control_response') {
    if (frame.response.request_id === 'bootstrap-hook') { finish(config.bootstrapFailure ? 'Bootstrap failed' : 'READY', Boolean(config.bootstrapFailure)); return; }
    if (question && frame.response.request_id === question.requestId) {
      send({ type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: question.toolId, content: JSON.stringify(frame.response.response), is_error: false }] } });
      question = undefined;
      finish('Question answered');
    }
    return;
  }
  if (frame.type !== 'user') return;
  if (config.exitOnInput) { process.exit(1); }
  if (active) {
    if (config.exitOnSteer) { process.exit(1); }
    queued.set(frame.uuid, frame);
    if (!config.dropSteerReceipt) send({ type: 'command_lifecycle', state: 'queued', command_uuid: frame.uuid, session_id: sid });
    if (config.subagentSteerAck) send({ type: 'user', uuid: frame.uuid, isReplay: true, session_id: sid, parent_tool_use_id: 'subagent-tool', message: frame.message });
    if (config.finishBeforeSteer) {
      finish('Original completed');
      return;
    }
    if (config.holdSteer || config.subagentSteerAck) return;
    queued.delete(frame.uuid);
    folded.push(frame.uuid);
    if (!config.resultOnlySteer) acknowledge(frame);
    if (config.steerQuestion) {
      const toolId = 'tool-' + frame.uuid;
      question = { toolId, requestId: 'question-' + frame.uuid };
      const input = { questions: [{ question: 'Which result?', header: 'Result', options: [{ label: 'One', description: 'First result' }, { label: 'Two', description: 'Second result' }] }] };
      send({ type: 'assistant', session_id: sid, parent_tool_use_id: null, user_message_uuid: frame.uuid, message: { content: [{ type: 'tool_use', id: toolId, name: 'AskUserQuestion', input }] } });
      send({ type: 'control_request', request_id: question.requestId, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: toolId, input } });
    } else if (!config.keepSteeredTurn) finish('Steered: ' + frame.message.content);
    return;
  }
  send({ type: 'command_lifecycle', state: 'queued', command_uuid: frame.uuid, session_id: sid });
  begin(frame);
});
function begin(frame) {
  const config = settings();
  active = frame;
  fs.writeFileSync(path.join(sessions, sid + '.json'), JSON.stringify({ sid, input: frame.message.content }));
  acknowledge(frame);
  if (frame.message.content.startsWith('Isles session initialized.')) {
    if (config.blockBootstrap) return;
    send({ type: 'control_request', request_id: 'bootstrap-hook', request: { subtype: 'hook_callback', callback_id: 'isles-bootstrap', input: { hook_event_name: 'PreToolUse', tool_name: 'Bash' } } });
    return;
  }
  if (frame.message.content === 'hold' || config.holdTurn) return;
  if (frame.message.content === 'permission') {
    const toolId = 'tool-' + frame.uuid;
    question = { toolId, requestId: 'permission-' + frame.uuid };
    const input = { command: 'echo fixture' };
    send({ type: 'assistant', session_id: sid, user_message_uuid: frame.uuid, message: { content: [{ type: 'tool_use', id: toolId, name: 'Bash', input }] } });
    send({ type: 'control_request', request_id: question.requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: toolId, input } });
    return;
  }
  if (frame.message.content === 'ask') {
    const toolId = 'tool-' + frame.uuid;
    question = { toolId, requestId: 'question-' + frame.uuid };
    const input = { questions: [{ question: 'Which result?', header: 'Result', options: [{ label: 'One', description: 'First result' }, { label: 'Two', description: 'Second result' }], multiSelect: config.multiSelect ?? false }] };
    send({ type: 'assistant', session_id: sid, parent_tool_use_id: null, user_message_uuid: frame.uuid, message: { id: 'ask-' + frame.uuid, content: [{ type: 'tool_use', id: toolId, name: 'AskUserQuestion', input }] } });
    send({ type: 'control_request', request_id: question.requestId, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: toolId, input } });
    return;
  }
  if (frame.message.content === 'wrong-session') { send({ type: 'assistant', session_id: crypto.randomUUID(), message: { content: [] } }); return; }
  if (config.staleResult) send({ type: 'result', subtype: 'success', session_id: sid, user_message_uuid: crypto.randomUUID(), is_error: false });
  if (config.subagentResult) send({ type: 'result', subtype: 'success', session_id: crypto.randomUUID(), user_message_uuid: frame.uuid, parent_tool_use_id: 'subagent-tool', is_error: false });
  finish('Reply: ' + frame.message.content);
}
`,
  );
  return {
    home,
    binary,
    set: async (settings: Record<string, unknown>) => {
      const temporary = `${scenario}.tmp`;
      await writeFile(temporary, JSON.stringify(settings));
      await rename(temporary, scenario);
    },
    records: async () =>
      (await readFile(log, 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
