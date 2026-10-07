import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultPolicyPath, PolicyConfigSchema } from '../policy/schema.js';

export type SupportedClient = 'antigravity' | 'claude-code' | 'codex';

export interface InstallOptions {
  client: SupportedClient;
  write?: boolean;
  profile?: 'minimal' | 'full';
  customConfigPath?: string;
  policyConfigPath?: string;
}

export interface InstallResult {
  success: boolean;
  client: SupportedClient;
  configPath: string;
  backupPath?: string;
  serverEntry: {
    command: string;
    args: string[];
  };
  dryRun: boolean;
  message: string;
}

export function resolveClientConfigPath(client: SupportedClient): string {
  const home = os.homedir();
  switch (client) {
    case 'antigravity':
      return path.join(home, '.gemini', 'config', 'mcp_config.json');
    case 'claude-code': {
      const claudeDir = path.join(home, '.claude', 'mcp_config.json');
      const claudeDot = path.join(home, '.claude.json');
      if (fs.existsSync(claudeDot) && !fs.existsSync(claudeDir)) {
        return claudeDot;
      }
      return claudeDir;
    }
    case 'codex':
      return path.join(home, '.codex', 'mcp_config.json');
    default:
      throw new Error(`Unsupported client: ${client}`);
  }
}

export function getProxyIndexPath(): string {
  // Resolves the absolute path to dist/index.js relative to this compiled file
  const currentFile = fileURLToPath(import.meta.url);
  const cliDir = path.dirname(currentFile);
  // In dist: dist/src/cli/install.js or dist/cli/install.js -> dist/index.js
  const potentialPaths = [
    path.resolve(cliDir, '../index.js'),
    path.resolve(cliDir, '../../index.js'),
    path.resolve(cliDir, 'index.js'),
  ];

  for (const p of potentialPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return potentialPaths[0];
}

export function runInstall(options: InstallOptions): InstallResult {
  const { client, write = false } = options;
  const configPath = options.customConfigPath ?? resolveClientConfigPath(client);
  const serverPath = getProxyIndexPath();

  const serverEntry = {
    command: 'node',
    args: [serverPath],
  };

  if (!write) {
    // Dry-run mode
    const previewConfig = {
      mcpServers: {
        'agent-computer-use': serverEntry,
      },
    };

    return {
      success: true,
      client,
      configPath,
      serverEntry,
      dryRun: true,
      message: [
        `[DRY RUN] Would install 'agent-computer-use' into ${configPath}`,
        'Generated MCP server configuration:',
        JSON.stringify(serverEntry, null, 2),
        '',
        'Target configuration preview:',
        JSON.stringify(previewConfig, null, 2),
        '',
        `To write changes to disk and create a backup, re-run with: acu install --client ${client} --write`,
      ].join('\n'),
    };
  }

  // Write mode
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  let existingJson: Record<string, any> = {};
  let backupPath: string | undefined;

  if (fs.existsSync(configPath)) {
    // Create backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${configPath}.bak.${timestamp}`;
    fs.copyFileSync(configPath, backupPath);

    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      existingJson = JSON.parse(raw);
    } catch {
      existingJson = {};
    }
  }

  // Ensure mcpServers exists and add agent-computer-use key
  if (!existingJson.mcpServers || typeof existingJson.mcpServers !== 'object') {
    existingJson.mcpServers = {};
  }

  existingJson.mcpServers['agent-computer-use'] = serverEntry;

  fs.writeFileSync(configPath, JSON.stringify(existingJson, null, 2), 'utf8');

  // If profile specified, update or create policy.json accordingly
  if (options.profile) {
    try {
      const policyPath = options.policyConfigPath ?? getDefaultPolicyPath();
      const policyDir = path.dirname(policyPath);
      if (!fs.existsSync(policyDir)) {
        fs.mkdirSync(policyDir, { recursive: true });
      }
      let existingPolicy: any = {};
      if (fs.existsSync(policyPath)) {
        try {
          existingPolicy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
        } catch {
          existingPolicy = {};
        }
      }
      existingPolicy.toolProfile = options.profile;
      const validated = PolicyConfigSchema.parse(existingPolicy);
      fs.writeFileSync(policyPath, JSON.stringify(validated, null, 2), 'utf8');
    } catch {
      // non-fatal
    }
  }

  return {
    success: true,
    client,
    configPath,
    backupPath,
    serverEntry,
    dryRun: false,
    message: [
      `[SUCCESS] Successfully installed 'agent-computer-use' for ${client}!`,
      `- Config file: ${configPath}`,
      backupPath ? `- Backup created: ${backupPath}` : '- New config file initialized',
      '- Server entry registered in mcpServers["agent-computer-use"]',
    ].join('\n'),
  };
}
