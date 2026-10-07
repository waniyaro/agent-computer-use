import fs from 'node:fs';
import { PolicyConfig, PolicyCheckResult, WindowInfo } from './types.js';
import { getStopFilePath } from './schema.js';
import { isToolAllowedInProfile } from './filter.js';
import { logger } from '../utils/logger.js';

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
      this.windowCache.set(w.window_id, w);
      this.pidCache.set(w.pid, w);
      if (w.bundle_id && w.app_name) {
        this.appBundleCache.set(w.app_name.toLowerCase(), w.bundle_id);
      }
    }
    logger.debug(`Updated window cache: ${windows.length} windows`);
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

    // 6. Application Resolution and Allowlist/Denylist Check
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

    // Check Denied Apps first (Deny takes precedence over Allow)
    if (this.isAppInList(bundleId, appName, this.config.deniedApps)) {
      return {
        allowed: false,
        code: 'APP_DENIED',
        targetBundleId: bundleId,
        reason: `Target application '${appName}' (${bundleId}) is in the denied applications list.`,
      };
    }

    // Check Allowed Apps
    if (!this.isAppInList(bundleId, appName, this.config.allowedApps)) {
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
      if (bundleId) {
        return { bundleId, appName: name || bundleId };
      }
      if (name) {
        const cachedBundle = this.appBundleCache.get(name.toLowerCase()) || name;
        return { bundleId: cachedBundle, appName: name };
      }
      return null;
    }

    // Resolve by window_id
    const windowId = typeof args.window_id === 'number' ? args.window_id : undefined;
    if (windowId !== undefined && this.windowCache.has(windowId)) {
      const win = this.windowCache.get(windowId)!;
      return {
        bundleId: win.bundle_id || this.appBundleCache.get(win.app_name.toLowerCase()) || win.app_name,
        appName: win.app_name,
      };
    }

    // Resolve by pid
    const pid = typeof args.pid === 'number' ? args.pid : undefined;
    if (pid !== undefined && this.pidCache.has(pid)) {
      const win = this.pidCache.get(pid)!;
      return {
        bundleId: win.bundle_id || this.appBundleCache.get(win.app_name.toLowerCase()) || win.app_name,
        appName: win.app_name,
      };
    }

    // Try target object if provided: target: { pid, window_id }
    if (typeof args.target === 'object' && args.target !== null) {
      const targetObj = args.target as Record<string, unknown>;
      const tWindowId = typeof targetObj.window_id === 'number' ? targetObj.window_id : undefined;
      if (tWindowId !== undefined && this.windowCache.has(tWindowId)) {
        const win = this.windowCache.get(tWindowId)!;
        return {
          bundleId: win.bundle_id || this.appBundleCache.get(win.app_name.toLowerCase()) || win.app_name,
          appName: win.app_name,
        };
      }
      const tPid = typeof targetObj.pid === 'number' ? targetObj.pid : undefined;
      if (tPid !== undefined && this.pidCache.has(tPid)) {
        const win = this.pidCache.get(tPid)!;
        return {
          bundleId: win.bundle_id || this.appBundleCache.get(win.app_name.toLowerCase()) || win.app_name,
          appName: win.app_name,
        };
      }
    }

    return null;
  }

  /**
   * Checks whether bundleId or appName matches any entry in list (supports exact & case-insensitive matching).
   */
  private isAppInList(bundleId: string, appName: string, list: string[]): boolean {
    if (list.includes('*')) {
      return true;
    }

    const bLower = bundleId.toLowerCase();
    const aLower = appName.toLowerCase();

    for (const item of list) {
      const iLower = item.toLowerCase();
      if (iLower === bLower || iLower === aLower) {
        return true;
      }
    }

    return false;
  }
}
