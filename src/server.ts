import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  Tool,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { CuaDriverBackend } from './backend/cua-driver.js';
import { PolicyEnforcer } from './policy/enforcer.js';
import { filterToolsByProfile } from './policy/filter.js';
import { AuditLogger, auditLogger as defaultAuditLogger } from './audit/logger.js';
import { JournalManager, journalManager as defaultJournalManager } from './journal/manager.js';
import { AppRecoveryManager, isAppCrashError } from './recovery/app-manager.js';
import { WindowInfo, PolicyCheckResult } from './policy/types.js';
import { logger } from './utils/logger.js';
import {
  Bounds,
  clamp,
  normalizeFromScreenshot,
  toLogicalScreenPoint,
  toLogicalWindowPoint,
  NormalizedPoint,
} from './engine/coordinate-engine.js';
import {
  VisualClickInputSchema,
  PressHotkeyInputSchema,
  GetWindowScreenshotInputSchema,
  ClipboardPasteInputSchema,
  ExecuteActionSequenceInputSchema,
  WaitForWindowInputSchema,
  normalizeHotkey,
} from './engine/schemas.js';
import { setSystemClipboard } from './engine/clipboard.js';
import { optimizeScreenshot } from './engine/image-optimizer.js';

export const CUSTOM_PROXY_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'ensure_app_running',
    description:
      'Ensure the target application is running. Launches it if necessary and waits for its window to appear.',
    inputSchema: {
      type: 'object',
      properties: {
        bundle_id: {
          type: 'string',
          description: 'macOS application bundle identifier (e.g. com.apple.calculator)',
        },
        name: {
          type: 'string',
          description: 'Optional application name',
        },
        timeout_ms: {
          type: 'number',
          description: 'Timeout in ms to wait for window to appear (default: 5000)',
        },
      },
      required: ['bundle_id'],
    },
  },
  {
    name: 'task_journal_append',
    description: 'Append a step, observation, or status update to the task journal.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task identifier. If omitted, uses current session ID.',
        },
        note: {
          type: 'string',
          description: 'Action, decision, or observation note',
        },
        status: {
          type: 'string',
          description: 'Status: in_progress, completed, failed, or custom',
        },
      },
      required: ['note'],
    },
  },
  {
    name: 'task_journal_read',
    description: 'Read journal entries for a task or current session.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task identifier. If omitted, reads current session.',
        },
        limit: {
          type: 'number',
          description: 'Number of recent entries to return (optional).',
        },
      },
    },
  },
  {
    name: 'task_journal_list',
    description: 'List all task journals with summary metadata.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'visual_click',
    description:
      'Click at normalized (0.0..1.0) or pixel coordinates within a target window on Retina and multi-monitor setups.',
    inputSchema: {
      type: 'object',
      properties: {
        window_id: { type: 'number', description: 'Target window ID' },
        pid: { type: 'number', description: 'Target process ID (optional, auto-resolved from window cache)' },
        x_percent: {
          type: 'number',
          description: 'Normalized X coordinate (0.0..1.0) relative to window top-left',
        },
        y_percent: {
          type: 'number',
          description: 'Normalized Y coordinate (0.0..1.0) relative to window top-left',
        },
        x_pixel: { type: 'number', description: 'X coordinate in screenshot pixels' },
        y_pixel: { type: 'number', description: 'Y coordinate in screenshot pixels' },
        screenshot_width: { type: 'number', description: 'Screenshot width in pixels' },
        screenshot_height: { type: 'number', description: 'Screenshot height in pixels' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'double'],
          description: 'Mouse button: left (default), right, or double',
        },
        debug_image_out: {
          type: 'string',
          description: 'Optional file path to output a PNG with a red crosshair verifying click coordinates',
        },
        delivery_mode: {
          type: 'string',
          enum: ['foreground', 'background'],
          description: 'Delivery mode: foreground (default if allowed) or background (modal dialogs)',
        },
      },
      required: ['window_id'],
    },
  },
  {
    name: 'clipboard_paste',
    description:
      'Safely paste arbitrary text (including Russian/Cyrillic and symbols) into target window via system clipboard without keyboard layout corruption.',
    inputSchema: {
      type: 'object',
      properties: {
        window_id: { type: 'number', description: 'Target window ID' },
        pid: { type: 'number', description: 'Target process ID (optional, auto-resolved from window cache)' },
        text: { type: 'string', description: 'Text to copy to clipboard and paste' },
        delivery_mode: {
          type: 'string',
          enum: ['foreground', 'background'],
          description: 'Delivery mode for Cmd+V (default: foreground for reliable modal/editor paste)',
        },
      },
      required: ['window_id', 'text'],
    },
  },
  {
    name: 'execute_action_sequence',
    description:
      'Execute a batch sequence of visual clicks, clipboard pastes, hotkeys, typing, and pauses in a single round-trip call.',
    inputSchema: {
      type: 'object',
      properties: {
        window_id: { type: 'number', description: 'Target window ID (optional, inherited by steps if omitted in step)' },
        pid: { type: 'number', description: 'Target process ID (optional, auto-resolved from window cache)' },
        delivery_mode: {
          type: 'string',
          enum: ['foreground', 'background'],
          description: 'Optional default delivery mode for clicks in this sequence',
        },
        delay_between_ms: {
          type: 'number',
          description: 'Delay between consecutive actions in milliseconds (default: 100ms)',
        },
        stop_on_error: {
          type: 'boolean',
          description: 'Whether to halt execution immediately if any step fails (default: true)',
        },
        stop_on_new_window: {
          type: 'boolean',
          description: 'Whether to pause and return early if a new modal/alert window appears during execution (default: false)',
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['click', 'double_click', 'right_click', 'paste', 'hotkey', 'type', 'sleep'],
              },
              window_id: { type: 'number', description: 'Optional target window ID for this step' },
              pid: { type: 'number', description: 'Optional target process ID for this step' },
              x: { type: 'number', description: 'X coordinate' },
              y: { type: 'number', description: 'Y coordinate' },
              x_pixel: { type: 'number', description: 'Raw screenshot pixel X' },
              y_pixel: { type: 'number', description: 'Raw screenshot pixel Y' },
              x_percent: { type: 'number', description: 'Normalized X (0..1)' },
              y_percent: { type: 'number', description: 'Normalized Y (0..1)' },
              button: { type: 'string', enum: ['left', 'right', 'double'] },
              delivery_mode: { type: 'string', enum: ['foreground', 'background'] },
              text: { type: 'string', description: 'Text for paste or type action' },
              keys: {
                type: 'array',
                items: { type: 'string' },
                description: 'Key combo for hotkey action',
              },
              ms: { type: 'number', description: 'Sleep duration in milliseconds' },
            },
            required: ['action'],
          },
          description: 'Ordered sequence of actions to execute (alias: actions)',
        },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['click', 'double_click', 'right_click', 'paste', 'hotkey', 'type', 'sleep'],
              },
              window_id: { type: 'number', description: 'Optional target window ID for this step' },
              pid: { type: 'number', description: 'Optional target process ID for this step' },
              x: { type: 'number', description: 'X coordinate' },
              y: { type: 'number', description: 'Y coordinate' },
              x_pixel: { type: 'number', description: 'Raw screenshot pixel X' },
              y_pixel: { type: 'number', description: 'Raw screenshot pixel Y' },
              x_percent: { type: 'number', description: 'Normalized X (0..1)' },
              y_percent: { type: 'number', description: 'Normalized Y (0..1)' },
              button: { type: 'string', enum: ['left', 'right', 'double'] },
              delivery_mode: { type: 'string', enum: ['foreground', 'background'] },
              text: { type: 'string', description: 'Text for paste or type action' },
              keys: {
                type: 'array',
                items: { type: 'string' },
                description: 'Key combo for hotkey action',
              },
              ms: { type: 'number', description: 'Sleep duration in milliseconds' },
            },
            required: ['action'],
          },
          description: 'Alias for steps',
        },
      },
      required: [],
    },
  },
  {
    name: 'press_hotkey',
    description:
      'Emulate keyboard hotkeys or single keypress into target window (e.g. ["Command", "s"], ["Tab"]).',
    inputSchema: {
      type: 'object',
      properties: {
        window_id: { type: 'number', description: 'Target window ID' },
        pid: { type: 'number', description: 'Target process ID (optional, auto-resolved from window cache)' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of keys to press (e.g. ["Command", "s"] or ["Return"])',
        },
      },
      required: ['window_id', 'keys'],
    },
  },
  {
    name: 'get_window_screenshot',
    description:
      'Capture a clean window screenshot with physical and logical dimensions and Retina scale factor.',
    inputSchema: {
      type: 'object',
      properties: {
        window_id: { type: 'number', description: 'Target window ID' },
        pid: { type: 'number', description: 'Target process ID (optional, auto-resolved from window cache)' },
        save_to_file: {
          type: 'string',
          description: 'Optional path on disk to write the captured PNG directly',
        },
        include_image: {
          type: 'boolean',
          description: 'Whether to include base64 image in tool response (default: true). Set false with save_to_file to save network bandwidth.',
        },
        max_width: {
          type: 'number',
          description: 'Maximum image width in pixels for fast, token-efficient vision (default: 1440). Set 0 for unscaled.',
        },
        format: {
          type: 'string',
          enum: ['jpeg', 'png'],
          description: 'Image format: "jpeg" for 80% smaller payloads and 4x faster vision (default: jpeg), or "png" for lossless.',
        },
        quality: {
          type: 'number',
          description: 'JPEG compression quality between 1 and 100 (default: 80). Ignored for PNG.',
        },
      },
      required: ['window_id'],
    },
  },
  {
    name: 'wait_for_window',
    description:
      'Poll system for a window matching criteria (title, bundle_id, window_id) to open or close, avoiding blind sleep roundtrips.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Window title substring (case-insensitive) to wait for' },
        bundle_id: { type: 'string', description: 'Application bundle identifier to wait for' },
        window_id: { type: 'number', description: 'Exact window ID to wait for' },
        state: {
          type: 'string',
          enum: ['opened', 'closed'],
          description: 'Wait for window to appear ("opened") or disappear ("closed"). Default: opened',
        },
        timeout_ms: { type: 'number', description: 'Maximum time to wait in ms (default: 5000, max: 30000)' },
        poll_interval_ms: { type: 'number', description: 'Polling interval in ms (default: 150)' },
      },
    },
  },
];

