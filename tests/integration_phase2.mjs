import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proxyScript = path.resolve(__dirname, '../dist/index.js');
const testConfigDir = path.join(os.tmpdir(), `integration-phase2-${Date.now()}`);
const policyFile = path.join(testConfigDir, 'policy.json');
const auditFile = path.join(testConfigDir, 'audit.log');

fs.mkdirSync(testConfigDir, { recursive: true });

async function runTest(allowedApps) {
  // Write test config
  fs.writeFileSync(
    policyFile,
    JSON.stringify(
      {
        allowedApps,
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
    name: 'test-phase2-client',
    version: '1.0.0',
  });

  await client.connect(transport);

  try {
    // 1. Check tools list has 12 minimal tools
    const tools = await client.listTools();

    // 2. list_windows
    const winRes = await client.callTool({
      name: 'list_windows',
      arguments: {},
    });
    const windows = winRes.structuredContent?.windows || [];
    const calc = windows.find(
      (w) => w.app_name?.includes('Калькулятор') || w.app_name?.includes('Calculator')
    );

    if (!calc) {
      throw new Error('Calculator window not found');
    }

    // 3. get_window_state
    const stateRes = await client.callTool({
      name: 'get_window_state',
      arguments: {
        pid: calc.pid,
        window_id: calc.window_id,
        include_accessibility_tree: false,
        include_screenshot: true,
      },
    });

    return {
      toolsCount: tools.tools.length,
      toolNames: tools.tools.map((t) => t.name),
      stateRes,
    };
  } finally {
    await client.close();
  }
}

async function main() {
  console.error('[Phase 2 Integration] Step 1: Testing with allowedApps: [] (Fail-Closed)...');
  const resDenied = await runTest([]);
  console.error('[Phase 2 Integration] Result with empty allowedApps:');
  console.error(`  isError: ${resDenied.stateRes.isError}`);
  console.error(`  code: ${resDenied.stateRes.structuredContent?.code}`);
  console.error(`  message: ${resDenied.stateRes.structuredContent?.message}`);

  if (resDenied.stateRes.structuredContent?.code !== 'APP_NOT_ALLOWED') {
    throw new Error(`Expected APP_NOT_ALLOWED, got ${resDenied.stateRes.structuredContent?.code}`);
  }

  console.error('\n[Phase 2 Integration] Step 2: Testing with allowedApps: ["com.apple.calculator"]...');
  const resAllowed = await runTest(['com.apple.calculator', 'Калькулятор']);
  console.error('[Phase 2 Integration] Result with allowed Calculator:');
  console.error(`  isError: ${resAllowed.stateRes.isError ?? false}`);
  const img = resAllowed.stateRes.content?.find((c) => c.type === 'image');
  console.error(`  hasImage: ${!!img}, mimeType: ${img?.mimeType}, length: ${img?.data?.length}`);

  if (!img || img.mimeType !== 'image/png') {
    throw new Error('Expected image/png in allowed state');
  }

  console.error('\n[Phase 2 Integration] Step 3: Checking audit log records in ' + auditFile);
  const auditLines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
  console.error(`  Total audit entries: ${auditLines.length}`);
  for (const line of auditLines) {
    const parsed = JSON.parse(line);
    console.error(`  - [${parsed.timestamp}] tool=${parsed.tool} status=${parsed.status} target=${parsed.target_bundle_id}`);
  }

  console.log(
    JSON.stringify(
      {
        success: true,
        minimal_tools_count: resDenied.toolsCount,
        minimal_tools: resDenied.toolNames,
        fail_closed_code: resDenied.stateRes.structuredContent?.code,
        allowed_image_mime: img.mimeType,
        allowed_image_length: img.data.length,
        audit_entries_count: auditLines.length,
      },
      null,
      2
    )
  );

  // Cleanup temp test dir
  fs.rmSync(testConfigDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('[Phase 2 Integration] Failed:', err);
  process.exit(1);
});
