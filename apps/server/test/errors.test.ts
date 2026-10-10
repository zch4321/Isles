import { describe, expect, it } from 'vitest';
import { Redactor } from '../src/errors.js';

describe('output redaction', () => {
  it('preserves long execution output and scrubs credentials beyond the diagnostic limit', () => {
    const redactor = new Redactor();
    redactor.add({ nested: { api_key: 'known-private-token' } });
    const prefix = 'x'.repeat(130_000);
    const value = `${prefix}\nknown-private-token\nBearer opaque-private-value\nTAIL`;
    expect(redactor.output(value)).toBe(`${prefix}\n[redacted]\nBearer [redacted]\nTAIL`);
    expect(redactor.text(value)).toBe(prefix.slice(0, 64_000));
  });

  it('uses identical known-secret and credential-pattern scrubbing for output and diagnostics', () => {
    const redactor = new Redactor();
    redactor.add('known-private-token');
    const value = [
      'known-private-token',
      'Bearer opaque-private-value',
      'sk-secret-12345',
      'eyJheader.payload.signature',
      'access_token=private-access',
      'refresh_token:private-refresh',
      'api_key=private-key',
      'authorization=private-auth',
      'cookie:private-cookie',
    ].join('\n');
    const expected = [
      '[redacted]',
      'Bearer [redacted]',
      '[redacted]',
      '[redacted]',
      'access_token=[redacted]',
      'refresh_token:[redacted]',
      'api_key=[redacted]',
      'authorization=[redacted]',
      'cookie:[redacted]',
    ].join('\n');
    expect(redactor.output(value)).toBe(expected);
    expect(redactor.text(value)).toBe(expected);
  });

  it('retains diagnostic conversion, error scrubbing and the 64K error limit', () => {
    const redactor = new Redactor();
    redactor.add('known-private-token');
    expect(redactor.text({ message: 'untrusted object' })).toBe('原生执行发生错误');
    expect(redactor.text(new Error('known-private-token'))).toBe('[redacted]');
    const error = new Error('x'.repeat(70_000));
    error.stack = `known-private-token\n${'s'.repeat(70_000)}`;
    const result = redactor.error(error);
    expect(result.message).toHaveLength(64_000);
    expect(result.stack).toHaveLength(64_000);
    expect(result.stack).toMatch(/^\[redacted\]\n/);
  });
});
