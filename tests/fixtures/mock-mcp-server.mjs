import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

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
    process.stderr.write(`[mock-server] always-crash mode: crashing immediately (attempt: ${count})\n`);
    process.exit(1);
  }

  if (mode === 'crash-once' && count === 1) {
    process.stderr.write(`[mock-server] crash-once mode: crashing on first run\n`);
    process.exit(1);
  }
}

// In-memory mock windows
const launchedWindows = [
  {
    pid: 500,
    window_id: 10,
    app_name: 'Antigravity IDE',
    bundle_id: 'com.google.antigravity-ide',
  },
];

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
      {
        name: 'list_windows',
        description: 'Lists all open windows',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'launch_app',
        description: 'Launches an app',
        inputSchema: {
          type: 'object',
          properties: {
            bundle_id: { type: 'string' },
            name: { type: 'string' },
          },
        },
      },
      {
        name: 'click',
        description: 'Performs click',
        inputSchema: {
          type: 'object',
          properties: {
            pid: { type: 'number' },
            window_id: { type: 'number' },
          },
        },
      },
    ],
  };
});

// 2. tools/call
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'echo_tool') {
    const msg = (args && args.message) || 'hello';
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

  if (name === 'list_windows') {
    return {
      content: [
        {
          type: 'text',
          text: `Found ${launchedWindows.length} windows.`,
        },
      ],
      structuredContent: {
        windows: launchedWindows,
      },
    };
  }

  if (name === 'launch_app') {
    const bundle_id = (args && args.bundle_id) || 'com.example.app';
    const appName = (args && args.name) || bundle_id;
    const newWin = {
      pid: 1234,
      window_id: 5678,
      app_name: appName,
      bundle_id: bundle_id,
    };
    launchedWindows.push(newWin);
    return {
      content: [
        {
          type: 'text',
          text: `Launched ${bundle_id}`,
        },
      ],
      structuredContent: newWin,
    };
  }

  if (name === 'click') {
    if (args && args.pid === 9999) {
      // Simulate target application process crash
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'process not found: pid 9999 is dead or window does not exist',
          },
        ],
        structuredContent: {
          error: 'process not found',
        },
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: 'Click executed successfully',
        },
      ],
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
