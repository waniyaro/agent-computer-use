import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Parse command line flags or env vars
const stateFile = process.env.MOCK_STATE_FILE;
const mode = process.env.MOCK_MODE || 'normal';

if (stateFile) {
  let count = 0;
  if (fs.existsSync(stateFile)) {
    try {
      count = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0;
    } catch {
      count = 0;
    }
  }
  count++;
  fs.writeFileSync(stateFile, String(count), 'utf8');

  if (mode === 'always-crash') {
    process.stderr.write(`[mock-server] always-crash mode: crashing immediately (count: ${count})\n`);
    process.exit(1);
  }

  if (mode === 'crash-once' && count === 1) {
    process.stderr.write(`[mock-server] crash-once mode: crashing on start (count: ${count})\n`);
    process.exit(1);
  }
}

const server = new Server(
  {
    name: 'mock-cua-driver',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 1. tools/list
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'echo_tool',
        description: 'Echoes message',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
        },
      },
      {
        name: 'screenshot_tool',
        description: 'Returns mock image and text',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'crash_tool',
        description: 'Intentionally crashes the process',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// 2. tools/call
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'echo_tool') {
    const msg = (args?.message as string) ?? 'hello';
    return {
      content: [
        {
          type: 'text',
          text: `Echo: ${msg}`,
        },
      ],
    };
  }

  if (name === 'screenshot_tool') {
    // 1x1 transparent PNG base64
    const samplePngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    return {
      content: [
        {
          type: 'image',
          data: samplePngBase64,
          mimeType: 'image/png',
        },
        {
          type: 'text',
          text: 'Screenshot successfully captured',
        },
      ],
      structuredContent: {
        width: 1,
        height: 1,
        format: 'png',
      },
    };
  }

  if (name === 'crash_tool') {
    process.stderr.write('[mock-server] crash_tool called: exiting process with code 1\n');
    process.exit(1);
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
