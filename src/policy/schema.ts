import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { PolicyConfig } from './types.js';

export const DEFAULT_DENIED_APPS = [
  'com.1password.1password',
  'com.agilebits.onepassword7',
  'com.bitwarden.desktop',
  'com.apple.keychainaccess',
  'com.apple.Passwords',
  'com.apple.systempreferences',
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'com.apple.ScriptEditor2',
];

export const PolicyConfigSchema = z.object({
  allowedApps: z.array(z.string()).default([]),
  deniedApps: z.array(z.string()).default(DEFAULT_DENIED_APPS),
  maxActionsPerSession: z.number().int().positive().default(200),
  toolProfile: z.enum(['minimal', 'full']).default('minimal'),
  allowForeground: z.boolean().default(false),
  logTypedText: z.boolean().default(false),
  autoRelaunch: z.boolean().default(false),
  allowAnyApp: z.boolean().default(false),
});

export function getConfigDir(): string {
  if (process.env.AGENT_CONFIG_DIR) {
    return process.env.AGENT_CONFIG_DIR;
  }
  return path.join(os.homedir(), '.config', 'agent-computer-use');
}

export function getDefaultPolicyPath(): string {
  return path.join(getConfigDir(), 'policy.json');
}

export function getStopFilePath(): string {
  return path.join(getConfigDir(), 'STOP');
}

export function getAuditLogPath(): string {
  return path.join(getConfigDir(), 'audit.log');
}

export function loadPolicyConfig(filePath?: string): PolicyConfig {
  const configPath = filePath ?? getDefaultPolicyPath();
  const configDir = path.dirname(configPath);

  if (!fs.existsSync(configPath)) {
    // Ensure parent directory exists
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Generate and write default config
    const defaultConfig = PolicyConfigSchema.parse({});
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
    return defaultConfig;
  }

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read policy configuration file at ${configPath}: ${err}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(`Invalid JSON syntax in policy configuration at ${configPath}: ${err}`);
  }

  const result = PolicyConfigSchema.safeParse(parsedJson);
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((e) => `  - [${e.path.join('.') || 'root'}]: ${e.message}`)
      .join('\n');
    throw new Error(`Policy configuration validation failed for ${configPath}:\n${errorDetails}`);
  }

  return result.data;
}
