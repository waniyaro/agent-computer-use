import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proxyScript = path.resolve(__dirname, '../dist/index.js');
const testConfigDir = path.join(os.tmpdir(), `integration-phase3-${Date.now()}`);
const policyFile = path.join(testConfigDir, 'policy.json');

fs.mkdirSync(testConfigDir, { recursive: true });

async function main() {
  console.error(`[Phase 3 Integration] Starting integration test with real Calculator...`);

  // Write policy config with allowed Calculator
  fs.writeFileSync(
    policyFile,
    JSON.stringify(
      {
        allowedApps: ['com.apple.calculator', 'Калькулятор'],
        deniedApps: ['com.apple.Terminal'],
        maxActionsPerSession: 200,
        toolProfile: 'minimal',
        allowForeground: false,
        logTypedText: false,
        autoRelaunch: false,
      },
      null,
      2
    ),
    'utf8'
  );

  const transport = new StdioClientTransport({
    command: 'node',
    args: [proxyScript],
    env: {
      ...process.env,
      AGENT_CONFIG_DIR: testConfigDir,
    },
    stderr: 'pipe',
  });

  const client = new Client({
    name: 'test-phase3-client',
    version: '1.0.0',
  });

  await client.connect(transport);

  try {
    // 1. List tools: check 12 minimal + 4 custom tools = 16 tools
    const toolsRes = await client.listTools();
    const toolNames = toolsRes.tools.map((t) => t.name);
    console.error(`[Phase 3 Integration] Total tools received: ${toolNames.length}`);
    console.error(`[Phase 3 Integration] Tools list: ${toolNames.join(', ')}`);

    for (const customTool of ['ensure_app_running', 'task_journal_append', 'task_journal_read', 'task_journal_list']) {
      if (!toolNames.includes(customTool)) {
        throw new Error(`Custom tool ${customTool} not found in tools/list!`);
      }
    }

    // 2. Call ensure_app_running for Calculator
    console.error(`[Phase 3 Integration] Calling ensure_app_running for com.apple.calculator...`);
    const ensureRes = await client.callTool({
      name: 'ensure_app_running',
      arguments: {
        bundle_id: 'com.apple.calculator',
        name: 'Калькулятор',
      },
    });

    console.error(`[Phase 3 Integration] ensure_app_running result:`);
    console.error(`  isError: ${ensureRes.isError ?? false}`);
    console.error(`  message: ${ensureRes.content?.[0]?.text}`);
    const sc = ensureRes.structuredContent;
    console.error(`  structuredContent: status=${sc?.status}, pid=${sc?.pid}, window_id=${sc?.window_id}, requires_new_state=${sc?.requires_new_state}`);

    if (sc?.status !== 'running' || !sc?.pid || !sc?.window_id) {
      throw new Error('ensure_app_running failed to verify Calculator running status');
    }

    // 3. Journal Append
    console.error(`[Phase 3 Integration] Appending journal entry...`);
    const appendRes = await client.callTool({
      name: 'task_journal_append',
      arguments: {
        note: 'Verified Calculator window running via ensure_app_running',
        status: 'in_progress',
      },
    });
    console.error(`  append response: ${appendRes.content?.[0]?.text}`);

    // 4. Journal Read
    console.error(`[Phase 3 Integration] Reading journal entries...`);
    const readRes = await client.callTool({
      name: 'task_journal_read',
      arguments: {},
    });
    const readSc = readRes.structuredContent;
    console.error(`  read entries count: ${readSc?.entries?.length}`);
    if (!readSc?.entries || readSc.entries.length === 0) {
      throw new Error('Journal read returned no entries');
    }

    // 5. Journal List
    console.error(`[Phase 3 Integration] Listing all task journals...`);
    const listRes = await client.callTool({
      name: 'task_journal_list',
      arguments: {},
    });
    const listSc = listRes.structuredContent;
    console.error(`  tasks list count: ${listSc?.tasks?.length}`);
    if (!listSc?.tasks || listSc.tasks.length === 0) {
      throw new Error('Journal list returned no tasks');
    }

    console.log(
      JSON.stringify(
        {
          success: true,
          tools_count: toolNames.length,
          custom_tools_present: true,
          calculator_running: sc,
          journal_entries: readSc.entries.length,
          task_summaries: listSc.tasks.length,
        },
        null,
        2
      )
    );
  } finally {
    await client.close();
    fs.rmSync(testConfigDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[Phase 3 Integration] Fatal error:', err);
  process.exit(1);
});
