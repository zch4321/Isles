import { createRequire } from 'node:module';
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const carrierRequire = createRequire(process.argv[1]);
export const native = (name) => import(pathToFileURL(carrierRequire.resolve(name)).href);

// Canonicalize on each call, just as the native workspace grant does. A missing
// shared directory fails closed; a symlink must grant its actual target.
export function sharedRoot(config) {
  if (typeof config.sharedDir !== 'string' || !isAbsolute(config.sharedDir))
    throw new Error('Isles DSH sharedDir must be an absolute path');
  return realpathSync.native(config.sharedDir);
}

export const sbplString = (path) =>
  `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
