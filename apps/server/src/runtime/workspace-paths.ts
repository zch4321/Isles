import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { workspacePathsSchema } from '@isles/contracts';
import { HttpError } from '../errors.js';

export function workspacePathKey(path: string): string {
  const value = normalize(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** Resolve configured aliases for comparison; a removed directory can still be edited out. */
export function workspacePathIdentity(path: string): string {
  try {
    return workspacePathKey(realpathSync.native(path));
  } catch {
    return workspacePathKey(path);
  }
}

/** Stored paths are canonical; merging never touches or removes project files. */
export function mergeWorkspacePaths(...groups: readonly (readonly string[])[]): string[] {
  const paths = new Map<string, string>();
  for (const group of groups)
    for (const path of group) {
      const key = workspacePathKey(path);
      if (!paths.has(key)) paths.set(key, path);
    }
  return [...paths.values()];
}

/** Resolve user-selected directories on the server host before persisting them. */
export function normalizeWorkspacePaths(input: readonly string[]): string[] {
  const paths = workspacePathsSchema.parse(input);
  return mergeWorkspacePaths(
    paths.map((path) => {
      if (!isAbsolute(path)) throw new HttpError(400, `请填写工作区的绝对路径：${path}`);
      try {
        const canonical = realpathSync.native(path);
        if (!statSync(canonical).isDirectory())
          throw new HttpError(400, `工作区路径需要指向目录：${path}`);
        return canonical;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, `工作区目录无法访问，请检查路径：${path}`);
      }
    }),
  );
}

/** Each native connection captures its Agent's configured additional directories. */
export function additionalWorkspacePaths(
  agent: { workspacePaths: readonly string[] },
  sharedDir: string,
): string[] {
  return mergeWorkspacePaths([sharedDir], agent.workspacePaths);
}
