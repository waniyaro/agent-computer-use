import { CuaDriverBackend } from '../backend/cua-driver.js';
import { PolicyEnforcer } from '../policy/enforcer.js';
import { WindowInfo } from '../policy/types.js';
import { logger } from '../utils/logger.js';

export interface EnsureAppRunningParams {
  bundle_id: string;
  name?: string;
  timeout_ms?: number;
}

export interface EnsureAppRunningResult {
  status: 'running';
  pid: number;
  window_id: number;
  bundle_id: string;
  requires_new_state: true;
  message: string;
}

const APP_CRASH_PATTERNS = [
  /process not found/i,
  /window does not exist/i,
  /invalid pid/i,
  /NoSuchWindow/i,
  /stale window/i,
  /target terminated/i,
  /no such process/i,
  /no window with id/i,
  /not running/i,
  /dead process/i,
  /application crashed/i,
];

export function isAppCrashError(message: string): boolean {
  return APP_CRASH_PATTERNS.some((pattern) => pattern.test(message));
}

export class AppRecoveryManager {
  private backend: CuaDriverBackend;
  private enforcer: PolicyEnforcer;

  constructor(backend: CuaDriverBackend, enforcer: PolicyEnforcer) {
    this.backend = backend;
    this.enforcer = enforcer;
  }

  /**
   * Ensures the target application is running. If not, launches it and polls for its window.
   */
  async ensureAppRunning(params: EnsureAppRunningParams): Promise<EnsureAppRunningResult> {
    const { bundle_id, name } = params;

    // Validate bundle_id format strictly against injection
    const BUNDLE_ID_REGEX = /^[A-Za-z0-9_.-]+$/;
    if (!bundle_id || !BUNDLE_ID_REGEX.test(bundle_id)) {
      throw new Error(`Invalid bundle identifier format: '${bundle_id}'`);
    }

    // 1. Policy check: must be allowed by enforcer
    const check = await this.enforcer.enforce('launch_app', {
      bundle_id,
      name,
    });

    if (!check.allowed) {
      throw new Error(`Policy Violation (${check.code}): ${check.reason}`);
    }

    logger.info(`Ensuring application is running: bundle_id=${bundle_id}, name=${name ?? ''}`);

    // 2. Check if already running in list_windows
    const initialWindows = await this.fetchWindows();
    const existingWindow = this.findWindow(initialWindows, bundle_id, name);

    if (existingWindow) {
      logger.info(
        `Application ${bundle_id} is already running (pid=${existingWindow.pid}, window_id=${existingWindow.window_id})`
      );
      return {
        status: 'running',
        pid: existingWindow.pid,
        window_id: existingWindow.window_id,
        bundle_id,
        requires_new_state: true,
        message:
          'Application is running. You MUST call get_window_state before performing any further action.',
      };
    }

    // 3. Not running: launch via launch_app
    logger.info(`Application ${bundle_id} not running, launching...`);
    const launchArgs: Record<string, unknown> = { bundle_id };
    if (name) {
      launchArgs.name = name;
    }

    await this.backend.callTool('launch_app', launchArgs);

    // 4. Poll list_windows with up to timeoutMs (default 5s)
    const startTime = Date.now();
    const timeoutMs = params.timeout_ms ?? 5000;
    const pollIntervalMs = 300;

    while (Date.now() - startTime < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const windows = await this.fetchWindows();
      const win = this.findWindow(windows, bundle_id, name);

      if (win) {
        logger.info(
          `Application ${bundle_id} successfully launched (pid=${win.pid}, window_id=${win.window_id})`
        );
        this.enforcer.updateWindowCache(windows);
        return {
          status: 'running',
          pid: win.pid,
          window_id: win.window_id,
          bundle_id,
          requires_new_state: true,
          message:
            'Application is running. You MUST call get_window_state before performing any further action.',
        };
      }
    }

    throw new Error(
      `Timed out waiting for window of application '${bundle_id}' (${name ?? ''}) to appear after 5 seconds.`
    );
  }

  private async fetchWindows(): Promise<WindowInfo[]> {
    try {
      const res = await this.backend.callTool('list_windows', {});
      const sc = res.structuredContent as Record<string, unknown> | undefined;
      if (sc && Array.isArray(sc.windows)) {
        const windows = sc.windows as WindowInfo[];
        this.enforcer.updateWindowCache(windows);
        return windows;
      }
    } catch (err) {
      logger.warn('Failed to fetch windows in AppRecoveryManager:', err);
    }
    return [];
  }

  private findWindow(
    windows: WindowInfo[],
    bundleId: string,
    name?: string
  ): WindowInfo | undefined {
    const bLower = bundleId.toLowerCase();
    const nLower = name?.toLowerCase();

    return windows.find((w) => {
      const wBundle = w.bundle_id?.toLowerCase();
      const wApp = w.app_name?.toLowerCase();

      if (wBundle && wBundle === bLower) return true;
      if (wApp && (wApp === bLower || (nLower && wApp === nLower))) return true;
      return false;
    });
  }
}
