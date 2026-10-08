import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CuaDriverBackend } from '../backend/cua-driver.js';
import { createProxyServer } from '../server.js';
import { loadPolicyConfig } from '../policy/schema.js';
import { PolicyEnforcer } from '../policy/enforcer.js';
import { auditLogger } from '../audit/logger.js';
import { journalManager } from '../journal/manager.js';
import { logger } from '../utils/logger.js';

export interface ExecOptions {
  tool: string;
  args?: Record<string, unknown>;
}

/**
 * Executes a single tool call through the full security-enforced proxy stack
 * in a standalone, headless CLI invocation.
 */
export async function runExec(options: ExecOptions): Promise<CallToolResult> {
  const { tool, args = {} } = options;

  let policyConfig;
  try {
    policyConfig = loadPolicyConfig();
  } catch (err) {
    logger.error('Failed to load policy configuration:', err);
    throw err;
  }

  const enforcer = new PolicyEnforcer(policyConfig);
  const backend = new CuaDriverBackend();

  await backend.start();

  try {
    const server = createProxyServer(backend, enforcer, auditLogger, journalManager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    const client = new Client({ name: 'acu-cli', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const result = (await client.callTool({
      name: tool,
      arguments: args,
    })) as CallToolResult;

    await client.close();
    await server.close();

    return result;
  } finally {
    await backend.stop();
  }
}
