import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Electron ASAR imports only; no app, profile, agent loop or model starts.
process.argv[1] = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json';
const { native } = await import('../resources/dsh-shared-roots.mjs');
const { Context } = await native('@deepseek-ai/cordis');
const { default: Fs } = await import('../resources/dsh-fs-shared.mjs');
const { default: Sandbox } = await import('../resources/dsh-sandbox-shared.mjs');
const { LocalSandboxProvider } = await native('@deepseek-ai/dsh-sandbox-local');
const { ApprovalService } = await native('@deepseek-ai/dsh-user-approval');

// Keep deny targets outside platform temp grants.
const root = await mkdtemp(join(homedir(), '.isles-dsh-sandbox-check-'));
const privateDir = join(root, 'agent', 'workspace');
const shared = join(root, 'shared');
const other = join(root, 'other-agent');
await Promise.all([privateDir, shared, other].map((dir) => mkdir(dir, { recursive: true })));
try {
  const policy = { mode: 'workspace-write', workspaceRoot: privateDir, sessionId: 'fixture' };
  const ctx = new Context();
  ctx.provide('sandboxPolicy', { defaultMode: policy.mode, resolve: () => policy });
  const fs = new Fs(ctx, Fs.Config({ cwd: privateDir, sharedDir: shared }));
  const sandbox = new Sandbox(new Context(), Sandbox.Config({ sharedDir: shared }));
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
      fs: true,
      seatbelt: true,
      linuxProfiles: true,
      windowsGrantContract: true,
      nativeApprovalAudit: true,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
