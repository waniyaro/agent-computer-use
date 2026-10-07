import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PolicyConfig, PolicyCheckResult, WindowInfo } from './types.js';
import { getStopFilePath } from './schema.js';
import { isToolAllowedInProfile } from './filter.js';
import { logger } from '../utils/logger.js';

const BUNDLE_ID_REGEX = /^[A-Za-z0-9_.\-\s:]+$/;

interface PidCacheEntry {
  bundleId: string | undefined;
  expiresAt: number;
}

const pidBundleIdCache = new Map<number, PidCacheEntry>();
const PID_CACHE_TTL_MS = 10000;

export function getBundleIdForPid(pid: unknown): string | undefined {
  // Strict numeric validation to prevent command injection
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > 4194304) {
    return undefined;
  }

  const now = Date.now();
  const cached = pidBundleIdCache.get(pid);
  if (cached && cached.expiresAt > now) {
    return cached.bundleId;
  }

  try {
    // Pure binary execution without shell interpolation (argv vector)
    const out = execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', String(pid)], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const match = out.match(/"CFBundleIdentifier"="([^"]+)"/);
    const resolved = match && BUNDLE_ID_REGEX.test(match[1]) ? match[1] : undefined;
    pidBundleIdCache.set(pid, { bundleId: resolved, expiresAt: now + PID_CACHE_TTL_MS });
    return resolved;
  } catch {
    pidBundleIdCache.set(pid, { bundleId: undefined, expiresAt: now + PID_CACHE_TTL_MS });
  }
  return undefined;
}

export const INSPECTION_TOOLS: ReadonlySet<string> = new Set([
  'list_apps',
  'list_windows',
  'get_screen_size',
  'get_cursor_position',
  'get_accessibility_tree',
  'check_permissions',
  'health_report',
  'get_config',
]);

export class PolicyEnforcer {
  private config: PolicyConfig;
  private stopFilePath: string;
  private actionCount = 0;
  private windowCache: Map<number, WindowInfo> = new Map(); // key by window_id
  private pidCache: Map<number, WindowInfo> = new Map(); // key by pid
  private appBundleCache: Map<string, string> = new Map(); // app_name lowercase -> bundle_id

  constructor(config: PolicyConfig, stopFilePath?: string) {
    this.config = config;
    this.stopFilePath = stopFilePath ?? getStopFilePath();
  }

  getConfig(): PolicyConfig {
    return this.config;
  }

  updateConfig(config: PolicyConfig): void {
    this.config = config;
  }

  getActionCount(): number {
    return this.actionCount;
  }

  resetActionCount(): void {
    this.actionCount = 0;
  }

  updateWindowCache(windows: WindowInfo[]): void {
    this.windowCache.clear();
    this.pidCache.clear();
    for (const w of windows) {
      if (!w.bundle_id && typeof w.pid === 'number') {
        w.bundle_id = getBundleIdForPid(w.pid);
      }
      this.windowCache.set(w.window_id, w);
      this.pidCache.set(w.pid, w);
      if (w.bundle_id && w.app_name) {
        this.appBundleCache.set(w.app_name.toLowerCase(), w.bundle_id);
      }
    }
    logger.debug(`Updated window cache: ${windows.length} windows`);
  }

  getWindowInfo(windowId: number): WindowInfo | undefined {
    return this.windowCache.get(windowId);
  }

  invalidatePid(pid: number): void {
    const cached = this.pidCache.get(pid);
    if (cached) {
      this.windowCache.delete(cached.window_id);
    }
    this.pidCache.delete(pid);
    pidBundleIdCache.delete(pid);
    logger.debug(`Invalidated window cache for pid ${pid}`);
  }

  invalidateWindow(windowId: number): void {
    const cached = this.windowCache.get(windowId);
    if (cached) {
      this.pidCache.delete(cached.pid);
      pidBundleIdCache.delete(cached.pid);
    }
    this.windowCache.delete(windowId);
    logger.debug(`Invalidated window cache for window ${windowId}`);
  }

