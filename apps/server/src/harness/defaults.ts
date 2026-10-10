import type { ConfigManager } from '@isles/config';
import { CodexAdapter } from './codex/adapter.js';
import { NativeEnvironment } from './codex/environment.js';
import { ClaudeAdapter } from './claude/adapter.js';
import { ClaudeEnvironment } from './claude/environment.js';
import { KimiWebAdapter } from './kimi/web-adapter.js';
import { KimiWebEnvironment } from './kimi/web-environment.js';
import { OpenCodeAdapter } from './opencode/adapter.js';
import { OpenCodeEnvironment } from './opencode/environment.js';
import { DshAdapter } from './dsh/adapter.js';
import { DshEnvironment } from './dsh/environment.js';
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
    new KimiWebAdapter(new KimiWebEnvironment(config, workspace)),
    new OpenCodeAdapter(new OpenCodeEnvironment(config, workspace)),
    new DshAdapter(new DshEnvironment(config, workspace)),
  ];
}