export function isWindowFocusError(errorText: string): boolean {
  if (!errorText) return false;
  const lower = errorText.toLowerCase();
  return (
    lower.includes('exact target window did not become focused') ||
    lower.includes('did not gain focus') ||
    lower.includes('cannot be focused') ||
    lower.includes('window focus timeout') ||
    lower.includes('same_pid_keyboard_ambiguity')
  );
}

export function isInsertKey(key: unknown): boolean {
  if (typeof key !== 'string') return false;
  const k = key.trim().toLowerCase();
  return k === 'insert' || k === 'help';
}

export function sendMacInsertKeycode(): void {
  try {
    execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to key code 114']);
    logger.info('Dispatched macOS key code 114 (Insert/Help) via System Events');
  } catch (err) {
    logger.warn('Failed to send key code 114 via AppleScript:', err);
  }
}

export const SINGLE_ACTION_TOOLS: ReadonlySet<string> = new Set([
  'click',
  'double_click',
  'right_click',
  'press_key',
  'hotkey',
  'type_text',
  'scroll',
  'visual_click',
  'press_hotkey',
  'clipboard_paste',
]);

export const BATCH_REMINDER_TEXT =
  '\n\n<reminder>Tip: You executed a single standalone action. For significantly faster execution, use execute_action_sequence to batch multiple steps (clicks, keystrokes, pastes) in one call.</reminder>';

export function attachBatchReminderIfNeeded(toolName: string, result: CallToolResult): void {
  if (SINGLE_ACTION_TOOLS.has(toolName) && !result.isError && Array.isArray(result.content)) {
    const textItem = result.content.find((c) => c.type === 'text');
    if (textItem && typeof (textItem as { text?: string }).text === 'string') {
      (textItem as { text: string }).text += BATCH_REMINDER_TEXT;
    } else {
      result.content.push({ type: 'text', text: BATCH_REMINDER_TEXT.trim() });
    }
  }
}

