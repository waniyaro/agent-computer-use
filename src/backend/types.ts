import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type BackendState = 'stopped' | 'starting' | 'ready' | 'restarting' | 'backend_down';

export interface BackendOptions {
  /**
   * Command to launch backend. Defaults to resolving `cua-driver`.
   */
  command?: string;
  /**
   * Arguments for backend command. Defaults to ['mcp'].
   */
  args?: string[];
  /**
   * Environment variables for the child process.
   */
  env?: Record<string, string>;
  /**
   * Working directory for the child process.
   */
  cwd?: string;
  /**
   * Maximum consecutive retries before entering 'backend_down'. Defaults to 3.
   */
  maxRetries?: number;
  /**
   * Delay in ms between restart attempts. Defaults to 500ms.
   */
  retryDelayMs?: number;
  /**
   * Timeout in ms for connection/handshake. Defaults to 10000ms.
   */
  connectTimeoutMs?: number;
}

export interface StructuredErrorContent {
  code: 'backend_down' | 'backend_crashed' | 'backend_starting' | 'tool_execution_failed';
  message: string;
  consecutive_failures: number;
  state: BackendState;
  tool?: string;
  original_error?: string;
}
