import fs from 'node:fs';
import path from 'node:path';
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
  normalizeHotkey,
} from './engine/schemas.js';
import { setSystemClipboard } from './engine/clipboard.js';

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
        pid: { type: 'number', description: 'Target process ID' },
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
      required: ['window_id', 'pid'],
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
        pid: { type: 'number', description: 'Target process ID' },
        text: { type: 'string', description: 'Text to copy to clipboard and paste' },
      },
      required: ['window_id', 'pid', 'text'],
    },
  },
  {
    name: 'execute_action_sequence',
    description:
      'Execute a batch sequence of visual clicks, clipboard pastes, hotkeys, typing, and pauses in a single round-trip call.',
    inputSchema: {
      type: 'object',
      properties: {
        window_id: { type: 'number', description: 'Target window ID' },
        pid: { type: 'number', description: 'Target process ID' },
        delivery_mode: {
          type: 'string',
          enum: ['foreground', 'background'],
          description: 'Optional default delivery mode for clicks in this sequence',
        },
        delay_between_ms: {
          type: 'number',
          description: 'Delay between consecutive actions in milliseconds (default: 100ms)',
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
          description: 'Ordered sequence of actions to execute',
        },
      },
      required: ['window_id', 'pid', 'steps'],
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
        pid: { type: 'number', description: 'Target process ID' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of keys to press (e.g. ["Command", "s"] or ["Return"])',
        },
      },
      required: ['window_id', 'pid', 'keys'],
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
        pid: { type: 'number', description: 'Target process ID' },
        save_to_file: {
          type: 'string',
          description: 'Optional path on disk to write the captured PNG directly',
        },
        include_image: {
          type: 'boolean',
          description: 'Whether to include base64 image in tool response (default: true). Set false with save_to_file to save network bandwidth.',
        },
      },
      required: ['window_id', 'pid'],
    },
  },
];

