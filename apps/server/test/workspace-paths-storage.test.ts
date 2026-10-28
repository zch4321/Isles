import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/database.js';
import { Store } from '../src/storage/store.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups.length = 0;
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'isles-workspace-paths-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const open = () => {
    const database = openDatabase(join(root, 'data'));
    cleanups.push(() => {
      if (database.sqlite.open) database.sqlite.close();
    });
    return new Store(database, join(root, 'workspace'));
  };
  const store = open();
  const path = (name: string) => join(root, name);
  const create = (name: string, workspacePaths: string[] = []) =>
    store.createAgent({
      harness: 'codex',
      name,
      model: 'test-model',
      reasoningEffort: 'high',
      nativeHome: join(root, 'native'),
      canCreateGroups: true,
      workspacePaths,
    });
  return { store, open, path, create };
}

describe('workspace directory persistence and append semantics', () => {
  it('uses platform path identity for case variants and deduplicates trimmed inputs', () => {
    const { store, create, path } = fixture();
    const original = path('project');
    const a = create('A', [original, ` ${original} `]);
    expect(a.workspacePaths).toEqual([original]);
    store.appendWorkspacePaths([a.id], [original.toUpperCase()]);
    expect(store.getAgent(a.id).workspacePaths).toEqual(
      process.platform === 'win32' ? [original] : [original, original.toUpperCase()],
    );
  });

  it('persists Agent and group paths, deduplicates additions and publishes changed Agents', () => {
    const { store, open, create, path } = fixture();
    const a = create('A', [path('own'), path('own')]);
    const b = create('B');
    const group = store.createGroup('user', 'Shared', [a.id, b.id], [path('shared')]);
    expect(store.getAgent(a.id).workspacePaths).toEqual([path('own'), path('shared')]);
    expect(store.publicChannel(a.channelId).workspacePaths).toEqual([]);
    const cursor = store.cursor();
    expect(store.appendWorkspacePaths([a.id, b.id, a.id], [path('next'), path('shared')])).toEqual([
      a.id,
      b.id,
    ]);
    expect(store.eventsAfter(cursor).map((event) => [event.type, event.agentId])).toEqual([
      ['agent', a.id],
      ['agent', b.id],
    ]);
    const after = store.cursor();
    expect(store.appendWorkspacePaths([a.id], [path('next')])).toEqual([]);
    expect(store.cursor()).toBe(after);
    const reopened = open();
    expect(reopened.getAgent(a.id).workspacePaths).toEqual([
      path('own'),
      path('shared'),
      path('next'),
    ]);
    expect(reopened.publicChannel(group.id).workspacePaths).toEqual([path('shared')]);
  });

  it('keeps a manual Agent removal during no-op group saves and appends only newly added paths', () => {
    const { store, create, path } = fixture();
    const a = create('A');
    const group = store.createGroup('user', 'Shared', [a.id], [path('shared')]);
    store.updateAgent(a.id, { workspacePaths: [] });
    store.updateChannel(group.id, { workspacePaths: [path('shared')] });
    expect(store.addMembers(group.id, 'user', [a.id])).toEqual([]);
    expect(store.getAgent(a.id).workspacePaths).toEqual([]);
    store.updateChannel(group.id, { workspacePaths: [path('shared'), path('new')] });
    expect(store.getAgent(a.id).workspacePaths).toEqual([path('new')]);
    store.updateChannel(group.id, { workspacePaths: [] });
    expect(store.getAgent(a.id).workspacePaths).toEqual([path('new')]);
  });

  it('appends current paths on each join and retains paths when leaving or deleting groups', () => {
    const { store, create, path } = fixture();
    const a = create('A');
    const b = create('B');
    const group = store.createGroup('user', 'Shared', [a.id], [path('shared')]);
    expect(store.addMembers(group.id, 'user', [b.id])).toEqual([b.id]);
    expect(store.getAgent(b.id).workspacePaths).toEqual([path('shared')]);
    store.removeMember(group.id, b.id);
    expect(store.getAgent(b.id).workspacePaths).toEqual([path('shared')]);
    store.updateAgent(b.id, { workspacePaths: [] });
    store.updateChannel(group.id, { workspacePaths: [path('shared'), path('new')] });
    expect(store.getAgent(b.id).workspacePaths).toEqual([]);
    store.addMembers(group.id, 'user', [b.id]);
    expect(store.getAgent(b.id).workspacePaths).toEqual([path('shared'), path('new')]);
    store.deleteGroup(group.id);
    expect(store.getAgent(a.id).workspacePaths).toEqual([path('shared'), path('new')]);
    expect(store.getAgent(b.id).workspacePaths).toEqual([path('shared'), path('new')]);
  });

  it('appends more than 64 combined paths and rolls back failed batches atomically', () => {
    const { store, create, path } = fixture();
    const paths = Array.from({ length: 64 }, (_, index) => path(`p-${index}`));
    const a = create('A', paths);
    const group = store.createGroup('user', 'Shared', [a.id], [path('shared')]);
    expect(store.getAgent(a.id).workspacePaths).toEqual([...paths, path('shared')]);
    store.updateChannel(group.id, { workspacePaths: [path('extra')] });
    expect(store.getAgent(a.id).workspacePaths).toEqual([...paths, path('shared'), path('extra')]);
    const before = store.cursor();
    expect(() => store.appendWorkspacePaths([a.id, 'missing'], [path('rollback')])).toThrow(
      'Agent 不存在',
    );
    expect(store.getAgent(a.id).workspacePaths).toEqual([...paths, path('shared'), path('extra')]);
    expect(store.cursor()).toBe(before);
  });
});