  clearWindowCache(): void {
    this.windowCache.clear();
    this.pidCache.clear();
    this.appBundleCache.clear();
    pidBundleIdCache.clear();
    logger.debug('Cleared all window and process caches');
  }

  /**
   * Main policy enforcement check before executing any tool.
   */
  async enforce(toolName: string, args: Record<string, unknown> = {}): Promise<PolicyCheckResult> {
    // 1. Tool Profile Check
    if (!isToolAllowedInProfile(toolName, this.config.toolProfile)) {
      return {
        allowed: false,
        code: 'TOOL_NOT_ALLOWED',
        reason: `Tool '${toolName}' is not allowed in '${this.config.toolProfile}' tool profile.`,
      };
    }

    // 2. Kill-switch check (STOP file on the fly)
    if (fs.existsSync(this.stopFilePath)) {
      logger.warn(`Kill-switch active: file exists at ${this.stopFilePath}`);
      return {
        allowed: false,
        code: 'STOPPED',
        reason: `Execution halted by kill-switch (${this.stopFilePath} exists).`,
      };
    }

    // 3. Action Limit Check
    if (this.actionCount >= this.config.maxActionsPerSession) {
      logger.warn(`Action limit reached: ${this.actionCount}/${this.config.maxActionsPerSession}`);
      return {
        allowed: false,
        code: 'ACTION_LIMIT_EXCEEDED',
        reason: `Session action limit (${this.config.maxActionsPerSession}) exceeded.`,
      };
    }

    // 4. Foreground Delivery Mode Check
    const deliveryMode = args.delivery_mode as string | undefined;
    if (deliveryMode === 'foreground' && !this.config.allowForeground) {
      return {
        allowed: false,
        code: 'FOREGROUND_NOT_ALLOWED',
        reason: "Foreground window activation ('delivery_mode: foreground') is disallowed by policy.",
      };
    }

    // 5. Inspection tools bypass application resolution
    if (INSPECTION_TOOLS.has(toolName)) {
      return { allowed: true };
    }

    // 6. Cross-check pid and window_id to prevent mismatch attacks
    const argPid = typeof args.pid === 'number' ? args.pid : undefined;
    const argWindowId = typeof args.window_id === 'number' ? args.window_id : undefined;

    if (argPid !== undefined && argWindowId !== undefined) {
      const win = this.windowCache.get(argWindowId);
      if (win && win.pid !== argPid) {
        logger.warn(
          `Target mismatch: window_id ${argWindowId} belongs to PID ${win.pid} ('${win.app_name}'), but call specified PID ${argPid}`
        );
        return {
          allowed: false,
          code: 'TARGET_MISMATCH',
          reason: `Target mismatch: window_id ${argWindowId} belongs to PID ${win.pid} ('${win.app_name}'), but tool call specified PID ${argPid}.`,
        };
      }
    }

    // 7. Application Resolution and Allowlist/Denylist Check
    const target = this.resolveTargetApp(toolName, args);

    if (!target) {
      // Fail-Closed: Action tool with unresolved target app is forbidden
      return {
        allowed: false,
        code: 'APP_UNKNOWN',
        reason: `Could not identify target application for tool '${toolName}'. Fail-Closed policy active. Hint: Call list_windows first to detect active windows and populate the cache.`,
      };
    }

    const { bundleId, appName } = target;

    // Check Denied Apps first (Deny takes precedence over Allow; matching by bundle ID only)
    if (this.isAppInList(bundleId, this.config.deniedApps)) {
      return {
        allowed: false,
        code: 'APP_DENIED',
        targetBundleId: bundleId,
        reason: `Target application '${appName}' (${bundleId}) is in the denied applications list.`,
      };
    }

    // Check Allowed Apps (Strict bundle ID verification or explicit allowAnyApp: true)
    const isAllowed =
      this.config.allowAnyApp === true || this.isAppInList(bundleId, this.config.allowedApps);
    if (!isAllowed) {
      return {
        allowed: false,
        code: 'APP_NOT_ALLOWED',
        targetBundleId: bundleId,
        reason: `Target application '${appName}' (${bundleId}) is NOT in the allowed applications list.`,
      };
    }

    // Action approved: increment counter
    this.actionCount++;
    return {
      allowed: true,
      targetBundleId: bundleId,
    };
  }

