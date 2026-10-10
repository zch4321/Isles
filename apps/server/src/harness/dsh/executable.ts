import {
  findCliExecutable,
  type CliCommand,
  type CliDiscoveryOptions,
  type CliExecutable,
} from '../shared/executable.js';
import { desktopCommand, windowsInstallDirectories } from './desktop.js';

/** The Desktop carrier publishes the same CLI as the npm distribution. */
export function findDshExecutable(
  options: CliDiscoveryOptions = {},
  probe?: (command: CliCommand) => Promise<string>,
): Promise<CliExecutable> {
  return findCliExecutable(
    {
      name: 'dsh',
      displayName: 'DeepSeek Harness',
      npmEntry: '@deepseek-ai/dsh/lib/bin.js',
      versionPattern: /^0\.2\.\d+(?:[-+][\w.-]+)?$/,
      resolveCommand: desktopCommand,
      installDirectories: (home, environment) =>
        (options.platform ?? process.platform) === 'darwin'
          ? [
              '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin',
              `${home}/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin`,
            ]
          : (options.platform ?? process.platform) === 'win32'
            ? windowsInstallDirectories(home, environment)
            : [],
    },
    options,
    probe,
  );
}
