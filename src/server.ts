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
import { WindowInfo } from './policy/types.js';
import { logger } from './utils/logger.js';

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
    description: 'Read all journal entries for a task or current session.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task identifier. If omitted, reads current session.',
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
      const entries = journal.read({ task_id: taskId });
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
    if (enforcer) {
      const check = await enforcer.enforce(name, args);

      if (!check.allowed) {
        logger.warn(`Policy rejected call to ${name}: ${check.code} - ${check.reason}`);
        const auditDetails = prepareAuditDetails(name, args, enforcer.getConfig().logTypedText);

        audit.log({
          tool: name,
          target_bundle_id: check.targetBundleId ?? null,
          status: check.code ?? 'REJECTED',
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

      // Execute on backend
      let result: CallToolResult = await backend.callTool(name, args);

      // Check if the backend reported a crash of the target application/window
      if (result.isError) {
        const errorText = extractErrorText(result);

        if (isAppCrashError(errorText)) {
          logger.warn(`Detected target application crash/termination in ${name}: ${errorText}`);

          // Check if autoRelaunch is enabled
          if (enforcer.getConfig().autoRelaunch && check.targetBundleId && recoveryManager) {
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
                target_bundle_id: check.targetBundleId ?? null,
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

      // Record in audit log
      const auditDetails = prepareAuditDetails(name, args, enforcer.getConfig().logTypedText);
      audit.log({
        tool: name,
        target_bundle_id: check.targetBundleId ?? null,
        status: result.isError ? ((result.structuredContent as Record<string, unknown>)?.code as string ?? 'error') : 'ok',
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

function prepareAuditDetails(
  toolName: string,
  args: Record<string, unknown>,
  logTypedText: boolean
): Record<string, unknown> {
  const details = { ...args };

  if (toolName === 'type_text' && !logTypedText) {
    const rawText = typeof args.text === 'string' ? args.text : '';
    delete details.text;
    details.textLength = rawText.length;
    details.masked = true;
  }

  return details;
}
