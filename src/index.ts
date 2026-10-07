#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CuaDriverBackend } from './backend/cua-driver.js';
import { createProxyServer } from './server.js';
import { loadPolicyConfig } from './policy/schema.js';
import { PolicyEnforcer } from './policy/enforcer.js';
import { auditLogger } from './audit/logger.js';
import { journalManager } from './journal/manager.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  logger.info('Starting agent-computer-use proxy with security enforcement...');

  // 1. Load policy configuration (validates with Zod or creates default)
  let policyConfig;
  try {
    policyConfig = loadPolicyConfig();
    logger.info(`Loaded policy configuration (toolProfile: ${policyConfig.toolProfile}, allowedApps: ${policyConfig.allowedApps.length})`);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const enforcer = new PolicyEnforcer(policyConfig);

  // 2. Initialize backend
  const backend = new CuaDriverBackend();
  try {
    await backend.start();
  } catch (err) {
    logger.error('Failed to start Cua Driver backend:', err);
    process.exit(1);
  }

  logger.info(`Session initialized with ID: ${journalManager.getCurrentSessionId()}`);

  // 3. Create proxy server with enforcer, audit logger, and journal
  const server = createProxyServer(backend, enforcer, auditLogger, journalManager);
  const transport = new StdioServerTransport();

  // Handle graceful shutdown
  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down proxy server...');
    try {
      await server.close();
      await backend.stop();
    } catch (err) {
      logger.error('Error during shutdown:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.on('uncaughtException', (err: Error) => {
    logger.error('Uncaught exception in proxy:', err);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled rejection in proxy:', reason);
  });

  await server.connect(transport);
  logger.info('Security-enforced proxy connected over stdio and listening.');
}

main().catch((err: unknown) => {
  logger.error('Fatal proxy startup error:', err);
  process.exit(1);
});
