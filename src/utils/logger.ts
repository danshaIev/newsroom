import pino from 'pino';

/** Redact API keys from log output */
const redactPaths = [
  'apiKey',
  'ANTHROPIC_API_KEY',
  'BRAVE_API_KEY',
  'YDC_API_KEY',
  '*.apiKey',
  '*.headers.authorization',
];

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname',
          translateTime: 'HH:MM:ss',
        },
      },
});

/** Create a child logger for a specific component */
export function createLogger(component: string, extra?: Record<string, unknown>) {
  return logger.child({ component, ...extra });
}
