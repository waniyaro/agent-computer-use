export type ToolProfile = 'minimal' | 'full';

export interface PolicyConfig {
  allowedApps: string[];
  deniedApps: string[];
  maxActionsPerSession: number;
  toolProfile: ToolProfile;
  allowForeground: boolean;
  logTypedText: boolean;
  autoRelaunch: boolean;
  allowAnyApp?: boolean;
}

export type PolicyErrorCode =
  | 'STOPPED'
  | 'ACTION_LIMIT_EXCEEDED'
  | 'APP_DENIED'
  | 'APP_NOT_ALLOWED'
  | 'APP_UNKNOWN'
  | 'TARGET_MISMATCH'
  | 'FOREGROUND_NOT_ALLOWED'
  | 'TOOL_NOT_ALLOWED';

export interface PolicyCheckResult {
  allowed: boolean;
  code?: PolicyErrorCode;
  reason?: string;
  targetBundleId?: string;
}

export interface WindowInfo {
  pid: number;
  window_id: number;
  app_name: string;
  title?: string;
  bundle_id?: string;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}
