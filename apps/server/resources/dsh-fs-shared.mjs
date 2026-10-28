import { native, additionalRoots } from './dsh-shared-roots.mjs';

const { SandboxedFileSystem } = await native('@deepseek-ai/dsh-fs-sandbox');
const { default: z } = await native('@deepseek-ai/schemastery');

export default class IslesSharedFileSystem extends SandboxedFileSystem {
  static Config = z.intersect([
    SandboxedFileSystem.Config,
    z.object({ additionalDirs: z.array(z.string()).required() }),
  ]);

  async checkedTarget(target, policy = this.ctx.sandboxPolicy.resolve()) {
    try {
      return await super.checkedTarget(target, policy);
    } catch (error) {
      if (policy.mode !== 'workspace-write' || error?.code !== 'FS_SANDBOX_DENIED') throw error;
      // Reuse native containment, canonicalization and the checked write target
      // for every grant, including symlink escape detection.
      for (const root of additionalRoots(this.config)) {
        try {
          return await super.checkedTarget(target, { ...policy, workspaceRoot: root });
        } catch (denied) {
          if (denied?.code !== 'FS_SANDBOX_DENIED') throw denied;
        }
      }
      throw error;
    }
  }
}
