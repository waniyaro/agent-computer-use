import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Tool, CallToolResult, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BackendOptions, BackendState } from './types.js';
import { logger } from '../utils/logger.js';

export function resolveDefaultCuaDriverCommand(): string {
  if (process.env.CUA_DRIVER_PATH && fs.existsSync(process.env.CUA_DRIVER_PATH)) {
    return process.env.CUA_DRIVER_PATH;
  }

  const userLocalBin = path.join(os.homedir(), '.local', 'bin', 'cua-driver');
  if (fs.existsSync(userLocalBin)) {
    return userLocalBin;
  }

  const appBinary = '/Applications/CuaDriver.app/Contents/MacOS/cua-driver';
  if (fs.existsSync(appBinary)) {
    return appBinary;
  }

  return 'cua-driver';
}

export class CuaDriverBackend {
  private options: Required<BackendOptions>;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private state: BackendState = 'stopped';
  private consecutiveFailures = 0;
  private isStopping = false;
  private isHandlingFailure = false;
  private cachedTools: Tool[] = [];
  private restartPromise: Promise<void> | null = null;

  constructor(options: BackendOptions = {}) {
    this.options = {
      command: options.command ?? resolveDefaultCuaDriverCommand(),
      args: options.args ?? ['mcp'],
      env: options.env ?? {},
      cwd: options.cwd ?? process.cwd(),
      maxRetries: options.maxRetries ?? 3,
      retryDelayMs: options.retryDelayMs ?? 300,
      connectTimeoutMs: options.connectTimeoutMs ?? 10000,
    };
  }

  getState(): BackendState {
    return this.state;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getCachedTools(): Tool[] {
    return this.cachedTools;
  }

  /**
   * Initializes and connects to the backend process.
   */
  async start(): Promise<void> {
    if (this.state === 'ready') {
      return;
    }

    this.isStopping = false;
    this.state = 'starting';
    logger.info(`Starting backend: ${this.options.command} ${this.options.args.join(' ')}`);

    try {
      await this.connectInternal();
      this.consecutiveFailures = 0;
      this.state = 'ready';
      logger.info('Backend connected and ready.');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`Initial backend start failed: ${error.message}`);
      await this.handleFailure(error.message);
      throw error;
    }
  }

