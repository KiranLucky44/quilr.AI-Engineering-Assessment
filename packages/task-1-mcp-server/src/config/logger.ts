export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function parseLogLevel(raw: string | undefined): LogLevel {
  if (!raw) {
    return 'info';
  }
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === 'debug' ||
    normalized === 'info' ||
    normalized === 'warn' ||
    normalized === 'error' ||
    normalized === 'silent'
  ) {
    return normalized;
  }
  return 'info';
}

export interface StderrLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Creates a structured JSON logger that writes EXCLUSIVELY to `process.stderr`.
 *
 * CRITICAL MCP INVARIANT:
 * `stdout` is strictly reserved for JSON-RPC 2.0 protocol frames over stdio.
 * This logger never invokes `console.log` or `process.stdout.write`.
 */
export function createStderrLogger(
  component = 'task-1-mcp-server',
  explicitLevel?: LogLevel,
): StderrLogger {
  const configuredLevel = explicitLevel ?? parseLogLevel(process.env['MCP_SERVER_LOG_LEVEL']);
  const threshold = LEVEL_PRIORITY[configuredLevel];

  const write = (
    level: Exclude<LogLevel, 'silent'>,
    message: string,
    meta?: Record<string, unknown>,
  ): void => {
    if (LEVEL_PRIORITY[level] < threshold) {
      return;
    }

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
    };

    if (meta && Object.keys(meta).length > 0) {
      entry['meta'] = meta;
    }

    process.stderr.write(`${JSON.stringify(entry)}\n`);
  };

  return {
    debug: (message, meta) => {
      write('debug', message, meta);
    },
    info: (message, meta) => {
      write('info', message, meta);
    },
    warn: (message, meta) => {
      write('warn', message, meta);
    },
    error: (message, meta) => {
      write('error', message, meta);
    },
  };
}
