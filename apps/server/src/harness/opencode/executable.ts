import {
  findCliExecutable,
  type CliCommand,
  type CliDiscoveryOptions,
  type CliExecutable,
} from '../shared/executable.js';

export function findOpenCodeExecutable(
  options: CliDiscoveryOptions = {},
  probe?: (command: CliCommand) => Promise<string>,
): Promise<CliExecutable> {
  return findCliExecutable(
    {
      name: 'opencode',
      displayName: 'OpenCode',
      npmEntry: 'opencode-ai/bin/opencode',
      versionPattern: /^opencode v2\.\d+\.\d+(?:[-+][\w.-]+)?$/,
      installDirectories: (home) => [`${home}/.opencode/bin`],
    },
    options,
    probe,
  );
}
