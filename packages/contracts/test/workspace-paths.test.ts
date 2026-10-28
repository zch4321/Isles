import { describe, expect, it } from 'vitest';
import {
  createAgentSchema,
  createGroupSchema,
  updateAgentSchema,
  updateChannelSchema,
  workspacePathsSchema,
  workspaceSettingsUpdateSchema,
} from '../src/index.js';

describe('workspace path contracts', () => {
  it('defaults creation paths, trims entries, accepts clearing and permits accumulated lists', () => {
    expect(
      createAgentSchema.parse({
        harness: 'codex',
        name: 'A',
        model: 'model',
        reasoningEffort: 'high',
      }).workspacePaths,
    ).toEqual([]);
    expect(createGroupSchema.parse({ name: 'Group', memberIds: [] }).workspacePaths).toEqual([]);
    expect(workspacePathsSchema.parse(['  folder  '])).toEqual(['folder']);
    expect(updateAgentSchema.parse({ workspacePaths: [] })).toEqual({ workspacePaths: [] });
    expect(updateChannelSchema.parse({ workspacePaths: [] })).toEqual({ workspacePaths: [] });
    expect(workspaceSettingsUpdateSchema.parse({ workspacePaths: [] })).toEqual({
      workspacePaths: [],
    });
    expect(
      workspacePathsSchema.parse(Array.from({ length: 100 }, (_, index) => `p${index}`)),
    ).toHaveLength(100);
  });

  it.each(['', '  ', 'a\nb', 'a\rb', '\rleading', 'trailing\n', 'a\0b', 'a'.repeat(4097)])(
    'rejects blank, oversized and control-character paths: %j',
    (path) => expect(workspacePathsSchema.safeParse([path]).success).toBe(false),
  );
});