  /**
   * Resolves target application identifier from call arguments and window cache.
   */
  private resolveTargetApp(
    toolName: string,
    args: Record<string, unknown>
  ): { bundleId: string; appName: string } | null {
    // If tool is launch_app: inspect bundle_id or name argument directly
    if (toolName === 'launch_app') {
      const bundleId = (args.bundle_id as string) || '';
      const name = (args.name as string) || '';
      if (bundleId && BUNDLE_ID_REGEX.test(bundleId)) {
        return { bundleId, appName: name || bundleId };
      }
      if (name) {
        const cachedBundle = this.appBundleCache.get(name.toLowerCase());
        if (cachedBundle && BUNDLE_ID_REGEX.test(cachedBundle)) {
          return { bundleId: cachedBundle, appName: name };
        }
      }
      return null;
    }

    // Resolve by window_id
    const windowId = typeof args.window_id === 'number' ? args.window_id : undefined;
    if (windowId !== undefined && this.windowCache.has(windowId)) {
      const win = this.windowCache.get(windowId)!;
      let bundleId = win.bundle_id || this.appBundleCache.get(win.app_name.toLowerCase());
      if (!bundleId && typeof win.pid === 'number') {
        bundleId = getBundleIdForPid(win.pid);
        if (bundleId) win.bundle_id = bundleId;
      }
      if (bundleId) {
        return { bundleId, appName: win.app_name };
      }
      return null;
    }

    // Resolve by pid
    const pid = typeof args.pid === 'number' ? args.pid : undefined;
    if (pid !== undefined) {
      if (this.pidCache.has(pid)) {
        const win = this.pidCache.get(pid)!;
        let bundleId = win.bundle_id || this.appBundleCache.get(win.app_name.toLowerCase());
        if (!bundleId) {
          bundleId = getBundleIdForPid(pid);
          if (bundleId) win.bundle_id = bundleId;
        }
        if (bundleId) {
          return { bundleId, appName: win.app_name };
        }
        return null;
      }
      const resolved = getBundleIdForPid(pid);
      if (resolved) {
        return { bundleId: resolved, appName: resolved };
      }
    }

    // Try target object if provided: target: { pid, window_id }
    if (typeof args.target === 'object' && args.target !== null) {
      const targetObj = args.target as Record<string, unknown>;
      const tWindowId = typeof targetObj.window_id === 'number' ? targetObj.window_id : undefined;
      if (tWindowId !== undefined && this.windowCache.has(tWindowId)) {
        const win = this.windowCache.get(tWindowId)!;
        let bundleId = win.bundle_id || this.appBundleCache.get(win.app_name.toLowerCase());
        if (!bundleId && typeof win.pid === 'number') {
          bundleId = getBundleIdForPid(win.pid);
          if (bundleId) win.bundle_id = bundleId;
        }
        if (bundleId) {
          return { bundleId, appName: win.app_name };
        }
        return null;
      }
      const tPid = typeof targetObj.pid === 'number' ? targetObj.pid : undefined;
      if (tPid !== undefined) {
        if (this.pidCache.has(tPid)) {
          const win = this.pidCache.get(tPid)!;
          let bundleId = win.bundle_id || this.appBundleCache.get(win.app_name.toLowerCase());
          if (!bundleId) {
            bundleId = getBundleIdForPid(tPid);
            if (bundleId) win.bundle_id = bundleId;
          }
          if (bundleId) {
            return { bundleId, appName: win.app_name };
          }
          return null;
        }
        const resolved = getBundleIdForPid(tPid);
        if (resolved) {
          return { bundleId: resolved, appName: resolved };
        }
      }
    }

    return null;
  }

  /**
   * Checks whether bundleId matches any entry in list (exact case-insensitive bundle ID match only).
   */
  private isAppInList(bundleId: string, list: string[]): boolean {
    const bLower = bundleId.toLowerCase();
    for (const item of list) {
      if (item.toLowerCase() === bLower) {
        return true;
      }
    }
    return false;
  }
}