  /**
   * Gracefully stops the backend process.
   */
  async stop(): Promise<void> {
    this.isStopping = true;
    this.state = 'stopped';
    logger.info('Stopping backend process...');

    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        logger.debug('Error closing client:', err);
      }
      this.client = null;
    }

    if (this.transport) {
      try {
        await this.transport.close();
      } catch (err) {
        logger.debug('Error closing transport:', err);
      }
      this.transport = null;
    }
  }

  /**
   * Queries tools/list from backend.
   */
  async listTools(): Promise<Tool[]> {
    if (this.state === 'backend_down') {
      throw new McpError(
        ErrorCode.InternalError,
        `Backend is DOWN: maximum restart attempts (${this.options.maxRetries}) exceeded.`
      );
    }

    if (this.state === 'restarting' && this.restartPromise) {
      await this.restartPromise.catch(() => {});
    }

    if (!this.client || this.state !== 'ready') {
      if (this.cachedTools.length > 0) {
        logger.warn('Backend not fully ready, returning cached tools.');
        return this.cachedTools;
      }
      throw new McpError(ErrorCode.InternalError, `Backend is not ready (state: ${this.state})`);
    }

    try {
      const res = await this.client.listTools();
      this.cachedTools = res.tools;
      return this.cachedTools;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`Failed to list tools from backend: ${error.message}`);
      await this.handleFailure(error.message);
      if (this.cachedTools.length > 0) {
        return this.cachedTools;
      }
      throw new McpError(ErrorCode.InternalError, `Backend error listing tools: ${error.message}`);
    }
  }

  /**
   * Transparently calls a tool on the backend.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    if (this.state === 'backend_down') {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Backend is DOWN: Cua Driver process failed ${this.consecutiveFailures} consecutive times. Auto-restart limit reached.`,
          },
        ],
        structuredContent: {
          code: 'backend_down',
          message: 'Auto-restart limit reached',
          consecutive_failures: this.consecutiveFailures,
          state: this.state,
          tool: name,
        },
      };
    }

    if (this.state === 'restarting' && this.restartPromise) {
      logger.info(`Waiting for in-flight backend restart before calling tool ${name}...`);
      await this.restartPromise.catch(() => {});
    }

    if (!this.client || this.state !== 'ready') {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Backend is not ready (current state: ${this.state}).`,
          },
        ],
        structuredContent: {
          code: 'backend_crashed',
          message: `Backend is not ready (state: ${this.state})`,
          consecutive_failures: this.consecutiveFailures,
          state: this.state,
          tool: name,
        },
      };
    }

    try {
      const result = await this.client.callTool({
        name,
        arguments: args,
      });

      // Reset failure counter on successful tool call
      this.consecutiveFailures = 0;
      return result as CallToolResult;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`Tool execution (${name}) failed with backend error: ${error.message}`);
      await this.handleFailure(error.message);

      const currentState = this.getState();
      const isDown = currentState === 'backend_down';

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Backend process crashed during execution of '${name}': ${error.message}. ${
              isDown
                ? 'Backend is now permanently DOWN (max retries reached).'
                : 'Auto-restart triggered.'
            }`,
          },
        ],
        structuredContent: {
          code: isDown ? 'backend_down' : 'backend_crashed',
          message: error.message,
          consecutive_failures: this.consecutiveFailures,
          state: currentState,
          tool: name,
        },
      };
    }
  }

  /**
   * Internal connection and handshake.
   */
  private async connectInternal(): Promise<void> {
    // Cleanup prior transport if any
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // ignore
      }
      this.transport = null;
    }

    this.transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args,
      env: this.options.env,
      cwd: this.options.cwd,
      stderr: 'pipe',
    });

    // Pipe backend stderr to our logger
    if (this.transport.stderr) {
      this.transport.stderr.on('data', (chunk: Buffer | string) => {
        logger.debug(`[backend-stderr] ${chunk.toString().trim()}`);
      });
    }

    // Handle unexpected close only when ready
    this.transport.onclose = () => {
      if (!this.isStopping && this.state === 'ready') {
        logger.warn('Underlying backend transport closed unexpectedly.');
        void this.handleFailure('Underlying process closed unexpectedly');
      }
    };

    this.transport.onerror = (err) => {
      logger.error(`Underlying transport error: ${err.message}`);
    };

    this.client = new Client({
      name: 'agent-computer-use-proxy',
      version: '1.0.0',
    });

    // Connect transport with timeout
    const connectPromise = this.client.connect(this.transport);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Backend connection timed out after ${this.options.connectTimeoutMs}ms`)),
        this.options.connectTimeoutMs
      )
    );

    await Promise.race([connectPromise, timeoutPromise]);

    // Query tools to cache and confirm handshake
    const toolsResult = await this.client.listTools();
    this.cachedTools = toolsResult.tools;
  }

  /**
   * Handles unexpected backend failures and triggers auto-restart.
   */
  private async handleFailure(reason: string): Promise<void> {
    if (this.isStopping || this.isHandlingFailure) return;
    this.isHandlingFailure = true;

    try {
      this.consecutiveFailures++;
      logger.warn(
        `Backend failure detected (${this.consecutiveFailures}/${this.options.maxRetries}): ${reason}`
      );

      if (this.consecutiveFailures >= this.options.maxRetries) {
        this.state = 'backend_down';
        logger.error(
          `Backend transitioned to 'backend_down' after ${this.consecutiveFailures} consecutive failures.`
        );
        return;
      }

      this.state = 'restarting';
      this.restartPromise = this.attemptRestart();
      await this.restartPromise;
    } finally {
      this.isHandlingFailure = false;
    }
  }

  private async attemptRestart(): Promise<void> {
    logger.info(`Attempting auto-restart (${this.consecutiveFailures}/${this.options.maxRetries})...`);

    if (this.options.retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs));
    }

    try {
      await this.connectInternal();
      this.consecutiveFailures = 0;
      this.state = 'ready';
      logger.info('Backend successfully restarted and ready.');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`Restart attempt failed: ${error.message}`);
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.options.maxRetries) {
        this.state = 'backend_down';
        logger.error(
          `Backend transitioned to 'backend_down' after ${this.consecutiveFailures} consecutive failures.`
        );
      } else {
        await this.attemptRestart();
      }
    }
  }

  /**
   * Manual reset to allow restarting after 'backend_down'.
   */
  async resetAndRestart(): Promise<void> {
    this.consecutiveFailures = 0;
    this.state = 'stopped';
    await this.start();
  }
}
