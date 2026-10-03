import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentRecord } from '../storage/store.js';

const begin = '<!-- isles:begin -->';
const end = '<!-- isles:end -->';
const templateUrl = new URL('../../resources/AGENTS.template.md', import.meta.url);
const quote = (value: string) =>
  JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

/** Update only the managed section, keeping user guidance before/after it byte-for-byte. */
export async function prepareGuidance(agent: AgentRecord, sharedDir: string) {
  const template = await readFile(templateUrl, 'utf8');
  const values: Record<string, string> = {
    AGENT_NAME: quote(agent.name),
    WORKSPACE: quote(agent.workspace),
    SHARED_DIR: quote(sharedDir),
  };
  const content = template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key: string) => {
    if (values[key] === undefined) throw new Error(`Unknown guidance placeholder: ${key}`);
    return values[key];
  });
  const section = `${begin}\n${content.trimEnd()}\n${end}`;
  const path = join(agent.workspace, 'AGENTS.md');
  let previous = '';
  try {
    previous = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const starts = [...previous.matchAll(/^<!-- isles:begin -->\r?$/gm)];
  const ends = [...previous.matchAll(/^<!-- isles:end -->\r?$/gm)];
  if (
    starts.length > 1 ||
    ends.length > 1 ||
    starts.length !== ends.length ||
    (starts.length && starts[0]!.index! >= ends[0]!.index!)
  )
    throw new Error(`AGENTS.md 的 Isles 托管段标记无效，请检查 ${path}`);
  const next = starts.length
    ? previous.slice(0, starts[0]!.index) +
      section +
      previous.slice(ends[0]!.index! + ends[0]![0].length)
    : `${section}\n${previous ? `\n${previous}` : ''}`;
  if (next === previous) return;
  const temporary = join(agent.workspace, `.AGENTS.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, next, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