export function createProxyServer(
  backend: CuaDriverBackend,
  enforcer?: PolicyEnforcer,
  audit: AuditLogger = defaultAuditLogger,
  journal: JournalManager = defaultJournalManager,
  recovery?: AppRecoveryManager
): Server {
  const recoveryManager = recovery ?? (enforcer ? new AppRecoveryManager(backend, enforcer) : null);
  const localWindowCache = new Map<number, WindowInfo>();
  const lastWindowDownscale = new Map<number, number>();

  async function resolvePidForWindow(windowId: number): Promise<number | undefined> {
    const fromEnforcer = enforcer?.getWindowInfo(windowId);
    if (fromEnforcer && typeof fromEnforcer.pid === 'number') {
      return fromEnforcer.pid;
    }
    const fromLocal = localWindowCache.get(windowId);
    if (fromLocal && typeof fromLocal.pid === 'number') {
      return fromLocal.pid;
    }

    try {
      const listRes = await backend.callTool('list_windows', {});
      const sc = listRes.structuredContent as Record<string, unknown> | undefined;
      if (sc && Array.isArray(sc.windows)) {
        const windows = sc.windows as WindowInfo[];
        enforcer?.updateWindowCache(windows);
        for (const w of windows) {
          localWindowCache.set(w.window_id, w);
        }
        const refreshed = enforcer?.getWindowInfo(windowId) || localWindowCache.get(windowId);
        if (refreshed && typeof refreshed.pid === 'number') {
          return refreshed.pid;
        }
      }
    } catch (err) {
      logger.warn(`Failed to refresh window cache when resolving pid for window ${windowId}:`, err);
    }
    return undefined;
  }

  const server = new Server(
    {
      name: 'agent-computer-use-proxy',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // 1. Proxy tools/list with custom tools and profile filtering
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug('Handling tools/list request');
    const rawTools: Tool[] = await backend.listTools();

    // Make pid optional in backend tools input schemas as well
    const patchedRawTools = rawTools.map((t) => {
      if (
        ['click', 'double_click', 'right_click', 'type_text', 'press_key', 'hotkey', 'scroll', 'zoom'].includes(t.name)
      ) {
        if (t.inputSchema && Array.isArray((t.inputSchema as any).required)) {
          return {
            ...t,
            inputSchema: {
              ...t.inputSchema,
              required: ((t.inputSchema as any).required as string[]).filter((r) => r !== 'pid'),
            },
          };
        }
      }
      return t;
    });

    // Combine backend tools and custom proxy tools
    const combinedTools: Tool[] = [...patchedRawTools, ...CUSTOM_PROXY_TOOL_DEFINITIONS];

    const filteredTools = enforcer
      ? filterToolsByProfile(combinedTools, enforcer.getConfig().toolProfile)
      : combinedTools;

    logger.debug(
      `Returning ${filteredTools.length}/${combinedTools.length} tools to client (profile: ${
        enforcer?.getConfig().toolProfile ?? 'none'
      })`
    );

    return {
      tools: filteredTools,
    };
  });

  // 2. Proxy tools/call with policy enforcement, recovery, and journal handling
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs as Record<string, unknown>) ?? {};
    logger.info(`Handling tool call: ${name}`);

    // --- Custom Tool 1: ensure_app_running ---
    if (name === 'ensure_app_running') {
      const bundleId = args.bundle_id as string;
      const appName = args.name as string | undefined;
      const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined;

      if (!bundleId) {
        return {
          isError: true,
          content: [{ type: 'text', text: "Missing required argument 'bundle_id'" }],
        };
      }

      if (!recoveryManager) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'AppRecoveryManager is not configured on this server.' }],
        };
      }

      try {
        const result = await recoveryManager.ensureAppRunning({
          bundle_id: bundleId,
          name: appName,
          timeout_ms: timeoutMs,
        });

        // Invalidate process/window cache since application state has changed or relaunched
        enforcer?.clearWindowCache();
        localWindowCache.clear();

        audit.log({
          tool: name,
          target_bundle_id: bundleId,
          status: 'ok',
          details: { ...args, ...result },
        });

        return {
          content: [{ type: 'text', text: result.message }],
          structuredContent: result,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isPolicyViolation = msg.includes('Policy Violation');
        const code = isPolicyViolation ? (msg.match(/\(([^)]+)\)/)?.[1] ?? 'APP_DENIED') : 'RELAUNCH_FAILED';

        audit.log({
          tool: name,
          target_bundle_id: bundleId,
          status: code,
          details: { error: msg, ...args },
        });

        return {
          isError: true,
          content: [{ type: 'text', text: msg }],
          structuredContent: {
            code,
            message: msg,
            target_bundle_id: bundleId,
          },
        };
      }
    }

    // --- Custom Tool 2: task_journal_append ---
    if (name === 'task_journal_append') {
      const note = args.note as string;
      const taskId = args.task_id as string | undefined;
      const status = args.status as string | undefined;

      if (!note) {
        return {
          isError: true,
          content: [{ type: 'text', text: "Missing required argument 'note'" }],
        };
      }

      const entry = journal.append({ task_id: taskId, note, status });
      return {
        content: [{ type: 'text', text: `Journal entry appended at ${entry.timestamp}` }],
        structuredContent: entry,
      };
    }

    // --- Custom Tool 3: task_journal_read ---
    if (name === 'task_journal_read') {
      const taskId = args.task_id as string | undefined;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const entries = journal.read({ task_id: taskId, limit });
      return {
        content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }],
        structuredContent: { entries },
      };
    }

    // --- Custom Tool 4: task_journal_list ---
    if (name === 'task_journal_list') {
      const summaries = journal.list();
      return {
        content: [{ type: 'text', text: JSON.stringify(summaries, null, 2) }],
        structuredContent: { tasks: summaries },
      };
    }

    // Auto-resolve PID from window cache if window_id is provided without pid
    if (name !== 'list_windows' && typeof args.window_id === 'number' && (args.pid === undefined || args.pid === null)) {
      const resolvedPid = await resolvePidForWindow(args.window_id);
      if (resolvedPid === undefined) {
        const errorMsg = `Window with window_id ${args.window_id} not found in window cache. Call list_windows first.`;
        audit.log({
          tool: name,
          target_bundle_id: null,
          status: 'WINDOW_NOT_FOUND',
          duration_ms: 0,
          details: { error: errorMsg, ...args },
        });
        return {
          isError: true,
          content: [{ type: 'text', text: errorMsg }],
          structuredContent: {
            code: 'WINDOW_NOT_FOUND',
            message: errorMsg,
            window_id: args.window_id,
          },
        };
      }
      args.pid = resolvedPid;
    }

    // --- Backend Tools with Policy Enforcer & Crash Recovery ---
    let check: PolicyCheckResult | undefined;
    if (enforcer) {
      check = await enforcer.enforce(name, args);

      if (!check.allowed) {
        logger.warn(`Policy rejected call to ${name}: ${check.code} - ${check.reason}`);
        const auditDetails = prepareAuditDetails(name, args, enforcer.getConfig().logTypedText);

        audit.log({
          tool: name,
          target_bundle_id: check.targetBundleId ?? null,
          status: check.code ?? 'REJECTED',
          duration_ms: 0,
          details: {
            reason: check.reason,
            ...auditDetails,
          },
        });

        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Policy Violation (${check.code}): ${check.reason}`,
            },
          ],
          structuredContent: {
            code: check.code,
            message: check.reason,
            target_bundle_id: check.targetBundleId ?? null,
          },
        };
      }
    }

    // --- Vision Tool 1: visual_click ---
    if (name === 'visual_click') {
      const parseResult = VisualClickInputSchema.safeParse(args);
      if (!parseResult.success) {
        const errorMsg = parseResult.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join(', ');
        audit.log({
          tool: name,
          target_bundle_id: null,
          status: 'INVALID_ARGUMENTS',
          duration_ms: 0,
          details: { error: errorMsg, ...args },
        });
        return {
          isError: true,
          content: [{ type: 'text', text: `Invalid arguments for visual_click: ${errorMsg}` }],
          structuredContent: { code: 'INVALID_ARGUMENTS', message: errorMsg },
        };
      }
      const input = parseResult.data;

      // Resolve window bounds from cache or fallback
      let windowInfo = enforcer?.getWindowInfo(input.window_id);
      if (!windowInfo || !windowInfo.bounds) {
        try {
          const listRes = await backend.callTool('list_windows', {});
          const sc = listRes.structuredContent as Record<string, unknown> | undefined;
          if (sc && Array.isArray(sc.windows)) {
            enforcer?.updateWindowCache(sc.windows as WindowInfo[]);
            windowInfo = enforcer?.getWindowInfo(input.window_id);
          }
        } catch (err) {
          logger.warn('Failed to refresh window cache during visual_click:', err);
        }
      }

      const bounds: Bounds = windowInfo?.bounds ?? { x: 0, y: 0, width: 800, height: 600 };

      let norm: NormalizedPoint;
      if (typeof input.x_percent === 'number' && typeof input.y_percent === 'number') {
        norm = {
          x_pct: clamp(input.x_percent, 0, 1),
          y_pct: clamp(input.y_percent, 0, 1),
        };
      } else {
        norm = normalizeFromScreenshot(
          input.x_pixel!,
          input.y_pixel!,
          input.screenshot_width!,
          input.screenshot_height!
        );
      }

      const windowLogical = toLogicalWindowPoint(norm, bounds);
      const screenLogical = toLogicalScreenPoint(norm, bounds);

      let shot_w = 0;
      let shot_h = 0;
      try {
        const snap = await backend.callTool('get_window_state', {
          pid: input.pid,
          window_id: input.window_id,
          include_accessibility_tree: false,
          include_screenshot: true,
        });
        const img = snap.content?.find((c) => c.type === 'image');
        if (img && typeof (img as any).data === 'string') {
          const b = Buffer.from((img as any).data, 'base64');
          if (b.length >= 24) {
            shot_w = b.readUInt32BE(16);
            shot_h = b.readUInt32BE(20);
          }
        }
      } catch (err) {
        logger.warn('Failed to ensure snapshot before visual_click:', err);
      }

      // Cua Driver reverses Retina and window downscale from raw screenshot pixel coordinates
      const downscaleRatio = lastWindowDownscale.get(input.window_id) ?? 1.0;
      let cuaX: number;
      let cuaY: number;

      if (typeof input.x_pixel === 'number' && typeof input.y_pixel === 'number') {
        cuaX = Math.round(input.x_pixel * downscaleRatio);
        cuaY = Math.round(input.y_pixel * downscaleRatio);
      } else if (shot_w > 0 && shot_h > 0) {
        cuaX = Math.round(norm.x_pct * shot_w);
        cuaY = Math.round(norm.y_pct * shot_h);
      } else {
        cuaX = windowLogical.windowX;
        cuaY = windowLogical.windowY;
      }

      const button = input.button ?? 'left';
      const cuaButton = button === 'right' ? 'right' : 'left';
      const count = button === 'double' ? 2 : 1;

      const deliveryMode =
        input.delivery_mode ??
        (enforcer?.getConfig().allowForeground ? 'foreground' : 'background');

      const clickArgs: Record<string, unknown> = {
        pid: input.pid,
        window_id: input.window_id,
        x: cuaX,
        y: cuaY,
        button: cuaButton,
        count,
        delivery_mode: deliveryMode,
      };

      if (input.debug_image_out) {
        clickArgs.debug_image_out = input.debug_image_out;
      }

      const callStartTime = Date.now();
      let backendResult = await backend.callTool('click', clickArgs);

      // Graceful fallback for child/modal windows when debug_image_out fails due to retained image size mismatch
      if (
        backendResult.isError &&
        clickArgs.debug_image_out &&
        extractErrorText(backendResult).includes('debug_image_out write failed')
      ) {
        logger.warn(
          'debug_image_out write failed due to child window retained image size mismatch; retrying click without debug overlay...'
        );
        const retryArgs = { ...clickArgs };
        delete retryArgs.debug_image_out;
        backendResult = await backend.callTool('click', retryArgs);
      }

      let fallbackDeliveryMode: string | undefined;

      // Auto-fallback for window focus errors (macOS modals, popups, dropdowns)
      if (backendResult.isError && isWindowFocusError(extractErrorText(backendResult))) {
        const targetMode = deliveryMode === 'foreground' ? 'background' : 'foreground';
        logger.warn(
          `Focus error in visual_click (${extractErrorText(backendResult)}); retrying with delivery_mode='${targetMode}'...`
        );
        const retryArgs = { ...clickArgs, delivery_mode: targetMode };
        const retryRes = await backend.callTool('click', retryArgs);
        if (!retryRes.isError) {
          backendResult = retryRes;
          fallbackDeliveryMode = targetMode;
        }
      }

      const durationMs = Date.now() - callStartTime;

      audit.log({
        tool: name,
        target_bundle_id: windowInfo?.bundle_id ?? null,
        status: backendResult.isError ? 'error' : 'ok',
        duration_ms: durationMs,
        details: {
          ...args,
          coords: { normalized: norm, window_logical: windowLogical, screen_logical: screenLogical },
          ...(fallbackDeliveryMode ? { delivery_mode_fallback: true, fallback_delivery_mode: fallbackDeliveryMode } : {}),
        },
      });

      if (backendResult.isError) {
        return backendResult;
      }

      const structuredResult: Record<string, unknown> = {
        status: 'ok',
        button,
        coords: {
          normalized: norm,
          window_logical: windowLogical,
          screen_logical: screenLogical,
        },
        window_bounds: bounds,
        pid: input.pid,
        window_id: input.window_id,
      };

      if (fallbackDeliveryMode) {
        structuredResult.delivery_mode_fallback = true;
        structuredResult.fallback_delivery_mode = fallbackDeliveryMode;
      }

      const toolRes: CallToolResult = {
        content: [
          {
            type: 'text',
            text: `Visual click [${button}] executed at window (${windowLogical.windowX}, ${windowLogical.windowY}) [${(norm.x_pct * 100).toFixed(1)}%, ${(norm.y_pct * 100).toFixed(1)}%]${
              fallbackDeliveryMode ? ` (fallback to delivery_mode='${fallbackDeliveryMode}')` : ''
            }`,
          },
        ],
        structuredContent: structuredResult,
      };
      attachBatchReminderIfNeeded(name, toolRes);
      return toolRes;
    }

    // --- Vision Tool 2: press_hotkey ---
    if (name === 'press_hotkey') {
      const parseResult = PressHotkeyInputSchema.safeParse(args);
      if (!parseResult.success) {
        const errorMsg = parseResult.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join(', ');
        audit.log({
          tool: name,
          target_bundle_id: null,
          status: 'INVALID_ARGUMENTS',
          duration_ms: 0,
          details: { error: errorMsg, ...args },
        });
        return {
          isError: true,
          content: [{ type: 'text', text: `Invalid arguments for press_hotkey: ${errorMsg}` }],
          structuredContent: { code: 'INVALID_ARGUMENTS', message: errorMsg },
        };
      }
      const input = parseResult.data;

      const parsed = normalizeHotkey(input.keys);
      let backendResult: CallToolResult;
      const callStartTime = Date.now();

      if (parsed.isSingleKey && parsed.singleKey) {
        if (isInsertKey(parsed.singleKey)) {
          sendMacInsertKeycode();
          backendResult = {
            content: [{ type: 'text', text: 'Pressed Insert/Help key via macOS key code 114.' }],
            structuredContent: { status: 'ok', key: 'Insert' },
          };
        } else {
          backendResult = await backend.callTool('press_key', {
            pid: input.pid,
            window_id: input.window_id,
            key: parsed.singleKey,
            delivery_mode: 'background',
          });
          if (backendResult.isError && extractErrorText(backendResult).includes('same_pid_keyboard_ambiguity')) {
            logger.warn('same_pid_keyboard_ambiguity in press_hotkey; retrying with delivery_mode=foreground...');
            backendResult = await backend.callTool('press_key', {
              pid: input.pid,
              window_id: input.window_id,
              key: parsed.singleKey,
              delivery_mode: 'foreground',
            });
          }
        }
      } else {
        backendResult = await backend.callTool('hotkey', {
          pid: input.pid,
          window_id: input.window_id,
          keys: parsed.chord ?? input.keys,
          delivery_mode: 'background',
        });
        if (backendResult.isError && extractErrorText(backendResult).includes('same_pid_keyboard_ambiguity')) {
          logger.warn('same_pid_keyboard_ambiguity in press_hotkey; retrying with delivery_mode=foreground...');
          backendResult = await backend.callTool('hotkey', {
            pid: input.pid,
            window_id: input.window_id,
            keys: parsed.chord ?? input.keys,
            delivery_mode: 'foreground',
          });
        }
      }
      const durationMs = Date.now() - callStartTime;

      audit.log({
        tool: name,
        target_bundle_id: null,
        status: backendResult.isError ? 'error' : 'ok',
        duration_ms: durationMs,
        details: { ...args, parsed_keys: parsed },
      });

      if (backendResult.isError) {
        return backendResult;
      }

      const toolRes: CallToolResult = {
        content: [
          {
            type: 'text',
            text: `Hotkey [${input.keys.join('+')}] pressed successfully.`,
          },
        ],
        structuredContent: {
          status: 'ok',
          keys: input.keys,
          parsed_keys: parsed,
          pid: input.pid,
          window_id: input.window_id,
        },
      };
      attachBatchReminderIfNeeded(name, toolRes);
      return toolRes;
    }

    // --- Vision Tool 3: get_window_screenshot ---
    if (name === 'get_window_screenshot') {
      const parseResult = GetWindowScreenshotInputSchema.safeParse(args);
      if (!parseResult.success) {
        const errorMsg = parseResult.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join(', ');
        audit.log({
          tool: name,
          target_bundle_id: null,
          status: 'INVALID_ARGUMENTS',
          duration_ms: 0,
          details: { error: errorMsg, ...args },
        });
        return {
          isError: true,
          content: [{ type: 'text', text: `Invalid arguments for get_window_screenshot: ${errorMsg}` }],
          structuredContent: { code: 'INVALID_ARGUMENTS', message: errorMsg },
        };
      }
      const input = parseResult.data;

      const callStartTime = Date.now();
      const stateResult = await backend.callTool('get_window_state', {
        pid: input.pid,
        window_id: input.window_id,
        include_accessibility_tree: false,
        include_screenshot: true,
      });
      const durationMs = Date.now() - callStartTime;

      if (stateResult.isError) {
        audit.log({
          tool: name,
          target_bundle_id: null,
          status: 'error',
          duration_ms: durationMs,
          details: args,
        });
        return stateResult;
      }

      const imageItem = stateResult.content?.find((c) => c.type === 'image');
      if (!imageItem || typeof (imageItem as Record<string, unknown>).data !== 'string') {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Screenshot image was not returned by backend.' }],
          structuredContent: { code: 'NO_IMAGE', message: 'No image found in get_window_state response' },
        };
      }

      const base64Data = (imageItem as { data: string }).data;
      const buffer = Buffer.from(base64Data, 'base64');
      let width_px = 0;
      let height_px = 0;
      if (buffer.length >= 24) {
        width_px = buffer.readUInt32BE(16);
        height_px = buffer.readUInt32BE(20);
      }

      const windowInfo = enforcer?.getWindowInfo(input.window_id);
      const sc = stateResult.structuredContent as Record<string, unknown> | undefined;
      const stateBounds = (sc?.window_bounds || sc?.bounds) as { width?: number; height?: number } | undefined;

      const logical_width = stateBounds?.width ?? windowInfo?.bounds?.width ?? (width_px > 0 ? width_px / 2 : 800);
      const logical_height = stateBounds?.height ?? windowInfo?.bounds?.height ?? (height_px > 0 ? height_px / 2 : 600);
      const scale_factor =
        logical_width > 0 && width_px > 0
          ? Number((width_px / logical_width).toFixed(2))
          : 2.0;

      // Optimize image (downsample + convert to JPEG) using native macOS sips
      const optResult = optimizeScreenshot(buffer, {
        maxWidth: input.max_width ?? 1440,
        format: input.format ?? 'jpeg',
        quality: input.quality ?? 80,
      });

      lastWindowDownscale.set(input.window_id, optResult.downscaleRatio);

      let savedToFile: string | undefined;
      if (input.save_to_file) {
        try {
          const dir = path.dirname(input.save_to_file);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(input.save_to_file, optResult.buffer);
          savedToFile = input.save_to_file;
        } catch (err) {
          logger.error('Failed to save screenshot to file:', err);
        }
      }

      const metadata: Record<string, unknown> = {
        width_px: optResult.originalWidth,
        height_px: optResult.originalHeight,
        image_width_px: optResult.width,
        image_height_px: optResult.height,
        downscale_ratio: optResult.downscaleRatio,
        format: optResult.mimeType,
        logical_width,
        logical_height,
        scale_factor,
        window_id: input.window_id,
        pid: input.pid,
      };
      if (savedToFile) {
        metadata.saved_to_file = savedToFile;
      }

      audit.log({
        tool: name,
        target_bundle_id: windowInfo?.bundle_id ?? null,
        status: 'ok',
        duration_ms: durationMs,
        details: { ...args, ...metadata },
      });

      const contentList: Array<{ type: string; [key: string]: unknown }> = [];
      const includeImage = input.include_image !== false;
      if (includeImage) {
        contentList.push({
          type: 'image',
          data: optResult.base64,
          mimeType: optResult.mimeType,
        });
      }
      contentList.push({
        type: 'text',
        text: `Window screenshot captured (${optResult.mimeType}${optResult.downscaleRatio > 1 ? `, downscaled ${optResult.downscaleRatio}x` : ''}${savedToFile ? `, saved to ${savedToFile}` : ''}): ${optResult.width}x${optResult.height} px (original: ${optResult.originalWidth}x${optResult.originalHeight} px), logical: ${logical_width}x${logical_height}, scale: ${scale_factor}x`,
      });

      return {
        content: contentList,
        structuredContent: metadata,
      };
    }

    // --- Vision Tool 4: clipboard_paste ---
    if (name === 'clipboard_paste') {
      const parseResult = ClipboardPasteInputSchema.safeParse(args);
      if (!parseResult.success) {
        const errorMsg = parseResult.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join(', ');
        audit.log({
          tool: name,
          target_bundle_id: null,
          status: 'INVALID_ARGUMENTS',
          duration_ms: 0,
          details: { error: errorMsg, ...args },
        });
        return {
          isError: true,
          content: [{ type: 'text', text: `Invalid arguments for clipboard_paste: ${errorMsg}` }],
          structuredContent: { code: 'INVALID_ARGUMENTS', message: errorMsg },
        };
      }
      const input = parseResult.data;
      const callStartTime = Date.now();

      try {
        setSystemClipboard(input.text);
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Failed to set clipboard: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          structuredContent: { code: 'CLIPBOARD_ERROR', error: String(err) },
        };
      }

      const targetDeliveryMode = input.delivery_mode ?? 'foreground';
      let backendResult = await backend.callTool('hotkey', {
        pid: input.pid,
        window_id: input.window_id,
        keys: ['cmd', 'v'],
        delivery_mode: targetDeliveryMode,
      });

      let clipboardFallbackMode: string | undefined;
      if (backendResult.isError && isWindowFocusError(extractErrorText(backendResult))) {
        const altMode = targetDeliveryMode === 'foreground' ? 'background' : 'foreground';
        logger.warn(
          `Focus/ambiguity error in clipboard_paste (${extractErrorText(backendResult)}); retrying with delivery_mode='${altMode}'...`
        );
        const retryRes = await backend.callTool('hotkey', {
          pid: input.pid,
          window_id: input.window_id,
          keys: ['cmd', 'v'],
          delivery_mode: altMode,
        });
        if (!retryRes.isError) {
          backendResult = retryRes;
          clipboardFallbackMode = altMode;
        }
      }

      const durationMs = Date.now() - callStartTime;

      const windowInfo = enforcer?.getWindowInfo(input.window_id);
      audit.log({
        tool: name,
        target_bundle_id: windowInfo?.bundle_id ?? null,
        status: backendResult.isError ? 'error' : 'ok',
        duration_ms: durationMs,
        details: { pid: input.pid, window_id: input.window_id, text_length: input.text.length },
      });

      if (backendResult.isError) {
        return backendResult;
      }

      const toolRes: CallToolResult = {
        content: [
          {
            type: 'text',
            text: `Pasted text (${input.text.length} chars) into window ${input.window_id} via clipboard.${
              clipboardFallbackMode ? ` (fallback to delivery_mode='${clipboardFallbackMode}')` : ''
            }`,
          },
        ],
        structuredContent: {
          status: 'ok',
          pid: input.pid,
          window_id: input.window_id,
          text_length: input.text.length,
          delivery_mode: clipboardFallbackMode ?? targetDeliveryMode,
          ...(clipboardFallbackMode ? { delivery_mode_fallback: true, fallback_delivery_mode: clipboardFallbackMode } : {}),
        },
      };
      attachBatchReminderIfNeeded(name, toolRes);
      return toolRes;
    }

    // --- Vision Tool 5: execute_action_sequence ---
    if (name === 'execute_action_sequence') {
      const parseResult = ExecuteActionSequenceInputSchema.safeParse(args);
      if (!parseResult.success) {
        const errorMsg = parseResult.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join(', ');
        audit.log({
          tool: name,
          target_bundle_id: null,
          status: 'INVALID_ARGUMENTS',
          duration_ms: 0,
          details: { error: errorMsg, ...args },
        });
        return {
          isError: true,
          content: [{ type: 'text', text: `Invalid arguments for execute_action_sequence: ${errorMsg}` }],
          structuredContent: { code: 'INVALID_ARGUMENTS', message: errorMsg },
        };
      }
      const input = parseResult.data;
      const callStartTime = Date.now();
      const defaultDeliveryMode =
        input.delivery_mode ??
        (enforcer?.getConfig().allowForeground ? 'foreground' : 'background');

      // Target window for snapshot dimensions if needed
      let snapshotWindowId = input.window_id;
      let snapshotPid = input.pid;

      if (snapshotWindowId === undefined) {
        for (const s of input.steps) {
          if ('window_id' in s && typeof s.window_id === 'number') {
            snapshotWindowId = s.window_id;
            snapshotPid = typeof s.pid === 'number' ? s.pid : await resolvePidForWindow(s.window_id);
            break;
          }
        }
      }

      let shot_w = 0;
      let shot_h = 0;
      const needsSnapshot = input.steps.some(
        (s) => s.action === 'click' || s.action === 'double_click' || s.action === 'right_click'
      );

      if (needsSnapshot && snapshotWindowId !== undefined && snapshotPid !== undefined) {
        try {
          const snap = await backend.callTool('get_window_state', {
            pid: snapshotPid,
            window_id: snapshotWindowId,
            include_accessibility_tree: false,
            include_screenshot: true,
          });
          const img = snap.content?.find((c) => c.type === 'image');
          if (img && typeof (img as any).data === 'string') {
            const b = Buffer.from((img as any).data, 'base64');
            if (b.length >= 24) {
              shot_w = b.readUInt32BE(16);
              shot_h = b.readUInt32BE(20);
            }
          }
        } catch (err) {
          logger.warn('Failed to get snapshot for execute_action_sequence:', err);
        }
      }

      const stepResults: Array<{
        step: number;
        action: string;
        status: string;
        error?: string;
        delivery_mode_fallback?: boolean;
        fallback_delivery_mode?: string;
      }> = [];
      let executedSteps = 0;
      let sequenceFallbackOccurred = false;

      let initialWindowIds: Set<number> | undefined;
      if (input.stop_on_new_window) {
        try {
          const listRes = await backend.callTool('list_windows', {});
          const wins = ((listRes.structuredContent as any)?.windows as Array<{ window_id: number }>) || [];
          initialWindowIds = new Set(wins.map((w) => w.window_id));
        } catch {
          // ignore
        }
      }

      let stoppedEarlyDueToNewWindow = false;
      let newWindowDetails: Record<string, unknown> | undefined;

      for (let i = 0; i < input.steps.length; i++) {
        const step = input.steps[i];
        let stepStatus = 'ok';
        let stepError: string | undefined;
        let stepDeliveryFallback: string | undefined;

        // Context inheritance: step inherits window_id and pid from batch level if omitted
        const stepWindowId =
          'window_id' in step && typeof step.window_id === 'number'
            ? step.window_id
            : input.window_id;

        let stepPid =
          'pid' in step && typeof step.pid === 'number'
            ? step.pid
            : 'window_id' in step && typeof step.window_id === 'number' && step.window_id !== input.window_id
            ? undefined
            : input.pid;

        if (stepWindowId !== undefined && (stepPid === undefined || stepPid === null)) {
          stepPid = await resolvePidForWindow(stepWindowId);
        }

        // Safety checkpoint: check if unexpected modal or alert appeared
        if (i > 0 && initialWindowIds && input.stop_on_new_window) {
          try {
            const listRes = await backend.callTool('list_windows', {});
            const wins = ((listRes.structuredContent as any)?.windows as Array<Record<string, unknown>>) || [];
            const newWin = wins.find((w) => typeof w.window_id === 'number' && !initialWindowIds.has(w.window_id as number));
            if (newWin) {
              logger.info(`New window appeared during action sequence (${newWin.window_id}: "${newWin.title}"); pausing sequence for safety.`);
              stoppedEarlyDueToNewWindow = true;
              newWindowDetails = newWin;
              break;
            }
          } catch {
            // ignore
          }
        }

        try {
          if (step.action === 'click' || step.action === 'double_click' || step.action === 'right_click') {
            if (stepWindowId === undefined || stepPid === undefined) {
              throw new Error(`Step '${step.action}' requires window_id either on the step or at sequence level.`);
            }

            const stepDownscale = (stepWindowId !== undefined ? lastWindowDownscale.get(stepWindowId) : undefined) ?? 1.0;
            let targetX: number;
            let targetY: number;

            if (typeof step.x_pixel === 'number' && typeof step.y_pixel === 'number') {
              targetX = Math.round(step.x_pixel * stepDownscale);
              targetY = Math.round(step.y_pixel * stepDownscale);
            } else if (typeof step.x === 'number' && typeof step.y === 'number') {
              targetX = Math.round(step.x * stepDownscale);
              targetY = Math.round(step.y * stepDownscale);
            } else if (
              typeof step.x_percent === 'number' &&
              typeof step.y_percent === 'number' &&
              shot_w > 0 &&
              shot_h > 0
            ) {
              targetX = Math.round(step.x_percent * shot_w);
              targetY = Math.round(step.y_percent * shot_h);
            } else {
              targetX = 0;
              targetY = 0;
            }

            let button: 'left' | 'right' = 'left';
            let count = 1;
            if (step.action === 'double_click') {
              count = 2;
            } else if (step.action === 'right_click') {
              button = 'right';
            } else if (step.action === 'click') {
              if (step.button === 'right') {
                button = 'right';
              } else if (step.button === 'double') {
                count = 2;
              }
            }

            const stepDelivery = step.delivery_mode ?? defaultDeliveryMode;
            let res = await backend.callTool('click', {
              pid: stepPid,
              window_id: stepWindowId,
              x: targetX,
              y: targetY,
              button,
              count,
              delivery_mode: stepDelivery,
            });

            // Focus error auto-fallback
            if (res.isError && isWindowFocusError(extractErrorText(res))) {
              const targetMode = stepDelivery === 'foreground' ? 'background' : 'foreground';
              logger.warn(
                `Focus error in execute_action_sequence step ${i + 1} (${extractErrorText(res)}); retrying with delivery_mode='${targetMode}'...`
              );
              const retryRes = await backend.callTool('click', {
                pid: stepPid,
                window_id: stepWindowId,
                x: targetX,
                y: targetY,
                button,
                count,
                delivery_mode: targetMode,
              });
              if (!retryRes.isError) {
                res = retryRes;
                stepDeliveryFallback = targetMode;
                sequenceFallbackOccurred = true;
              }
            }

            if (res.isError) {
              stepStatus = 'error';
              stepError = extractErrorText(res);
            }
          } else if (step.action === 'paste') {
            if (stepWindowId === undefined || stepPid === undefined) {
              throw new Error("Step 'paste' requires window_id either on the step or at sequence level.");
            }
            setSystemClipboard(step.text);
            const stepDelivery = step.delivery_mode ?? defaultDeliveryMode ?? 'foreground';
            let res = await backend.callTool('hotkey', {
              pid: stepPid,
              window_id: stepWindowId,
              keys: ['cmd', 'v'],
              delivery_mode: stepDelivery,
            });
            if (res.isError && isWindowFocusError(extractErrorText(res))) {
              const altMode = stepDelivery === 'foreground' ? 'background' : 'foreground';
              logger.warn(`Focus/ambiguity error in paste step ${i + 1}; retrying with delivery_mode='${altMode}'...`);
              const retryRes = await backend.callTool('hotkey', {
                pid: stepPid,
                window_id: stepWindowId,
                keys: ['cmd', 'v'],
                delivery_mode: altMode,
              });
              if (!retryRes.isError) {
                res = retryRes;
                stepDeliveryFallback = altMode;
                sequenceFallbackOccurred = true;
              }
            }
            if (res.isError) {
              stepStatus = 'error';
              stepError = extractErrorText(res);
            }
          } else if (step.action === 'type') {
            if (stepWindowId === undefined || stepPid === undefined) {
              throw new Error("Step 'type' requires window_id either on the step or at sequence level.");
            }
            const stepDelivery = step.delivery_mode ?? defaultDeliveryMode ?? 'foreground';
            let res = await backend.callTool('type_text', {
              pid: stepPid,
              window_id: stepWindowId,
              text: step.text,
              delivery_mode: stepDelivery,
            });
            if (res.isError && isWindowFocusError(extractErrorText(res))) {
              const altMode = stepDelivery === 'foreground' ? 'background' : 'foreground';
              logger.warn(`Focus/ambiguity error in type step ${i + 1}; retrying with delivery_mode='${altMode}'...`);
              const retryRes = await backend.callTool('type_text', {
                pid: stepPid,
                window_id: stepWindowId,
                text: step.text,
                delivery_mode: altMode,
              });
              if (!retryRes.isError) {
                res = retryRes;
                stepDeliveryFallback = altMode;
                sequenceFallbackOccurred = true;
              }
            }
            if (res.isError) {
              stepStatus = 'error';
              stepError = extractErrorText(res);
            }
          } else if (step.action === 'hotkey') {
            if (stepWindowId === undefined || stepPid === undefined) {
              throw new Error("Step 'hotkey' requires window_id either on the step or at sequence level.");
            }
            let res: CallToolResult;
            if (step.keys.some(isInsertKey)) {
              sendMacInsertKeycode();
              res = { content: [{ type: 'text', text: 'Sent Insert keycode 114 via System Events' }], isError: false };
            } else {
              const stepDelivery = step.delivery_mode ?? defaultDeliveryMode ?? 'foreground';
              const parsed = normalizeHotkey(step.keys);
              if (parsed.isSingleKey && parsed.singleKey) {
                res = await backend.callTool('press_key', {
                  pid: stepPid,
                  window_id: stepWindowId,
                  key: parsed.singleKey,
                  delivery_mode: stepDelivery,
                });
                if (res.isError && isWindowFocusError(extractErrorText(res))) {
                  const altMode = stepDelivery === 'foreground' ? 'background' : 'foreground';
                  logger.warn(`Focus/ambiguity in step ${i + 1}; retrying with delivery_mode='${altMode}'...`);
                  const retryRes = await backend.callTool('press_key', {
                    pid: stepPid,
                    window_id: stepWindowId,
                    key: parsed.singleKey,
                    delivery_mode: altMode,
                  });
                  if (!retryRes.isError) {
                    res = retryRes;
                    stepDeliveryFallback = altMode;
                    sequenceFallbackOccurred = true;
                  }
                }
              } else {
                res = await backend.callTool('hotkey', {
                  pid: stepPid,
                  window_id: stepWindowId,
                  keys: parsed.chord ?? step.keys,
                  delivery_mode: stepDelivery,
                });
                if (res.isError && isWindowFocusError(extractErrorText(res))) {
                  const altMode = stepDelivery === 'foreground' ? 'background' : 'foreground';
                  logger.warn(`Focus/ambiguity in step ${i + 1}; retrying with delivery_mode='${altMode}'...`);
                  const retryRes = await backend.callTool('hotkey', {
                    pid: stepPid,
                    window_id: stepWindowId,
                    keys: parsed.chord ?? step.keys,
                    delivery_mode: altMode,
                  });
                  if (!retryRes.isError) {
                    res = retryRes;
                    stepDeliveryFallback = altMode;
                    sequenceFallbackOccurred = true;
                  }
                }
              }
            }
            if (res.isError) {
              stepStatus = 'error';
              stepError = extractErrorText(res);
            }
          } else if (step.action === 'sleep') {
            await new Promise((resolve) => setTimeout(resolve, step.ms));
          }
        } catch (err) {
          stepStatus = 'error';
          stepError = err instanceof Error ? err.message : String(err);
        }

        const stepResultItem: {
          step: number;
          action: string;
          status: string;
          error?: string;
          delivery_mode_fallback?: boolean;
          fallback_delivery_mode?: string;
        } = {
          step: i + 1,
          action: step.action,
          status: stepStatus,
          error: stepError,
        };

        if (stepDeliveryFallback) {
          stepResultItem.delivery_mode_fallback = true;
          stepResultItem.fallback_delivery_mode = stepDeliveryFallback;
        }

        stepResults.push(stepResultItem);
        executedSteps++;

        if (stepStatus === 'error' && input.stop_on_error !== false) {
          break; // Stop sequence on error
        }

        // Apply delay_between_ms after action if not last step and not sleep
        if (i < input.steps.length - 1 && step.action !== 'sleep' && input.delay_between_ms > 0) {
          await new Promise((resolve) => setTimeout(resolve, input.delay_between_ms));
        }
      }

      const durationMs = Date.now() - callStartTime;
      const allSuccess = stepResults.every((r) => r.status === 'ok');
      const windowInfo = input.window_id !== undefined ? enforcer?.getWindowInfo(input.window_id) : undefined;

      audit.log({
        tool: name,
        target_bundle_id: windowInfo?.bundle_id ?? null,
        status: allSuccess ? 'ok' : 'error',
        duration_ms: durationMs,
        details: { total_steps: input.steps.length, executed_steps: executedSteps, step_results: stepResults },
      });

      if (stoppedEarlyDueToNewWindow) {
        return {
          content: [
            {
              type: 'text',
              text: `Action sequence paused at step ${executedSteps}/${input.steps.length}: a new window appeared (${
                (newWindowDetails as any)?.title || (newWindowDetails as any)?.window_id || 'unknown'
              }). Inspect window state before proceeding.`,
            },
          ],
          structuredContent: {
            status: 'paused_new_window',
            new_window: newWindowDetails,
            total_steps: input.steps.length,
            executed_steps: executedSteps,
            duration_ms: durationMs,
            step_results: stepResults,
          },
        };
      }

      if (!allSuccess) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Action sequence failed at step ${executedSteps}/${input.steps.length}: ${
                stepResults[stepResults.length - 1]?.error || 'Unknown error'
              }`,
            },
          ],
          structuredContent: {
            status: 'error',
            total_steps: input.steps.length,
            executed_steps: executedSteps,
            step_results: stepResults,
          },
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Action sequence completed: ${executedSteps}/${input.steps.length} steps executed successfully in ${durationMs}ms.${
              sequenceFallbackOccurred ? ' (with delivery_mode fallback on focused window error)' : ''
            }`,
          },
        ],
        structuredContent: {
          status: 'ok',
          total_steps: input.steps.length,
          executed_steps: executedSteps,
          duration_ms: durationMs,
          step_results: stepResults,
          ...(sequenceFallbackOccurred ? { delivery_mode_fallback: true } : {}),
        },
      };
    }

    // --- Custom Tool: wait_for_window ---
    if (name === 'wait_for_window') {
      const parseResult = WaitForWindowInputSchema.safeParse(args);
      if (!parseResult.success) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Invalid arguments for wait_for_window: ${parseResult.error.message}` }],
        };
      }
      const { title, bundle_id, window_id } = parseResult.data;
      const targetState = parseResult.data.state ?? 'opened';
      const timeoutMs = parseResult.data.timeout_ms ?? 5000;
      const pollIntervalMs = parseResult.data.poll_interval_ms ?? 150;
      const callStartTime = Date.now();
      let matchedWindow: Record<string, unknown> | undefined;

      while (Date.now() - callStartTime < timeoutMs) {
        try {
          const listRes = await backend.callTool('list_windows', {});
          const wins = ((listRes.structuredContent as any)?.windows as Array<Record<string, unknown>>) || [];

          const match = wins.find((w) => {
            if (window_id !== undefined && w.window_id !== window_id) return false;
            if (bundle_id !== undefined && w.bundle_id !== bundle_id) return false;
            if (title !== undefined) {
              const winTitle = String(w.title || '').toLowerCase();
              if (!winTitle.includes(title.toLowerCase())) return false;
            }
            return true;
          });

          if (targetState === 'opened' && match) {
            matchedWindow = match;
            break;
          }
          if (targetState === 'closed' && !match) {
            break;
          }
        } catch {
          // ignore transient poll error
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      const durationMs = Date.now() - callStartTime;
      const success = targetState === 'opened' ? Boolean(matchedWindow) : !matchedWindow;

      audit.log({
        tool: name,
        target_bundle_id: bundle_id ?? (matchedWindow?.bundle_id as string | undefined) ?? null,
        status: success ? 'ok' : 'timeout',
        duration_ms: durationMs,
        details: { state: targetState, criteria: { title, bundle_id, window_id }, matched_window: matchedWindow },
      });

      if (!success) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `wait_for_window timed out after ${durationMs}ms waiting for window (state=${targetState}, title=${title ?? 'any'}, bundle_id=${bundle_id ?? 'any'}, window_id=${window_id ?? 'any'}).`,
            },
          ],
          structuredContent: {
            status: 'timeout',
            elapsed_ms: durationMs,
            state: targetState,
            criteria: { title, bundle_id, window_id },
          },
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Window condition met in ${durationMs}ms (state=${targetState}${matchedWindow ? `, title="${matchedWindow.title}", window_id=${matchedWindow.window_id}` : ''}).`,
          },
        ],
        structuredContent: {
          status: 'ok',
          elapsed_ms: durationMs,
          state: targetState,
          window: matchedWindow,
        },
      };
    }

    if (enforcer) {
      // Scale zoom coordinates if downscaled
      let callArgs = args;
      if (name === 'zoom' && typeof args.window_id === 'number') {
        const ratio = lastWindowDownscale.get(args.window_id) ?? 1.0;
        if (ratio !== 1.0) {
          callArgs = {
            ...args,
            x1: typeof args.x1 === 'number' ? Math.round(args.x1 * ratio) : args.x1,
            y1: typeof args.y1 === 'number' ? Math.round(args.y1 * ratio) : args.y1,
            x2: typeof args.x2 === 'number' ? Math.round(args.x2 * ratio) : args.x2,
            y2: typeof args.y2 === 'number' ? Math.round(args.y2 * ratio) : args.y2,
          };
        }
      }

      // Special interception for press_key with 'insert' / 'help'
      if (name === 'press_key' && isInsertKey(callArgs.key)) {
        sendMacInsertKeycode();
        const toolRes: CallToolResult = {
          content: [{ type: 'text', text: `Key [${callArgs.key}] sent successfully via macOS key code 114 (Help/Insert).` }],
          structuredContent: { status: 'ok', key: callArgs.key, window_id: callArgs.window_id },
        };
        attachBatchReminderIfNeeded(name, toolRes);
        return toolRes;
      }

      // Execute on backend with duration measurement
      const callStartTime = Date.now();
      let result: CallToolResult = await backend.callTool(name, callArgs);
      let backendFallbackMode: string | undefined;

      // Auto-fallback for focus/ambiguity errors on keyboard tools
      if (
        (name === 'press_key' || name === 'hotkey' || name === 'type_text') &&
        result.isError &&
        isWindowFocusError(extractErrorText(result))
      ) {
        logger.warn(`Focus/ambiguity error in ${name}; retrying with delivery_mode='foreground'...`);
        const retryArgs = { ...args, delivery_mode: 'foreground' };
        const retryRes = await backend.callTool(name, retryArgs);
        if (!retryRes.isError) {
          result = retryRes;
        }
      }

      // Auto-fallback for window focus errors on click actions
      if (
        (name === 'click' || name === 'double_click' || name === 'right_click') &&
        result.isError &&
        isWindowFocusError(extractErrorText(result))
      ) {
        const curMode = (args.delivery_mode as string) || 'foreground';
        const targetMode = curMode === 'foreground' ? 'background' : 'foreground';
        logger.warn(
          `Focus error in ${name} (${extractErrorText(result)}); retrying with delivery_mode='${targetMode}'...`
        );
        const retryArgs = { ...args, delivery_mode: targetMode };
        const retryRes = await backend.callTool(name, retryArgs);
        if (!retryRes.isError) {
          result = retryRes;
          backendFallbackMode = targetMode;
          if (result.structuredContent && typeof result.structuredContent === 'object') {
            (result.structuredContent as Record<string, unknown>).delivery_mode_fallback = true;
            (result.structuredContent as Record<string, unknown>).fallback_delivery_mode = targetMode;
          } else {
            result.structuredContent = {
              status: 'ok',
              delivery_mode_fallback: true,
              fallback_delivery_mode: targetMode,
            };
          }
          if (Array.isArray(result.content)) {
            result.content.push({
              type: 'text',
              text: `Note: executed with fallback delivery_mode='${targetMode}' after focus error.`,
            });
          }
        }
      }

      const durationMs = Date.now() - callStartTime;

      // Check if the backend reported a crash of the target application/window
      if (result.isError) {
        const errorText = extractErrorText(result);

        if (isAppCrashError(errorText)) {
          logger.warn(`Detected target application crash/termination in ${name}: ${errorText}`);

          // Invalidate cache for the affected pid/window so stale entries are purged
          if (typeof args.pid === 'number') {
            enforcer.invalidatePid(args.pid);
          }
          if (typeof args.window_id === 'number') {
            enforcer.invalidateWindow(args.window_id);
            localWindowCache.delete(args.window_id);
          }

          // Check if autoRelaunch is enabled
          if (enforcer.getConfig().autoRelaunch && check?.targetBundleId && recoveryManager) {
            logger.info(`autoRelaunch active: attempting automatic restart of ${check.targetBundleId}...`);
            try {
              const relaunch = await recoveryManager.ensureAppRunning({
                bundle_id: check.targetBundleId,
              });

              result = {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: `Target application '${check.targetBundleId}' terminated but was automatically relaunched (autoRelaunch: true). You MUST call get_window_state before performing further actions.`,
                  },
                ],
                structuredContent: {
                  code: 'APP_RELAUNCHED',
                  message:
                    'Application automatically relaunched. You MUST call get_window_state to capture the new window state.',
                  bundle_id: check.targetBundleId,
                  requires_new_state: true,
                  relaunch,
                },
              };
            } catch (rErr) {
              logger.error('Automatic relaunch failed:', rErr);
            }
          }

          // If not relaunched or relaunch failed: return structured APP_NOT_RUNNING error
          if (!result.structuredContent || (result.structuredContent as Record<string, unknown>).code !== 'APP_RELAUNCHED') {
            result = {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: 'Target application process terminated or is not running. Call ensure_app_running to relaunch, then call get_window_state.',
                },
              ],
              structuredContent: {
                code: 'APP_NOT_RUNNING',
                message:
                  'Target application process terminated or is not running. Call ensure_app_running to relaunch, then call get_window_state.',
                suggested_action: 'ensure_app_running',
                target_bundle_id: check?.targetBundleId ?? null,
              },
            };
          }
        }
      }

      // Update window cache if list_windows was called
      if (name === 'list_windows' && result.structuredContent) {
        const sc = result.structuredContent as Record<string, unknown>;
        if (Array.isArray(sc.windows)) {
          enforcer.updateWindowCache(sc.windows as WindowInfo[]);
          for (const w of sc.windows as WindowInfo[]) {
            localWindowCache.set(w.window_id, w);
          }
        }
      }

      // Record in audit log with duration
      const auditDetails = prepareAuditDetails(name, args, enforcer.getConfig().logTypedText);
      audit.log({
        tool: name,
        target_bundle_id: check?.targetBundleId ?? null,
        status: result.isError ? ((result.structuredContent as Record<string, unknown>)?.code as string ?? 'error') : 'ok',
        duration_ms: durationMs,
        details: {
          ...auditDetails,
          ...(backendFallbackMode ? { delivery_mode_fallback: true, fallback_delivery_mode: backendFallbackMode } : {}),
        },
      });

      attachBatchReminderIfNeeded(name, result);
      return result;
    }

    // Direct execution without enforcer (fallback)
    let directArgs = args;
    if (name === 'zoom' && typeof args.window_id === 'number') {
      const ratio = lastWindowDownscale.get(args.window_id) ?? 1.0;
      if (ratio !== 1.0) {
        directArgs = {
          ...args,
          x1: typeof args.x1 === 'number' ? Math.round(args.x1 * ratio) : args.x1,
          y1: typeof args.y1 === 'number' ? Math.round(args.y1 * ratio) : args.y1,
          x2: typeof args.x2 === 'number' ? Math.round(args.x2 * ratio) : args.x2,
          y2: typeof args.y2 === 'number' ? Math.round(args.y2 * ratio) : args.y2,
        };
      }
    }
    let result: CallToolResult = await backend.callTool(name, directArgs);
    if (
      (name === 'click' || name === 'double_click' || name === 'right_click') &&
      result.isError &&
      isWindowFocusError(extractErrorText(result))
    ) {
      const curMode = (args.delivery_mode as string) || 'foreground';
      const targetMode = curMode === 'foreground' ? 'background' : 'foreground';
      logger.warn(
        `Focus error in ${name} (${extractErrorText(result)}); retrying with delivery_mode='${targetMode}'...`
      );
      const retryArgs = { ...args, delivery_mode: targetMode };
      const retryRes = await backend.callTool(name, retryArgs);
      if (!retryRes.isError) {
        result = retryRes;
        if (result.structuredContent && typeof result.structuredContent === 'object') {
          (result.structuredContent as Record<string, unknown>).delivery_mode_fallback = true;
          (result.structuredContent as Record<string, unknown>).fallback_delivery_mode = targetMode;
        } else {
          result.structuredContent = {
            status: 'ok',
            delivery_mode_fallback: true,
            fallback_delivery_mode: targetMode,
          };
        }
        if (Array.isArray(result.content)) {
          result.content.push({
            type: 'text',
            text: `Note: executed with fallback delivery_mode='${targetMode}' after focus error.`,
          });
        }
      }
    }
    attachBatchReminderIfNeeded(name, result);
    return result;
  });

  return server;
}

function extractErrorText(result: CallToolResult): string {
  if (result.content && Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item.type === 'text') {
        return item.text;
      }
    }
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    const sc = result.structuredContent as Record<string, unknown>;
    return (sc.message as string) || (sc.error as string) || '';
  }
  return '';
}

export function prepareAuditDetails(
  toolName: string,
  args: Record<string, unknown>,
  logTypedText: boolean
): Record<string, unknown> {
  const details = { ...args };

  if (toolName === 'type_text') {
    if (!logTypedText) {
      const rawText = typeof args.text === 'string' ? args.text : '';
      delete details.text;
      details.textLength = rawText.length;
      details.masked = true;
    } else {
      details.masked = false;
    }
  }

  return details;
}
