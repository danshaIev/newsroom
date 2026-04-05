import { describe, it, expect } from 'vitest';
import { validateUrl, validateOutputPath, safeJsonExtract, escapeHtml, isSafeEnvKey } from '../src/tools/security.js';

describe('validateUrl — SSRF prevention', () => {
  it('allows normal HTTP URLs', () => {
    expect(validateUrl('https://example.com')).toEqual({ ok: true });
    expect(validateUrl('http://api.sec.gov/filings')).toEqual({ ok: true });
  });

  it('blocks localhost', () => {
    expect(validateUrl('http://localhost:3000')).toMatchObject({ ok: false });
    expect(validateUrl('http://127.0.0.1:8080')).toMatchObject({ ok: false });
  });

  it('blocks private IP ranges — 10.x.x.x', () => {
    expect(validateUrl('http://10.0.0.1')).toMatchObject({ ok: false });
    expect(validateUrl('http://10.255.255.255')).toMatchObject({ ok: false });
  });

  it('blocks private IP ranges — 172.16-31.x.x', () => {
    expect(validateUrl('http://172.16.0.1')).toMatchObject({ ok: false });
    expect(validateUrl('http://172.31.255.255')).toMatchObject({ ok: false });
  });

  it('blocks private IP ranges — 192.168.x.x', () => {
    expect(validateUrl('http://192.168.1.1')).toMatchObject({ ok: false });
  });

  it('blocks AWS metadata endpoint', () => {
    expect(validateUrl('http://169.254.169.254/latest/meta-data/')).toMatchObject({ ok: false });
  });

  it('blocks file:// scheme', () => {
    expect(validateUrl('file:///etc/passwd')).toMatchObject({ ok: false });
  });

  it('blocks empty/invalid inputs', () => {
    expect(validateUrl('')).toMatchObject({ ok: false });
    expect(validateUrl('not-a-url')).toMatchObject({ ok: false });
  });

  it('blocks URLs exceeding max length', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2100);
    expect(validateUrl(longUrl)).toMatchObject({ ok: false });
  });
});

describe('validateOutputPath — path traversal prevention', () => {
  const projectDir = '/tmp/test-project';

  it('allows paths within project directory', () => {
    expect(validateOutputPath('/tmp/test-project/output.html', projectDir)).toEqual({ ok: true });
    expect(validateOutputPath('/tmp/test-project/.newsroom/report.pdf', projectDir)).toEqual({ ok: true });
  });

  it('blocks path traversal', () => {
    expect(validateOutputPath('/tmp/test-project/../../../etc/passwd', projectDir)).toMatchObject({ ok: false });
    expect(validateOutputPath('/etc/passwd', projectDir)).toMatchObject({ ok: false });
  });

  it('blocks writes to node_modules', () => {
    expect(validateOutputPath('/tmp/test-project/node_modules/evil.js', projectDir)).toMatchObject({ ok: false });
  });

  it('blocks writes to .git', () => {
    expect(validateOutputPath('/tmp/test-project/.git/hooks/pre-commit', projectDir)).toMatchObject({ ok: false });
  });
});

describe('safeJsonExtract', () => {
  it('extracts JSON array from text', () => {
    const text = 'Here are the findings:\n[{"claim": "test"}]\nEnd.';
    const result = safeJsonExtract(text, 'array');
    expect(result).toBe('[{"claim": "test"}]');
  });

  it('extracts JSON object from text', () => {
    const text = 'Result: {"rating": "CONFIRMED", "confidence": 0.9}';
    const result = safeJsonExtract(text, 'object');
    expect(result).toContain('"rating"');
  });

  it('returns null for text without JSON', () => {
    expect(safeJsonExtract('no json here', 'array')).toBeNull();
  });

  it('handles text up to 100K chars', () => {
    const padding = 'x'.repeat(90_000);
    const text = padding + '[{"claim": "found it"}]';
    expect(safeJsonExtract(text, 'array')).toBe('[{"claim": "found it"}]');
  });

  it('truncates at 100K chars to prevent ReDoS', () => {
    const text = 'x'.repeat(100_001) + '[{"claim": "hidden"}]';
    // The JSON is past the 100K limit, so it won't be found
    expect(safeJsonExtract(text, 'array')).toBeNull();
  });
});

describe('escapeHtml', () => {
  it('escapes all dangerous characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes ampersands', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe("it&#x27;s");
  });
});

describe('isSafeEnvKey', () => {
  it('allows whitelisted keys', () => {
    expect(isSafeEnvKey('ANTHROPIC_API_KEY')).toBe(true);
    expect(isSafeEnvKey('BRAVE_API_KEY')).toBe(true);
    expect(isSafeEnvKey('YDC_API_KEY')).toBe(true);
    expect(isSafeEnvKey('NODE_ENV')).toBe(true);
    expect(isSafeEnvKey('LOG_LEVEL')).toBe(true);
  });

  it('blocks non-whitelisted keys', () => {
    expect(isSafeEnvKey('__proto__')).toBe(false);
    expect(isSafeEnvKey('constructor')).toBe(false);
    expect(isSafeEnvKey('PATH')).toBe(false);
    expect(isSafeEnvKey('HOME')).toBe(false);
  });
});
