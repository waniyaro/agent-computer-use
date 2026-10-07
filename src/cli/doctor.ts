import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { resolveDefaultCuaDriverCommand } from '../backend/cua-driver.js';
import {
  getDefaultPolicyPath,
  getStopFilePath,
  loadPolicyConfig,
} from '../policy/schema.js';

export type CheckStatus = 'OK' | 'WARN' | 'FAIL';

export interface DoctorCheckResult {
  category: string;
  name: string;
  status: CheckStatus;
  message: string;
  fixHint?: string;
}

export interface DoctorReport {
  timestamp: string;
  checks: DoctorCheckResult[];
  overallStatus: CheckStatus;
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheckResult[] = [];

  // 1. macOS Environment
  const isDarwin = os.platform() === 'darwin';
  let osVersionStr = `Darwin ${os.release()} (${process.arch})`;
  if (isDarwin) {
    try {
      const swVers = execSync('sw_vers -productVersion', { encoding: 'utf8' }).trim();
      const buildVers = execSync('sw_vers -buildVersion', { encoding: 'utf8' }).trim();
      osVersionStr = `macOS ${swVers} (${buildVers}) - ${process.arch}`;
    } catch {
      // fallback to os.release()
    }
  }

  checks.push({
    category: '1. macOS Environment',
    name: 'Operating System',
    status: isDarwin ? 'OK' : 'FAIL',
    message: osVersionStr,
    fixHint: isDarwin ? undefined : 'agent-computer-use requires macOS (Darwin) for Cua Driver.',
  });

  // 2. Cua Driver Binary
  const driverCmd = resolveDefaultCuaDriverCommand();
  let driverVersion = '';
  let driverAvailable = false;

