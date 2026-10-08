import type { AppConfig } from '@isles/config';
import type { FastifyBaseLogger } from 'fastify';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export type Logger = FastifyBaseLogger;

const noop = () => {};
/** Discards every entry; the default for workspaces built outside the server entry. */
export const silentLogger: Logger = {
  level: 'silent',
  fatal: noop,
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop,
  silent: noop,
  child: () => silentLogger,
};

export interface LogStream {
  write(line: string): void;
  close(): void;
}

const day = 24 * 60 * 60 * 1000;
export const logRetention = {
  maxAgeMs: 7 * day,
  maxBytes: 100 * 1024 * 1024,
  fileBytes: 10 * 1024 * 1024,
};
const logFileName = /^isles-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;

interface LogFileEntry {
  name: string;
  date: string;
  index: number;
  size: number;
  mtimeMs: number;
}

function localDate(time: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
}

/**
 * Daily JSON Lines files, split into numbered segments. Pruning removes files older than the
 * retention period and the oldest files beyond the size limit, reserving room for the open one.
 */
export class LogFile implements LogStream {
  private fd: number | undefined;
  private name = '';
  private size = 0;
  private nextDay = 0;
  private reported = false;
  private readonly timer: NodeJS.Timeout;
  constructor(
    readonly dir: string,
    private readonly limits = logRetention,
    private readonly now = () => new Date(),
  ) {
    this.guard(() => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.prune();
    });
    // Retention also applies while the server is idle and writes nothing.
    this.timer = setInterval(() => this.guard(() => this.prune()), 60 * 60 * 1000);
    this.timer.unref();
  }
  write(line: string) {
    this.guard(() => {
      const bytes = Buffer.byteLength(line);
      const now = this.now();
      const rotate =
        this.fd === undefined ||
        now.getTime() >= this.nextDay ||
        (this.size > 0 && this.size + bytes > this.limits.fileBytes);
      if (rotate) this.open(now, bytes);
      writeSync(this.fd!, line);
      this.size += bytes;
      this.reported = false;
      if (rotate) this.prune();
    });
  }
  close() {
    clearInterval(this.timer);
    this.closeFile();
  }
  private open(now: Date, bytes: number) {
    this.closeFile();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const date = localDate(now);
    const last = this.files()
      .filter((file) => file.date === date)
      .at(-1);
    const next = last && last.size > 0 && last.size + bytes > this.limits.fileBytes;
    const index = next ? last.index + 1 : (last?.index ?? 0);
    this.name = index ? `isles-${date}.${index}.log` : `isles-${date}.log`;
    this.fd = openSync(join(this.dir, this.name), 'a', 0o600);
    this.size = next ? 0 : (last?.size ?? 0);
    this.nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  }
  private closeFile() {
    if (this.fd === undefined) return;
    const fd = this.fd;
    this.fd = undefined;
    closeSync(fd);
  }
  private files(): LogFileEntry[] {
    const files: LogFileEntry[] = [];
    for (const name of readdirSync(this.dir)) {
      const match = logFileName.exec(name);
      if (!match) continue;
      const stats = statSync(join(this.dir, name));
      files.push({
        name,
        date: match[1]!,
        index: Number(match[2] ?? 0),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    }
    return files.sort((a, b) => a.date.localeCompare(b.date) || a.index - b.index);
  }
  private prune() {
    const cutoff = this.now().getTime() - this.limits.maxAgeMs;
    let total = this.limits.fileBytes;
    for (const file of this.files().reverse()) {
      if (file.name === this.name) continue;
      total += file.size;
      if (file.mtimeMs < cutoff || total > this.limits.maxBytes)
        unlinkSync(join(this.dir, file.name));
    }
  }
  /** Logging failures stay out of the caller; the first one is reported on stderr. */
  private guard(action: () => void) {
    try {
      action();
    } catch (error) {
      if (this.reported) return;
      this.reported = true;
      process.stderr.write(
        `Isles cannot write log files in ${this.dir}: ${String(error)}. Check the directory permissions and free disk space.\n`,
      );
    }
  }
}

/** Every entry goes to stdout, pretty-printed when requested, and to the JSON log files. */
export async function openLogOutput(
  config: AppConfig,
  options: { pretty: boolean },
): Promise<LogStream> {
  const file = new LogFile(config.logDir);
  const console: { write(line: string): unknown } = options.pretty
    ? (await import('pino-pretty')).default({
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
      })
    : process.stdout;
  return {
    write(line) {
      console.write(line);
      file.write(line);
    },
    close() {
      file.close();
    },
  };
}
