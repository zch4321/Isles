import { native, sbplString, additionalRoots } from './dsh-shared-roots.mjs';

const { LocalSandboxProvider } = await native('@deepseek-ai/dsh-sandbox-local');
const { grantArgs } = await native('@deepseek-ai/node-addon-system/landlock-run');
const { default: z } = await native('@deepseek-ai/schemastery');

export default class IslesSharedSandbox extends LocalSandboxProvider {
  static Config = z.intersect([
    LocalSandboxProvider.Config,
    z.object({ additionalDirs: z.array(z.string()).required() }),
  ]);

  constructor(ctx, config) {
    // The extension relies on native runner dialects, including their probes.
    if (config.runnerCommand?.length)
      throw new Error('Isles DSH shared roots require a native sandbox runner');
    super(ctx, config);
    this.sharedConfig = config;
    this.sharedGrants = new Map();
  }

  runnerArgv(runner, policy) {
    if (policy.mode !== 'workspace-write') return super.runnerArgv(runner, policy);
    const roots = additionalRoots(this.sharedConfig);
    if (runner === 'landlock')
      return [
        this.landlockLauncher(),
        ...grantArgs({
          readOnly: ['/'],
          readWrite: ['/dev/null', '/tmp', policy.workspaceRoot, ...roots],
        }),
      ];
    const argv = super.runnerArgv(runner, policy);
    if (runner === 'bwrap') return [...argv, ...roots.flatMap((root) => ['--bind', root, root])];
    if (runner === 'seatbelt') {
      const index = argv.indexOf('-p');
      if (index < 0 || typeof argv[index + 1] !== 'string')
        throw new Error('Isles DSH native Seatbelt profile is unavailable');
      argv[index + 1] += roots
        .map((root) => ` (allow file-write* (subpath ${sbplString(root)}))`)
        .join('');
    } else if (runner !== 'windows-acl')
      throw new Error(`Isles DSH unsupported sandbox runner: ${runner}`);
    return argv;
  }

  windowsAclRunnerArgv(policy) {
    if (policy.mode === 'workspace-write' && policy.sessionId === undefined)
      throw new Error('Isles DSH Windows shared writes require a native session');
    return super.windowsAclRunnerArgv(policy);
  }

  materializeAclGrant(sessionId, workspaceRoot) {
    const capability = super.materializeAclGrant(sessionId, workspaceRoot);
    const roots = additionalRoots(this.sharedConfig);
    const granted = this.sharedGrants.get(workspaceRoot) ?? new Set();
    for (const root of roots) {
      if (granted.has(root)) continue;
      const grant = this.workspaceGrants.get(workspaceRoot);
      if (!grant) throw new Error('Isles DSH Windows workspace grant is unavailable');
      // The native restricted token already carries this workspace's SID. Give
      // that same SID access to each root. Native disposal revokes these grants
      // with the workspace grant; only private's reuse ACE stays standing.
      grant.add(root);
      granted.add(root);
      this.sharedGrants.set(workspaceRoot, granted);
    }
    return capability;
  }

  revokeAclGrants() {
    try {
      super.revokeAclGrants();
    } finally {
      this.sharedGrants.clear();
    }
  }
}
