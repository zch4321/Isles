import { createRequire } from 'node:module';
import process from 'node:process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const carrierRequire = createRequire(process.argv[1]);
export const native = (name) => import(pathToFileURL(carrierRequire.resolve(name)).href);

// Match native workspace grants: canonicalize at use time and grant symlink
// targets. Every configured root must remain an existing directory.
export function additionalRoots(config) {
  if (!Array.isArray(config.additionalDirs))
    throw new Error('Isles DSH additionalDirs must be an array');
  const roots = new Map();
  for (const dir of config.additionalDirs) {
    if (typeof dir !== 'string' || !isAbsolute(dir))
      throw new Error('Isles DSH additionalDirs must contain absolute paths');
    const root = realpathSync.native(dir);
    if (!statSync(root).isDirectory())
      throw new Error('Isles DSH additionalDirs must contain directories');
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    roots.set(key, root);
  }
  return [...roots.values()];
}

export const sbplString = (path) =>
  `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
