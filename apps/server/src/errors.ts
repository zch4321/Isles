export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ErrorDetails {
  type: string;
  message: string;
  stack: string;
  [key: string]: unknown;
}

// Native errors and tool activity may contain credentials. Never expose raw stderr,
// native config or auth/account responses. Also scrub known private values.
export class Redactor {
  private secrets = new Set<string>();
  add(value: unknown): void {
    if (typeof value === 'string' && value.length >= 8) this.secrets.add(value);
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (/token|key|secret|authorization|cookie/i.test(key)) this.collect(child);
        else if (child && typeof child === 'object') this.add(child);
      }
    }
  }
  private collect(value: unknown): void {
    if (typeof value === 'string' && value.length >= 8) this.secrets.add(value);
    else if (value && typeof value === 'object')
      Object.values(value).forEach((v) => this.collect(v));
  }
  text(value: unknown): string {
    const output =
      typeof value === 'string'
        ? value
        : value instanceof Error
          ? value.message
          : '原生执行发生错误';
    return this.scrub(output).slice(0, 64_000);
  }
  /** Execution output is bounded by its consumer after scrubbing. */
  output(value: string): string {
    return this.scrub(value);
  }
  private scrub(value: string): string {
    let output = value;
    for (const secret of this.secrets) output = output.split(secret).join('[redacted]');
    return output
      .replace(/Bearer\s+[^\s"'\\]+/gi, 'Bearer [redacted]')
      .replace(/\b(?:sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
      .replace(
        /((?:access_token|refresh_token|api_key|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi,
        '$1[redacted]',
      );
  }
  /** Log form of an error, scrubbed like `text`; the server logger applies it to every `err`. */
  error(value: unknown, depth = 0): ErrorDetails {
    if (!(value instanceof Error))
      return { type: typeof value, message: this.text(value), stack: '' };
    const details: ErrorDetails = {
      type: value.constructor.name,
      message: this.text(value.message),
      stack: this.text(value.stack ?? ''),
    };
    const code: unknown = (value as NodeJS.ErrnoException).code;
    if (typeof code === 'string' || typeof code === 'number') details.code = code;
    if (value.cause !== undefined && depth < 3) details.cause = this.error(value.cause, depth + 1);
    return details;
  }
}
