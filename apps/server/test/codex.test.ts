import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { StdioClient } from '../src/harness/codex/client.js';
import { NativeEnvironment } from '../src/harness/codex/environment.js';
import { AgentWorkspace, agentRoot, MCP_TOKEN_ENV } from '../src/runtime/workspace.js';
import { Redactor } from '../src/errors.js';
import { silentLogger } from '../src/logging.js';
import type { AgentRecord } from '../src/storage/store.js';
import { testConfig } from './helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups.length = 0;
  delete process.env.ISLES_TEST_PROVIDER_KEY;
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'isles-codex-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('Codex native boundaries', () => {
  it('runs every Agent in the shared Codex home without copying or writing it, keeping the MCP token out of config', async () => {
    const dir = await directory();
    const home = join(dir, 'codex-home');
    const workspace = join(dir, 'workspace', 'agents', 'agent-1', 'workspace');
    await mkdir(home);
    const auth = JSON.stringify({
      tokens: { access_token: 'test-access-secret', refresh_token: 'test-refresh-secret' },
    });
    const config =
      'model_provider="custom"\n[model_providers.custom]\nname="Custom"\nenv_key="ISLES_TEST_PROVIDER_KEY"\n[mcp_servers.global]\ncommand="global-mcp"\n';
    await writeFile(join(home, 'auth.json'), auth);
    await writeFile(join(home, 'config.toml'), config);
    process.env.ISLES_TEST_PROVIDER_KEY = 'test-provider-secret';
    const before = await readdir(home);
    const appConfig = testConfig(dir, { ISLES_CODEX_HOME: home });
    const appWorkspace = new AgentWorkspace(appConfig);
    const environment = new NativeEnvironment(appConfig, appWorkspace);
    const agent = {
      id: 'agent-1',
      name: 'Test Agent',
      channelId: 'private-1',
      workspace,
    } as AgentRecord;
    const env = await environment.launch(agent);
    expect(env.CODEX_HOME).toBe(home);
    const token = env[MCP_TOKEN_ENV]!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await appWorkspace.token(agentRoot(dir, agent))).toBe(token);
    // Windows does not implement POSIX permission bits; retain the mode assertion on Unix.
    if (process.platform !== 'win32')
      expect((await stat(join(agentRoot(dir, agent), 'isles-mcp-token'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(workspace, '.isles-root'), 'utf8')).toContain('Isles');
    // Only the workspace and token belong to Isles; the human's home is left as it was.
    expect(await readdir(home)).toEqual(before);
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(config);
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(auth);
    expect((await readdir(agentRoot(dir, agent))).sort()).toEqual(['isles-mcp-token']);
    expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8')).toContain(
      JSON.stringify(appWorkspace.sharedDir),
    );
    expect(await readdir(appWorkspace.sharedDir)).toEqual([]);
    const thread = environment.threadConfig(agent, 'http://127.0.0.1:1');
    expect(thread).toMatchObject({
      'mcp_servers.isles': {
        url: 'http://127.0.0.1:1/mcp/agent-1',
        bearer_token_env_var: MCP_TOKEN_ENV,
      },
    });
    // Native sub-agents follow the human's own Codex settings.
    expect(Object.keys(thread).filter((k) => k.startsWith('features.'))).toEqual([]);
    expect(JSON.stringify(thread)).not.toContain(token);
    expect(
      environment.redactor.text(
        `test-access-secret test-refresh-secret test-provider-secret ${token}`,
      ),
    ).toBe('[redacted] [redacted] [redacted] [redacted]');
  });

  it('parses fragmented JSONL, associates out-of-order replies, and responds to native requests', async () => {
    const dir = await directory();
    await writeFile(
      join(dir, 'app-server'),
      `
const readline = require('node:readline');
const send = (v) => { const s=JSON.stringify(v)+'\\n'; process.stdout.write(s.slice(0,3)); setTimeout(()=>process.stdout.write(s.slice(3)), 1); };
let initialized=false;
readline.createInterface({input:process.stdin}).on('line', line=>{
 const f=JSON.parse(line);
 if(f.method==='initialize') send({id:f.id,result:{userAgent:'fake'}});
 else if(f.method==='initialized') initialized=true;
 else if(f.method==='one') setTimeout(()=>send({id:f.id,result:{name:'one'}}),40);
 else if(f.method==='two') {send({id:f.id,result:{name:'two'}});setTimeout(()=>send({id:901,method:'native/question',params:{value:'hello'}}),10);}
 else if(f.id===901) send({method:'answer/received',params:{result:f.result,initialized}});
 else if(f.method==='exit') process.exit(7);
});
`,
    );
    const notifications: Record<string, unknown>[] = [];
    const exits: string[] = [];
    const client = new StdioClient(
      process.execPath,
      dir,
      {},
      {
        notification: (_method, params) => notifications.push(params),
        request: (id) => client.respond(id, { answer: 'yes' }),
        exit: (e) => exits.push(e.message),
      },
      new Redactor(),
      silentLogger,
    );
    cleanups.push(() => client.close());
    await client.initialize();
    expect(await Promise.all([client.request('one', {}), client.request('two', {})])).toEqual([
      { name: 'one' },
      { name: 'two' },
    ]);
    await expect
      .poll(() => notifications)
      .toEqual([{ result: { answer: 'yes' }, initialized: true }]);
    await expect(client.request('exit', {})).rejects.toThrow('已退出');
    expect(exits).toHaveLength(1);
  });

  it.skipIf(!process.env.ISLES_TEST_CODEX_BIN)(
    'supports the documented version-matched protocol regeneration command',
    async () => {
      // No network or real model invocation: the real binary is optional in tests.
      const command = process.env.ISLES_TEST_CODEX_BIN!;
      const dir = await directory();
      await promisify(execFile)(command, ['app-server', 'generate-ts', '--out', dir]);
      expect(await readFile(join(dir, 'v2', 'ThreadStartParams.ts'), 'utf8')).toContain(
        'ephemeral',
      );
    },
  );
});
