import {
  findCliExecutable,
  type CliCommand,
  type CliDiscoveryOptions,
  type CliExecutable,
} from '../harness/executable.js';

export function findKimiExecutable(
  options: CliDiscoveryOptions = {},
  probe?: (command: CliCommand) => Promise<string>,
): Promise<CliExecutable> {
  return findCliExecutable(
    {
      name: 'kimi',
      displayName: 'Kimi Code',
      npmEntry: '@moonshot-ai/kimi-code/dist/main.mjs',
      // `kimi --version` prints the bare package version.
      versionPattern: /^\d+\.\d+\.\d+$/,
    },
    options,
    probe,
  );
}