export function createProxyServer(
  backend: CuaDriverBackend,
  enforcer?: PolicyEnforcer,
  audit: AuditLogger = defaultAuditLogger,
  journal: JournalManager = defaultJournalManager,
  recovery?: AppRecoveryManager
): Server {
  const recoveryManager = recovery ?? (enforcer ? new AppRecoveryManager(backend, enforcer) : null);

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

    // Combine backend tools and custom proxy tools
    const combinedTools: Tool[] = [...rawTools, ...CUSTOM_PROXY_TOOL_DEFINITIONS];

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
      let cuaX: number;
      let cuaY: number;

      if (typeof input.x_pixel === 'number' && typeof input.y_pixel === 'number') {
        cuaX = Math.round(input.x_pixel);
        cuaY = Math.round(input.y_pixel);
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
      const durationMs = Date.now() - callStartTime;

      audit.log({
        tool: name,
        target_bundle_id: windowInfo?.bundle_id ?? null,
        status: backendResult.isError ? 'error' : 'ok',
        duration_ms: durationMs,
        details: {
          ...args,
          coords: { normalized: norm, window_logical: windowLogical, screen_logical: screenLogical },
        },
      });

      if (backendResult.isError) {
        return backendResult;
      }

      return {
        content: [
          {
            type: 'text',
            text: `Visual click [${button}] executed at window (${windowLogical.windowX}, ${windowLogical.windowY}) [${(norm.x_pct * 100).toFixed(1)}%, ${(norm.y_pct * 100).toFixed(1)}%]`,
          },
        ],
        structuredContent: {
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
        },
      };
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
        backendResult = await backend.callTool('press_key', {
          pid: input.pid,
          window_id: input.window_id,
          key: parsed.singleKey,
          delivery_mode: 'background',
        });
      } else {
        backendResult = await backend.callTool('hotkey', {
          pid: input.pid,
          window_id: input.window_id,
          keys: parsed.chord ?? input.keys,
          delivery_mode: 'background',
        });
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

      return {
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

      let savedToFile: string | undefined;
      if (input.save_to_file) {
        try {
          const dir = path.dirname(input.save_to_file);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(input.save_to_file, buffer);
          savedToFile = input.save_to_file;
        } catch (err) {
          logger.error('Failed to save screenshot to file:', err);
        }
      }

      const metadata: Record<string, unknown> = {
        width_px,
        height_px,
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
        contentList.push(imageItem as { type: string; [key: string]: unknown });
      }
      contentList.push({
        type: 'text',
        text: `Window screenshot captured${savedToFile ? ` and saved to ${savedToFile}` : ''}: ${width_px}x${height_px} px, logical: ${logical_width}x${logical_height}, scale: ${scale_factor}x`,
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

      const backendResult = await backend.callTool('hotkey', {
        pid: input.pid,
        window_id: input.window_id,
        keys: ['cmd', 'v'],
        delivery_mode: 'background',
      });
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

      return {
        content: [
          {
            type: 'text',
            text: `Pasted text (${input.text.length} chars) into window ${input.window_id} via clipboard.`,
          },
        ],
        structuredContent: {
          status: 'ok',
          pid: input.pid,
          window_id: input.window_id,
          text_length: input.text.length,
        },
      };
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

      // Fetch snapshot dimensions once if normalized percentage coordinates are used
      let shot_w = 0;
      let shot_h = 0;
      const needsSnapshot = input.steps.some(
        (s) =>
          (s.action === 'click' || s.action === 'double_click' || s.action === 'right_click') &&
          (typeof s.x_percent === 'number' || typeof s.y_percent === 'number')
      );

      if (needsSnapshot) {
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
          logger.warn('Failed to get snapshot for execute_action_sequence:', err);
        }
      }

      const stepResults: Array<{ step: number; action: string; status: string; error?: string }> = [];
      let executedSteps = 0;

      for (let i = 0; i < input.steps.length; i++) {
        const step = input.steps[i];
        let stepStatus = 'ok';
        let stepError: string | undefined;

        try {
          if (step.action === 'click' || step.action === 'double_click' || step.action === 'right_click') {
            let targetX: number;
            let targetY: number;

            if (typeof step.x_pixel === 'number' && typeof step.y_pixel === 'number') {
              targetX = Math.round(step.x_pixel);
              targetY = Math.round(step.y_pixel);
            } else if (typeof step.x === 'number' && typeof step.y === 'number') {
              targetX = Math.round(step.x);
              targetY = Math.round(step.y);
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
            const res = await backend.callTool('click', {
              pid: input.pid,
              window_id: input.window_id,
              x: targetX,
              y: targetY,
              button,
              count,
              delivery_mode: stepDelivery,
            });

            if (res.isError) {
              stepStatus = 'error';
              stepError = extractErrorText(res);
            }
          } else if (step.action === 'paste') {
            setSystemClipboard(step.text);
            const res = await backend.callTool('hotkey', {
              pid: input.pid,
              window_id: input.window_id,
              keys: ['cmd', 'v'],
              delivery_mode: 'background',
            });
            if (res.isError) {
              stepStatus = 'error';
              stepError = extractErrorText(res);
            }
          } else if (step.action === 'type') {
            const res = await backend.callTool('type_text', {
              pid: input.pid,
              window_id: input.window_id,
              text: step.text,
              delivery_mode: 'background',
            });
            if (res.isError) {
              stepStatus = 'error';
              stepError = extractErrorText(res);
            }
          } else if (step.action === 'hotkey') {
            const parsed = normalizeHotkey(step.keys);
            let res: CallToolResult;
            if (parsed.isSingleKey && parsed.singleKey) {
              res = await backend.callTool('press_key', {
                pid: input.pid,
                window_id: input.window_id,
                key: parsed.singleKey,
                delivery_mode: 'background',
              });
            } else {
              res = await backend.callTool('hotkey', {
                pid: input.pid,
                window_id: input.window_id,
                keys: parsed.chord ?? step.keys,
                delivery_mode: 'background',
              });
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

        stepResults.push({ step: i + 1, action: step.action, status: stepStatus, error: stepError });
        executedSteps++;

        if (stepStatus === 'error') {
          break; // Stop sequence on error
        }

        // Apply delay_between_ms after action if not last step and not sleep
        if (i < input.steps.length - 1 && step.action !== 'sleep' && input.delay_between_ms > 0) {
          await new Promise((resolve) => setTimeout(resolve, input.delay_between_ms));
        }
      }

      const durationMs = Date.now() - callStartTime;
      const allSuccess = stepResults.every((r) => r.status === 'ok');
      const windowInfo = enforcer?.getWindowInfo(input.window_id);

      audit.log({
        tool: name,
        target_bundle_id: windowInfo?.bundle_id ?? null,
        status: allSuccess ? 'ok' : 'error',
        duration_ms: durationMs,
        details: { total_steps: input.steps.length, executed_steps: executedSteps, step_results: stepResults },
      });

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
            text: `Action sequence completed: ${executedSteps}/${input.steps.length} steps executed successfully in ${durationMs}ms.`,
          },
        ],
        structuredContent: {
          status: 'ok',
          total_steps: input.steps.length,
          executed_steps: executedSteps,
          duration_ms: durationMs,
          step_results: stepResults,
        },
      };
    }

    if (enforcer) {
      // Execute on backend with duration measurement
      const callStartTime = Date.now();
      let result: CallToolResult = await backend.callTool(name, args);
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
        }
      }

      // Record in audit log with duration
      const auditDetails = prepareAuditDetails(name, args, enforcer.getConfig().logTypedText);
      audit.log({
        tool: name,
        target_bundle_id: check?.targetBundleId ?? null,
        status: result.isError ? ((result.structuredContent as Record<string, unknown>)?.code as string ?? 'error') : 'ok',
        duration_ms: durationMs,
        details: auditDetails,
      });

      return result;
    }

    // Direct execution without enforcer (fallback)
    const result: CallToolResult = await backend.callTool(name, args);
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
