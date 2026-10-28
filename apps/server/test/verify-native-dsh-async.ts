import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { findDshExecutable } from '../src/harness/dsh/executable.js';
import { eventSchema } from '../src/harness/dsh/protocol.js';
import type { z } from 'zod';

// Real rc3 loader, agent loop and asynchronous subagent manager; all inference
// uses the scripted in-process adapter. The protocol smoke checks real MCP.
const root = await mkdtemp(join(tmpdir(), 'isles-dsh-native-async-'));
console.log(`DSH asynchronous lifecycle files: ${root}`);
const command = await findDshExecutable(
  process.env.ISLES_DSH_BIN ? { binary: process.env.ISLES_DSH_BIN } : {},
);
const home = join(root, 'home');
await mkdir(home);
const patch = join(root, 'overlay.json');
await writeFile(
  patch,
  JSON.stringify([
    { id: 'sdk-jsonrpc-server', disabled: true },
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-deepseek-account', disabled: true },
    {
      insert: [
        {
          id: 'isles-native-async-fixture',
          name: fileURLToPath(new URL('./dsh-native-async-fixture.mjs', import.meta.url)),
          config: { mcpMarker: true },
        },
        {
          id: 'isles-dsh-bridge',
          name: fileURLToPath(new URL('../resources/dsh-bridge.mjs', import.meta.url)),
          config: { additionalDirs: [] },
        },
      ],
    },
  ]),
);
const child = spawn(command.file, [...command.args, '--profile', 'sdk', '--patch', patch], {
  cwd: root,
  env: {
    ...process.env,
    ...command.env,
    DSH_HOME: home,
    ISLES_DSH_ASYNC_AUDIT: join(root, 'native-events.jsonl'),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
const events: z.infer<typeof eventSchema>[] = [];
const pending = new Map<
  number,
  {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }
>();
let requestId = 0;
let stderr = '';
child.stderr.on('data', (value: Buffer) => {
  stderr += value.toString();
});
createInterface({ input: child.stdout }).on('line', (line) => {
  const frame = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: unknown;
    error?: { message: string };
    result?: unknown;
  };
  if (frame.method === 'isles/event') events.push(eventSchema.parse(frame.params));
  if (frame.id === undefined) return;
  const request = pending.get(frame.id);
  if (!request) return;
  pending.delete(frame.id);
  clearTimeout(request.timer);
  if (frame.error) request.reject(new Error(frame.error.message));
  else request.resolve(frame.result);
});
child.on('exit', () => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error('Native DSH process exited'));
  }
  pending.clear();
});
function request(method: string, params: object = {}) {
  return new Promise<unknown>((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Native DSH request timed out: ${method}`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
const report: Record<string, unknown> = { root, version: command.version };
try {
  await request('isles/catalog');
  await request('isles/session/create', {
    sessionId: 'scripted-root',
    cwd: root,
    dangerFullAccess: true,
    selection: { provider: 'isles-scripted', model: 'scripted' },
  });
  await request('isles/session/submit', {
    sessionId: 'scripted-root',
    messageId: 'scripted-input',
    text: 'scripted task',
  });
  const deadline = Date.now() + 15_000;
  while (
    events.filter((frame) => frame.event.type === 'turn_completed').length < 3 &&
    Date.now() < deadline
  )
    await delay(25);
  const rootStarts = events.filter(
    (frame) => frame.sessionId === 'scripted-root' && frame.event.type === 'turn_started',
  );
  const rootEnds = events.filter(
    (frame) => frame.sessionId === 'scripted-root' && frame.event.type === 'turn_completed',
  );
  const childEvents = events.filter((frame) => frame.sessionId === 'external-child');
  assert.deepEqual(
    rootStarts.map((frame) => ('turnId' in frame.event ? frame.event.turnId : undefined)),
    ['1', '2'],
  );
  assert.deepEqual(
    rootEnds.map((frame) => ('turnId' in frame.event ? frame.event.turnId : undefined)),
    ['1', '2'],
  );
  assert.deepEqual(
    childEvents.map((frame) => frame.event.type),
    ['turn_started', 'item', 'item', 'turn_completed'],
  );
  assert.equal(
    new Set(childEvents.map((frame) => ('turnId' in frame.event ? frame.event.turnId : undefined)))
      .size,
    1,
  );
  const childEnd = childEvents.at(-1)?.event;
  assert.equal(childEnd?.type === 'turn_completed' && childEnd.status, 'completed');
  assert(events.every((frame) => frame.rootSessionId === 'scripted-root'));
  assert(events.indexOf(rootEnds[0]!) < events.indexOf(childEvents.at(-1)!));
  Object.assign(report, {
    passed: true,
    rootTurns: ['1', '2'],
    childSessionId: 'external-child',
    remoteInferenceRequests: 0,
  });
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  try {
    await request('shutdown');
  } catch {
    child.kill();
  }
  await writeFile(join(root, 'events.json'), JSON.stringify(events, null, 2));
  await writeFile(join(root, 'stderr.log'), stderr);
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
