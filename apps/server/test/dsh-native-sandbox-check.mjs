import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The native Loader mounts only filesystem tools and sandbox providers.
// No SDK transport, user profile, agent loop or model starts.
const [root, overlayPath, privateDir, shared] = process.argv.slice(2);
process.argv[1] = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json';
const { native } = await import('../resources/dsh-shared-roots.mjs');
const { Context } = await native('@deepseek-ai/cordis');
const { boot, composeEntries, loadOverlayPatches } = await native('@deepseek-ai/dsh-app-boot');
const { default: Fs } = await import('../resources/dsh-fs-shared.mjs');
const { default: Sandbox } = await import('../resources/dsh-sandbox-shared.mjs');
const { LocalSandboxProvider } = await native('@deepseek-ai/dsh-sandbox-local');
const { ApprovalService } = await native('@deepseek-ai/dsh-user-approval');

const other = join(root, 'other-agent');
await Promise.all([privateDir, shared, other].map((dir) => mkdir(dir, { recursive: true })));
const bundle = (name) =>
  join(dirname(process.argv[1]), 'node_modules/@deepseek-ai', name, 'cordis.patch.yml');
const warnings = [];
const entries = composeEntries(
  [
    loadOverlayPatches('isles-test', bundle('dsh-base')),
    loadOverlayPatches('isles-test', bundle('dsh-sdk-minimal')),
    loadOverlayPatches('isles-test', overlayPath),
  ],
  (warning) => warnings.push(warning),
);
assert.deepEqual(warnings, [], 'The generated overlay must apply without skipped patches');
const mounted = entries.filter(
  (entry) =>
    ['fs-sandbox', 'sandbox', 'isles-fs-shared', 'isles-sandbox-shared'].includes(entry.id) ||
    entry.name === '@deepseek-ai/dsh-tool-fs',
);
const configPath = join(root, 'cordis.json');
await writeFile(configPath, '[]');
let mode = 'workspace-write';
const policy = { mode, workspaceRoot: privateDir, sessionId: 'fixture' };
const tools = new Map();
const ctx = await boot(
  'isles-test',
  configPath,
  [{ insert: mounted }],
  (scope) => {
    scope.provide('sandboxPolicy', {
      defaultMode: policy.mode,
      resolve: () => ({ ...policy, mode }),
    });
    scope.provide('tools', {
      register: (tool) => tools.set(tool.name, tool),
      get: (name) => tools.get(name),
    });
    scope.provide('systemPrompt', { section() {}, getSectionOrder: () => 0 });
  },
  pathToFileURL(process.argv[1]).href,
);
try {
  const fs = ctx.get('fs');
  const sandbox = ctx.get('sandbox');
  assert(fs instanceof Fs, 'The native Loader must mount the shared filesystem extension');
  assert(
    sandbox instanceof Sandbox,
    'The native Loader must mount the shared shell sandbox extension',
  );
  const execute = { signal: new globalThis.AbortController().signal, callId: 'fixture' };
  const toolWrite = tools.get('write');
  const toolRead = tools.get('read');
  assert(toolWrite && toolRead, 'Native file tools must register');
  const toolPath = join(shared, 'native-tool.txt');
  await toolWrite.execute({ file_path: toolPath, content: 'native-tool-ok' }, execute);
  assert.equal(await readFile(toolPath, 'utf8'), 'native-tool-ok');
  await toolRead.execute({ file_path: toolPath }, execute);
  await assert.rejects(
    toolWrite.execute({ file_path: join(other, 'tool-denied.txt'), content: 'denied' }, execute),
    /sandbox: file access denied/,
  );
  mode = 'read-only';
  await assert.rejects(
    toolWrite.execute({ file_path: join(shared, 'tool-readonly.txt'), content: 'denied' }, execute),
    /sandbox: file access denied/,
  );
  mode = 'workspace-write';
  const write = async (path, mode = policy.mode) =>
    fs.writeText(await fs.resolve(path), 'native-ok', undefined, undefined, { ...policy, mode });
  await write(join(privateDir, 'own.txt'));
  await write(join(shared, 'shared.txt'));
  await assert.rejects(write(join(other, 'denied.txt')), { code: 'FS_SANDBOX_DENIED' });
  await assert.rejects(write(join(root, 'denied.txt')), { code: 'FS_SANDBOX_DENIED' });
  await symlink(other, join(shared, 'escape'));
  await assert.rejects(write(join(shared, 'escape', 'denied.txt')), { code: 'FS_SANDBOX_DENIED' });
  await assert.rejects(write(join(shared, 'readonly.txt'), 'read-only'), {
    code: 'FS_SANDBOX_DENIED',
  });
  await write(join(other, 'full.txt'), 'danger-full-access');
  await writeFile(join(other, 'readable.txt'), 'outside-readable');
  const readable = await fs.readText(await fs.resolve(join(other, 'readable.txt')));
  assert.equal(readable, 'outside-readable');

  const shell = async (path, mode = policy.mode, command = 'printf shell-ok > "$1"') => {
    const confined = await sandbox.confine(['/bin/sh', '-c', command, 'fixture', path], {
      ...policy,
      mode,
    });
    return spawnSync(confined.argv[0], confined.argv.slice(1), {
      cwd: privateDir,
      encoding: 'utf8',
    });
  };
  assert.equal((await shell(join(privateDir, 'shell-own.txt'))).status, 0);
  assert.equal((await shell(join(shared, 'shell-shared.txt'))).status, 0);
  assert.notEqual((await shell(join(other, 'shell-denied.txt'))).status, 0);
  assert.notEqual((await shell(join(shared, 'escape', 'shell-denied.txt'))).status, 0);
  assert.notEqual((await shell(join(shared, 'shell-readonly.txt'), 'read-only')).status, 0);
  assert.equal(
    (await shell(join(other, 'readable.txt'), policy.mode, 'cat "$1"')).stdout,
    'outside-readable',
  );
  assert.equal(await readFile(join(shared, 'shell-shared.txt'), 'utf8'), 'shell-ok');

  const bwrap = sandbox.runnerArgv('bwrap', policy);
  assert.deepEqual(bwrap.slice(-3), ['--bind', shared, shared]);
  assert(!bwrap.includes(other));
  sandbox.landlockLauncher = () => 'landlock-fixture';
  const landlock = sandbox.runnerArgv('landlock', policy);
  assert(landlock.includes(shared));
  assert(!landlock.includes(other));
  assert.throws(
    () => sandbox.windowsAclRunnerArgv({ ...policy, sessionId: undefined }),
    /require a native session/,
  );

  // The extension adds shared as a revocable native grant. Native teardown
  // disposes the same grant object; no independent ACL store is introduced.
  const materialize = LocalSandboxProvider.prototype.materializeAclGrant;
  try {
    const granted = [];
    const capability = { dir: '/fixture-temp', writeSid: 'fixture-temp-sid' };
    LocalSandboxProvider.prototype.materializeAclGrant = () => capability;
    sandbox.workspaceGrants.set(privateDir, { add: (...args) => granted.push(args), dispose() {} });
    assert.equal(sandbox.materializeAclGrant('fixture', privateDir), capability);
    assert.equal(sandbox.materializeAclGrant('fixture', privateDir), capability);
    assert.deepEqual(granted, [[shared]]);
  } finally {
    LocalSandboxProvider.prototype.materializeAclGrant = materialize;
  }

  const approvalCtx = new Context();
  approvalCtx.on('approval/request', () => Promise.resolve('allowed-once'), { global: true });
  const approval = new ApprovalService(approvalCtx, { policy: 'ask' });
  const events = [{ type: 'turn/start', data: { turn: 1 } }];
  const session = {
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    append: (type, data) => events.push({ type, data }),
  };
  assert.equal(
    await approval.request({
      agent: { session },
      toolName: 'write',
      callId: 'one-shot',
      reason: 'fixture',
    }),
    'allowed-once',
  );
  assert.equal(events.at(-2).type, 'approval/asked');
  assert.equal(events.at(-1).type, 'approval/decided');
  assert.equal(events.at(-2).data.id, events.at(-1).data.id);
  assert.equal(events.at(-1).data.outcome, 'allowed-once');
  console.log(
    JSON.stringify({
      nativeOverlay: true,
      nativeFileTools: true,
      fs: true,
      seatbelt: true,
      linuxProfiles: true,
      windowsGrantContract: true,
      nativeApprovalAudit: true,
    }),
  );
} finally {
  await ctx.fiber.dispose();
}
