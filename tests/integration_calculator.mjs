import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proxyScript = path.resolve(__dirname, '../dist/index.js');

async function runIntegration() {
  console.error(`[integration] Connecting to proxy at: ${proxyScript}`);

  const transport = new StdioClientTransport({
    command: 'node',
    args: [proxyScript],
    stderr: 'pipe',
  });

  transport.stderr.on('data', (chunk) => {
    process.stderr.write(`[proxy-stderr] ${chunk.toString()}`);
  });

  const client = new Client({
    name: 'integration-test-client',
    version: '1.0.0',
  });

  try {
    await client.connect(transport);
    console.error('[integration] Connected to proxy server successfully.');

    // 1. List tools
    console.error('[integration] Requesting tools/list through proxy...');
    const toolsResult = await client.listTools();
    console.error(`[integration] Received ${toolsResult.tools.length} tools through proxy.`);
    if (toolsResult.tools.length < 50) {
      throw new Error(`Expected at least 50 tools, received ${toolsResult.tools.length}`);
    }

    // 2. Find Calculator window via list_windows
    console.error('[integration] Calling list_windows through proxy...');
    const windowsRes = await client.callTool({
      name: 'list_windows',
      arguments: {},
    });

    const structured = windowsRes.structuredContent;
    const windows = structured?.windows || [];
    console.error(`[integration] Found ${windows.length} windows.`);

    const calcWindow = windows.find(
      (w) => w.app_name?.includes('Калькулятор') || w.app_name?.includes('Calculator')
    );

    if (!calcWindow) {
      throw new Error('Calculator window not found in list_windows! Make sure Calculator is open.');
    }

    console.error(`[integration] Target Calculator window: pid=${calcWindow.pid}, window_id=${calcWindow.window_id}`);

    // 3. Call get_window_state
    console.error('[integration] Calling get_window_state for Calculator through proxy...');
    const stateRes = await client.callTool({
      name: 'get_window_state',
      arguments: {
        pid: calcWindow.pid,
        window_id: calcWindow.window_id,
        include_accessibility_tree: true,
        include_screenshot: true,
      },
    });

    console.error('[integration] Response received from get_window_state:');
    console.error(`[integration] isError: ${stateRes.isError ?? false}`);
    console.error(`[integration] content items: ${stateRes.content?.length ?? 0}`);

    const imageItem = stateRes.content?.find((c) => c.type === 'image');
    if (!imageItem) {
      throw new Error('No ImageContent found in get_window_state response!');
    }

    console.error(`[integration] Image mimeType: ${imageItem.mimeType}`);
    console.error(`[integration] Image base64 length: ${imageItem.data?.length ?? 0} characters`);

    // Verify raw bytes
    const buffer = Buffer.from(imageItem.data, 'base64');
    console.error(`[integration] Decoded buffer size: ${buffer.length} bytes`);

    // Check PNG header magic bytes (89 50 4E 47 0D 0A 1A 0A)
    const isPng =
      buffer.length > 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a;

    console.error(`[integration] PNG magic header check: ${isPng ? 'VALID PNG' : 'INVALID'}`);
    if (!isPng) {
      throw new Error('Screenshot data is corrupted (invalid PNG header)!');
    }

    // Check width and height from PNG IHDR chunk (bytes 16..24)
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    console.error(`[integration] Decoded PNG dimensions: ${width}x${height} px`);

    // Check tree elements and markdown
    const elements = stateRes.structuredContent?.elements || [];
    console.error(`[integration] Structured elements count: ${elements.length}`);
    const treeMd = stateRes.structuredContent?.tree_markdown || '';
    console.error(`[integration] tree_markdown length: ${treeMd.length} characters`);

    console.log(
      JSON.stringify(
        {
          success: true,
          tools_count: toolsResult.tools.length,
          calculator: {
            pid: calcWindow.pid,
            window_id: calcWindow.window_id,
            bounds: calcWindow.bounds,
          },
          screenshot: {
            mimeType: imageItem.mimeType,
            base64_length: imageItem.data.length,
            bytes_size: buffer.length,
            width,
            height,
            is_valid_png: isPng,
          },
          elements_count: elements.length,
          tree_markdown_length: treeMd.length,
        },
        null,
        2
      )
    );
  } finally {
    await client.close();
  }
}

runIntegration().catch((err) => {
  console.error('[integration] Fatal error:', err);
  process.exit(1);
});
