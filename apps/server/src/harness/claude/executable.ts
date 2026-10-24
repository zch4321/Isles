import { join } from 'node:path';
import {
  findCliExecutable,
  type CliCommand,
  type CliDiscoveryOptions,
  type CliExecutable,
} from '../shared/executable.js';

export type ClaudeCommand = CliCommand;
export type ClaudeExecutable = CliExecutable;

export function findClaudeExecutable(
  options: CliDiscoveryOptions = {},
  probe?: (command: CliCommand) => Promise<string>,
): Promise<ClaudeExecutable> {
  return findCliExecutable(
    {
      name: 'claude',
      displayName: 'Claude Code',
      npmEntry: '@anthropic-ai/claude-code/bin/claude.exe',
      versionPattern: /^\d+\.\d+\.\d+[^\r\n]*\(Claude Code\)/,
      installDirectories: (home) => [
        join(home, '.claude', 'local'),
        join(home, '.claude', 'local', 'node_modules', '.bin'),
      ],
    },
    options,
    probe,
  );
}
