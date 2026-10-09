import type { ConfigManager } from '@isles/config';
import { AcpAdapter } from './acp/adapter.js';
import { CodexAdapter } from './codex/adapter.js';
import { NativeEnvironment } from './codex/environment.js';
import { ClaudeAdapter } from './claude/adapter.js';
import { ClaudeEnvironment } from './claude/environment.js';
import { KimiEnvironment } from './kimi/environment.js';
import type { AgentWorkspace } from '../runtime/workspace.js';
import type { HarnessAdapter } from './types.js';

/** Register implementations here; unimplemented harnesses never appear in the directory. */
export function defaultAdapters(
  config: ConfigManager,
  workspace: AgentWorkspace,
): HarnessAdapter[] {
  return [
    new CodexAdapter(new NativeEnvironment(config, workspace)),
    new ClaudeAdapter(new ClaudeEnvironment(config, workspace)),
    new AcpAdapter(new KimiEnvironment(config, workspace)),
  ];
}