  try {
    driverVersion = execSync(`"${driverCmd}" --version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    driverAvailable = true;
  } catch (err) {
    driverAvailable = false;
  }

  checks.push({
    category: '2. Cua Driver',
    name: 'Binary executable',
    status: driverAvailable ? 'OK' : 'FAIL',
    message: driverAvailable ? `${driverCmd} (${driverVersion})` : `Binary not found at '${driverCmd}'`,
    fixHint: driverAvailable
      ? undefined
      : 'Install Cua Driver: /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"',
  });

  // 3. Permissions Status
  let permOk = false;
  let permMessage = '';
  let permHint: string | undefined;

  if (driverAvailable) {
    try {
      const permOut = execSync(`"${driverCmd}" permissions status`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const hasAccessibility = permOut.includes('Accessibility:') && permOut.includes('granted');
      const hasScreen = permOut.includes('Screen Recording:') && permOut.includes('granted');

      if (hasAccessibility && hasScreen) {
        permOk = true;
        permMessage = 'Accessibility: granted, Screen Recording: granted';
      } else {
        permOk = false;
        permMessage = permOut.trim().split('\n').slice(0, 2).join('; ');
        permHint = 'Grant permissions in System Settings -> Privacy & Security -> Accessibility & Screen Recording.';
      }
    } catch (err) {
      permMessage = 'Unable to query permissions status (daemon not running)';
      permHint = 'Run `open -a CuaDriver --args serve` and grant permissions.';
    }
  } else {
    permMessage = 'Skipped (driver binary not available)';
  }

  checks.push({
    category: '3. macOS Permissions',
    name: 'TCC Grants (Accessibility & Screen Recording)',
    status: permOk ? 'OK' : 'WARN',
    message: permMessage,
    fixHint: permHint,
  });

  // 4. Policy Configuration
  const policyPath = getDefaultPolicyPath();
  let policyStatus: CheckStatus = 'OK';
  let policyMsg = '';
  let policyHint: string | undefined;

  if (!fs.existsSync(policyPath)) {
    policyStatus = 'WARN';
    policyMsg = `Config not found at ${policyPath} (will be auto-created on first run)`;
    policyHint = `Create default config by running: acu install --client antigravity --write`;
  } else {
    try {
      const cfg = loadPolicyConfig(policyPath);
      policyMsg = `Valid: toolProfile='${cfg.toolProfile}', allowedApps=${cfg.allowedApps.length}, deniedApps=${cfg.deniedApps.length}`;
      policyStatus = 'OK';
    } catch (err) {
      policyStatus = 'FAIL';
      policyMsg = err instanceof Error ? err.message : String(err);
      policyHint = `Fix errors in ${policyPath} according to the Zod schema.`;
    }
  }

  checks.push({
    category: '4. Policy Configuration',
    name: 'policy.json validation',
    status: policyStatus,
    message: policyMsg,
    fixHint: policyHint,
  });

  // 5. Kill-Switch Status
  const stopPath = getStopFilePath();
  const stopExists = fs.existsSync(stopPath);

  checks.push({
    category: '5. Kill-Switch Status',
    name: 'Emergency STOP file',
    status: stopExists ? 'WARN' : 'OK',
    message: stopExists ? `ACTIVE: ${stopPath} exists! All tool actions are blocked.` : 'Inactive (normal operation)',
    fixHint: stopExists ? `To resume execution, remove the STOP file: rm "${stopPath}"` : undefined,
  });

  // 6. Client Configs
  const home = os.homedir();
  const clients = [
    {
      id: 'antigravity',
      name: 'Antigravity IDE',
      paths: [path.join(home, '.gemini', 'config', 'mcp_config.json')],
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      paths: [path.join(home, '.claude', 'mcp_config.json'), path.join(home, '.claude.json')],
    },
    {
      id: 'codex',
      name: 'Codex',
      paths: [path.join(home, '.codex', 'mcp_config.json')],
    },
  ];

  for (const client of clients) {
    const existingPath = client.paths.find((p) => fs.existsSync(p));
    let clientStatus: CheckStatus = 'WARN';
    let clientMsg = '';
    let clientHint: string | undefined;

    if (existingPath) {
      try {
        const raw = fs.readFileSync(existingPath, 'utf8');
        const json = JSON.parse(raw);
        const hasAcu = json.mcpServers && json.mcpServers['agent-computer-use'];
        if (hasAcu) {
          clientStatus = 'OK';
          clientMsg = `Configured in ${existingPath}`;
        } else {
          clientStatus = 'WARN';
          clientMsg = `Found ${existingPath}, but 'agent-computer-use' is not configured`;
          clientHint = `Run 'acu install --client ${client.id} --write'`;
        }
      } catch {
        clientStatus = 'WARN';
        clientMsg = `Found ${existingPath}, but JSON is invalid`;
      }
    } else {
      clientStatus = 'OK';
      clientMsg = `Not installed (optional)`;
    }

    checks.push({
      category: '6. Client Integrations',
      name: client.name,
      status: clientStatus,
      message: clientMsg,
      fixHint: clientHint,
    });
  }

  // Calculate overall status
  let overall: CheckStatus = 'OK';
  if (checks.some((c) => c.status === 'FAIL')) {
    overall = 'FAIL';
  } else if (checks.some((c) => c.status === 'WARN')) {
    overall = 'WARN';
  }

  return {
    timestamp: new Date().toISOString(),
    checks,
    overallStatus: overall,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('======================================================');
  lines.push('           agent-computer-use Doctor Report           ');
  lines.push('======================================================\n');

  let currentCategory = '';
  for (const check of report.checks) {
    if (check.category !== currentCategory) {
      currentCategory = check.category;
      lines.push(`--- ${currentCategory} ---`);
    }

    const badge =
      check.status === 'OK'
        ? '[OK]  '
        : check.status === 'WARN'
        ? '[WARN]'
        : '[FAIL]';

    lines.push(`  ${badge} ${check.name}: ${check.message}`);
    if (check.fixHint) {
      lines.push(`         👉 Fix: ${check.fixHint}`);
    }
  }

  lines.push('\n------------------------------------------------------');
  lines.push(`Overall Status: [${report.overallStatus}]`);
  lines.push('======================================================');

  return lines.join('\n');
}
