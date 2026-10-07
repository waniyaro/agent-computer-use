/**
 * Logger utility that writes STRICTLY to process.stderr to prevent corrupting
 * the JSON-RPC stdout stream used by MCP.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private prefix: string;

  constructor(prefix = 'proxy') {
    this.prefix = prefix;
  }

  private write(level: LogLevel, ...args: unknown[]): void {
    const timestamp = new Date().toISOString();
    const formatted = args
      .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg)))
      .join(' ');
    process.stderr.write(`[${timestamp}] [${level.toUpperCase()}] [${this.prefix}] ${formatted}\n`);
  }

  debug(...args: unknown[]): void {
    if (process.env.DEBUG) {
      this.write('debug', ...args);
    }
  }

  info(...args: unknown[]): void {
    this.write('info', ...args);
  }

  warn(...args: unknown[]): void {
    this.write('warn', ...args);
  }

  error(...args: unknown[]): void {
    this.write('error', ...args);
  }
}

export const logger = new Logger('cua-proxy');
