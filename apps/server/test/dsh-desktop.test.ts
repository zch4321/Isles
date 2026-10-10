import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { windowsInstallDirectories } from '../src/harness/dsh/desktop.js';

const registryQuery = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => undefined, {
    [Symbol.for('nodejs.util.promisify.custom')]: registryQuery,
  }),
}));
beforeEach(() => {
  registryQuery.mockReset();
});

describe('DSH Windows installation locations', () => {
  const home = join(tmpdir(), 'isles-dsh-registry');
  const environment = {
    SystemRoot: join(home, 'Windows'),
    LOCALAPPDATA: join(home, 'local'),
    ProgramFiles: join(home, 'programs'),
    'ProgramFiles(x86)': join(home, 'programs-x86'),
  };
  const bin = (install: string) => join(install, 'resources', 'runtime', 'cli', 'bin');

  it.each(['single', 'multiple'])(
    'reads %s registered locations including Unicode and spaces',
    async (shape) => {
      const install = join(home, '自定义 DeepSeek Harness');
      registryQuery.mockResolvedValue({
        stdout: JSON.stringify(shape === 'single' ? install : [install, null, '', 'relative-path']),
      });
      const directories = await windowsInstallDirectories(home, environment);
      expect(directories[0]).toBe(bin(install));
      expect(directories).toHaveLength(4);
    },
  );

  it('searches standard per-user and machine installs when the registry is unavailable', async () => {
    registryQuery.mockRejectedValue(new Error('Registry query failed'));
    expect(await windowsInstallDirectories(home, environment)).toEqual([
      bin(join(environment.LOCALAPPDATA, 'Programs', 'DeepSeek Harness')),
      bin(join(environment.ProgramFiles, 'DeepSeek Harness')),
      bin(join(environment['ProgramFiles(x86)'], 'DeepSeek Harness')),
    ]);
  });
});
