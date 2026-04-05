import { resolve } from 'path';

/**
 * Shared security utilities for all tools.
 * URL validation, path safety, input sanitization.
 */

// Private/internal IP ranges that should never be fetched
const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,    // AWS metadata / link-local
  /^0\.0\.0\.0$/,
  /^\[::1\]$/,                // IPv6 localhost
  /^\[fc00:/i,                // IPv6 private
  /^\[fd00:/i,                // IPv6 private
  /^\[fe80:/i,                // IPv6 link-local
];

const ALLOWED_SCHEMES = ['http:', 'https:'];

const MAX_URL_LENGTH = 2048;

/** Validate a URL is safe to fetch — blocks SSRF attacks */
export function validateUrl(url: string): { ok: boolean; reason?: string } {
  if (!url || typeof url !== 'string') {
    return { ok: false, reason: 'Empty or invalid URL' };
  }

  if (url.length > MAX_URL_LENGTH) {
    return { ok: false, reason: `URL exceeds max length (${MAX_URL_LENGTH})` };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'Malformed URL' };
  }

  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return { ok: false, reason: `Blocked scheme: ${parsed.protocol} (only http/https allowed)` };
  }

  const hostname = parsed.hostname;
  for (const pattern of BLOCKED_HOSTS) {
    if (pattern.test(hostname)) {
      return { ok: false, reason: `Blocked host: ${hostname} (private/internal network)` };
    }
  }

  // Block numeric IPs that resolve to private ranges (basic check)
  if (/^\d+$/.test(hostname)) {
    return { ok: false, reason: 'Blocked: numeric-only hostname' };
  }

  return { ok: true };
}

/** Validate a file path stays within the project directory */
export function validateOutputPath(outputPath: string, projectDir: string): { ok: boolean; reason?: string } {
  const resolved = resolve(outputPath);
  const base = resolve(projectDir);

  if (!resolved.startsWith(base)) {
    return { ok: false, reason: `Path escapes project directory: ${resolved}` };
  }

  // Block writing to sensitive locations within the project
  const relative = resolved.slice(base.length);
  if (relative.includes('node_modules') || relative.includes('.git/')) {
    return { ok: false, reason: `Cannot write to protected directory: ${relative}` };
  }

  return { ok: true };
}

/** Escape a string for safe HTML output */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** Safely parse JSON with length limit — prevents ReDoS on regex extraction */
export function safeJsonExtract(text: string, type: 'array' | 'object'): string | null {
  // Limit input length to prevent catastrophic backtracking
  const limited = text.slice(0, 100_000);
  const pattern = type === 'array'
    ? /\[[\s\S]*?\](?=[^[\]]*$)/
    : /\{[\s\S]*?\}(?=[^{}]*$)/;
  const match = limited.match(pattern);
  return match ? match[0] : null;
}

/** Validate environment variable keys — prevent prototype pollution */
const SAFE_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'BRAVE_API_KEY',
  'YDC_API_KEY',
  'NODE_ENV',
  'LOG_LEVEL',
]);

export function isSafeEnvKey(key: string): boolean {
  return SAFE_ENV_KEYS.has(key);
}
