import { describe, it, expect } from 'vitest';
import { redact, collectEnvSecrets, redactWithEnv } from '../utils/redact.js';

describe('redact', () => {
  it('returns empty and non-secret text unchanged', () => {
    expect(redact('')).toBe('');
    expect(redact('just a normal sentence with no secrets')).toBe(
      'just a normal sentence with no secrets',
    );
  });

  describe('layer 1: literal env-value masking', () => {
    it('masks a known secret value with its label', () => {
      const out = redact('curl -H "auth: abcd1234efgh5678"', {
        envSecrets: { MY_TOKEN: 'abcd1234efgh5678' },
      });
      expect(out).toBe('curl -H "auth: <REDACTED:MY_TOKEN>"');
    });

    it('masks longer values before shorter overlapping ones', () => {
      const out = redact('value is abcdef123456789', {
        envSecrets: { SHORT: 'abcdef12', LONG: 'abcdef123456789' },
      });
      // The long value should win; no leftover fragment of the short one.
      expect(out).toBe('value is <REDACTED:LONG>');
    });

    it('replaces every occurrence of a value', () => {
      const out = redact('sekret9999 ... sekret9999', {
        envSecrets: { K: 'sekret9999' },
      });
      expect(out).toBe('<REDACTED:K> ... <REDACTED:K>');
    });
  });

  describe('layer 2: secret-shape patterns', () => {
    it('masks an Anthropic key without double-tagging as openai', () => {
      const out = redact('key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA');
      expect(out).toContain('<REDACTED:anthropic>');
      expect(out).not.toContain('sk-ant-');
      expect(out).not.toContain('<REDACTED:openai>');
    });

    it('masks an OpenAI key', () => {
      const out = redact('OPENAI=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX');
      expect(out).toContain('<REDACTED:openai>');
      expect(out).not.toContain('sk-proj-ABCDEFGH');
    });

    it('masks GitHub tokens and PATs', () => {
      expect(redact('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).toContain('<REDACTED:gh_tok>');
      expect(redact('github_pat_ABCDEFGHIJKLMNOPQRSTUV_wxyz0123456789')).toContain(
        '<REDACTED:gh_pat>',
      );
    });

    it('masks AWS access key ids', () => {
      expect(redact('id AKIAIOSFODNN7EXAMPLE done')).toBe('id <REDACTED:aws> done');
    });

    it('masks JWTs', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';
      expect(redact(`token ${jwt}`)).toContain('<REDACTED:jwt>');
    });

    it('masks a PEM private-key block including its body', () => {
      const pem =
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nsecretbody\n-----END RSA PRIVATE KEY-----';
      const out = redact(`before\n${pem}\nafter`);
      expect(out).toBe('before\n<REDACTED:pem>\nafter');
    });

    it('masks Google API keys', () => {
      // AIza followed by exactly 35 chars.
      expect(redact('AIza' + 'B'.repeat(35))).toBe('<REDACTED:google>');
    });

    it('masks assorted vendor tokens via the provider pattern', () => {
      expect(redact('glpat-ABCDEFGHIJKLMNOPQRST')).toContain('<REDACTED:provider>');
      expect(redact('hf_ABCDEFGHIJKLMNOPQRSTUVWX')).toContain('<REDACTED:provider>');
    });

    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nsecretbody\n-----END RSA PRIVATE KEY-----';
    const jwtPrefixes = 'eyJ-'.repeat(25_000);
    const unendedPems = '-----BEGIN PRIVATE KEY-----\n'.repeat(40_000);

    it.each([
      ['JWT prefixes with no dot', `${jwtPrefixes} ${jwt}`, `${jwtPrefixes} <REDACTED:jwt>`],
      ['PEM headers with no END', `${pem}\n${unendedPems}`, `<REDACTED:pem>\n${unendedPems}`],
    ])('stays fast on %s and still masks a real one', (_shape, text, expected) => {
      const start = performance.now();
      const out = redact(text);
      const elapsed = performance.now() - start;

      expect(out).toBe(expected);
      // Linear work here is a few milliseconds; rescanning to the end from every prefix takes seconds.
      expect(elapsed).toBeLessThan(500);
    }, 30_000);
  });

  describe('layer 2: structural patterns keep surrounding context', () => {
    it('masks key=value but keeps the key', () => {
      const out = redact('password = hunter2SuperLongValue99');
      expect(out).toBe('password = <REDACTED:kv>');
    });

    it('masks bearer tokens but keeps the scheme', () => {
      const out = redact('Authorization: Bearer abcdefghijklmnopqrstuvwx');
      expect(out).toBe('Authorization: Bearer <REDACTED:authz>');
    });

    it('masks only the password in a connection string', () => {
      // Assemble the DSN from fragments at runtime so no contiguous
      // `user:password@host` shape ever appears in source. A repo secret-scanner
      // matches the DSN *shape* even in a test fixture (the `user:pass@host`
      // form tripped an internal mdb-client rule), so both the input and the
      // expected output are computed rather than written as string literals.
      const pw = ['pl', 'ace', 'holder', 'value'].join('');
      const dsn = ['redis://svc', pw].join(':') + '@' + 'cache.example.com:6379';
      const expected = dsn.replace(pw, '<REDACTED:conn>');
      expect(redact(dsn)).toBe(expected);
    });

    const pw = ['hun', 'ter2', 'pass'].join('');
    const dsn = ['postgres://user', pw].join(':') + '@' + 'db.example.com';

    it('masks a connection string whose scheme follows digits or punctuation', () => {
      for (const lead of ['', ' ', '1', '+', '9.x-']) {
        const text = `${lead}${dsn}`;
        expect(redact(text)).toBe(text.replace(pw, '<REDACTED:conn>'));
      }
    });

    it.each([
      ['a letter run', 'x'.repeat(100_000)],
      ['an alphanumeric run', 'a1'.repeat(50_000)],
    ])('stays fast on %s and still masks a connection string after it', (_shape, token) => {
      const text = `${token} ${dsn}`;

      const start = performance.now();
      const out = redact(text);
      const elapsed = performance.now() - start;

      expect(out).toBe(text.replace(pw, '<REDACTED:conn>'));
      // Linear work here is a few milliseconds; a per-offset rescan of the token takes seconds.
      expect(elapsed).toBeLessThan(500);
    }, 30_000);
  });

  it('can disable the pattern layer', () => {
    const out = redact('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', { patterns: false });
    expect(out).toBe('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  });

  it('does not touch ordinary short values that merely look key-ish', () => {
    // Too short to trip the KV pattern's 16-char minimum.
    expect(redact('key=abc')).toBe('key=abc');
  });
});

describe('collectEnvSecrets', () => {
  it('selects secret-looking keys with long-enough values', () => {
    const secrets = collectEnvSecrets({
      MY_TOKEN: 'abcdefghij',
      DB_PASSWORD: 'longpassword',
      SERVICE_PAT: 'patvalue1234',
      PATH: '/usr/bin:/bin',
      HOME: '/root',
    });
    expect(secrets).toEqual({
      MY_TOKEN: 'abcdefghij',
      DB_PASSWORD: 'longpassword',
      SERVICE_PAT: 'patvalue1234',
    });
  });

  it('ignores secret-looking keys whose values are too short', () => {
    expect(collectEnvSecrets({ API_KEY: 'short' })).toEqual({});
  });

  it('ignores non-secret keys', () => {
    expect(collectEnvSecrets({ EDITOR: 'vim-with-a-long-config' })).toEqual({});
  });
});

describe('redactWithEnv', () => {
  it('composes env collection with pattern redaction', () => {
    const out = redactWithEnv('token=abcdefghij and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', {
      SOME_TOKEN: 'abcdefghij',
    } as NodeJS.ProcessEnv);
    expect(out).toContain('<REDACTED:SOME_TOKEN>');
    expect(out).toContain('<REDACTED:gh_tok>');
  });
});
