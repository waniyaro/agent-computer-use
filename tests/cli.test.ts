import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDoctor, formatDoctorReport } from '../src/cli/doctor.js';
import {
  runInstall,
  resolveClientConfigPath,
  getProxyIndexPath,
  SupportedClient,
} from '../src/cli/install.js';

describe('CLI - Doctor and Install Tests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acu-cli-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('acu doctor', () => {
    it('runs all diagnostic checks and formats report correctly', async () => {
      const report = await runDoctor();

      expect(report).toBeDefined();
      expect(report.timestamp).toBeTruthy();
      expect(['OK', 'WARN', 'FAIL']).toContain(report.overallStatus);
      expect(report.checks.length).toBeGreaterThanOrEqual(6);

      const categories = report.checks.map((c) => c.category);
      expect(categories).toContain('1. macOS Environment');
      expect(categories).toContain('2. Cua Driver');
      expect(categories).toContain('3. macOS Permissions');
      expect(categories).toContain('4. Policy Configuration');
      expect(categories).toContain('5. Kill-Switch Status');
      expect(categories).toContain('6. Client Integrations');

      // Check formatting
      const formatted = formatDoctorReport(report);
      expect(formatted).toContain('agent-computer-use Doctor Report');
      expect(formatted).toContain(`Overall Status: [${report.overallStatus}]`);
      expect(formatted).toMatch(/\[(OK|WARN|FAIL)\]/);
    });

    it('reports OK for emergency STOP file when it is absent', async () => {
      const report = await runDoctor();
      const stopCheck = report.checks.find((c) => c.category === '5. Kill-Switch Status');
      expect(stopCheck).toBeDefined();
      // On normal environment STOP file should be inactive
      expect(stopCheck?.status).toBe('OK');
      expect(stopCheck?.message).toContain('Inactive');
    });
  });

  describe('resolveClientConfigPath', () => {
    it('resolves expected paths for supported clients', () => {
      const home = os.homedir();
      expect(resolveClientConfigPath('antigravity')).toBe(
        path.join(home, '.gemini', 'config', 'mcp_config.json')
      );
      expect(resolveClientConfigPath('codex')).toBe(
        path.join(home, '.codex', 'mcp_config.json')
      );

      const claudePath = resolveClientConfigPath('claude-code');
      expect(
        claudePath === path.join(home, '.claude', 'mcp_config.json') ||
        claudePath === path.join(home, '.claude.json')
      ).toBe(true);
    });

    it('throws on unsupported client', () => {
      expect(() => resolveClientConfigPath('unsupported' as SupportedClient)).toThrow(
        /Unsupported client/
      );
    });
  });

  describe('acu install --dry-run', () => {
    it('generates configuration preview without creating files on disk', () => {
      const customConfig = path.join(tmpDir, 'does-not-exist', 'mcp_config.json');

      const result = runInstall({
        client: 'antigravity',
        write: false,
        customConfigPath: customConfig,
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.client).toBe('antigravity');
      expect(result.configPath).toBe(customConfig);
      expect(result.serverEntry.command).toBe('node');
      expect(result.serverEntry.args[0]).toMatch(/index\.(js|ts)$/);
      expect(result.message).toContain('[DRY RUN]');
      expect(result.message).toContain('agent-computer-use');

      // Verify nothing was written
      expect(fs.existsSync(customConfig)).toBe(false);
      expect(fs.existsSync(path.dirname(customConfig))).toBe(false);
    });
  });

  describe('acu install --write', () => {
    it('creates new config file when it does not exist', () => {
      const customConfig = path.join(tmpDir, 'new_dir', 'mcp_config.json');

      const result = runInstall({
        client: 'antigravity',
        write: true,
        customConfigPath: customConfig,
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(false);
      expect(fs.existsSync(customConfig)).toBe(true);
      expect(result.backupPath).toBeUndefined();

      const written = JSON.parse(fs.readFileSync(customConfig, 'utf8'));
      expect(written.mcpServers).toBeDefined();
      expect(written.mcpServers['agent-computer-use']).toBeDefined();
      expect(written.mcpServers['agent-computer-use'].command).toBe('node');
    });

    it('preserves existing servers and creates a backup file when modifying existing config', () => {
      const customConfig = path.join(tmpDir, 'existing_mcp_config.json');
      const existingData = {
        mcpServers: {
          'custom-sql-server': {
            command: 'python3',
            args: ['-m', 'sql_server'],
            env: { DB: 'test' },
          },
          'other-tool': {
            command: 'deno',
            args: ['run', 'main.ts'],
          },
        },
      };

      fs.writeFileSync(customConfig, JSON.stringify(existingData, null, 2), 'utf8');

      const result = runInstall({
        client: 'antigravity',
        write: true,
        customConfigPath: customConfig,
      });

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeDefined();
      expect(fs.existsSync(result.backupPath!)).toBe(true);

      // Verify backup has exact original content
      const backupData = JSON.parse(fs.readFileSync(result.backupPath!, 'utf8'));
      expect(backupData).toEqual(existingData);

      // Verify updated config preserves existing servers AND contains agent-computer-use
      const updatedData = JSON.parse(fs.readFileSync(customConfig, 'utf8'));
      expect(updatedData.mcpServers['custom-sql-server']).toEqual(
        existingData.mcpServers['custom-sql-server']
      );
      expect(updatedData.mcpServers['other-tool']).toEqual(
        existingData.mcpServers['other-tool']
      );
      expect(updatedData.mcpServers['agent-computer-use']).toBeDefined();
      expect(updatedData.mcpServers['agent-computer-use'].command).toBe('node');
      expect(updatedData.mcpServers['agent-computer-use'].args[0]).toMatch(/index\.(js|ts)$/);
    });

    it('updates policy.json toolProfile when profile option is supplied', () => {
      const customConfig = path.join(tmpDir, 'mcp_config.json');
      const customPolicy = path.join(tmpDir, 'policy.json');

      const result = runInstall({
        client: 'antigravity',
        write: true,
        customConfigPath: customConfig,
        policyConfigPath: customPolicy,
        profile: 'full',
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(customPolicy)).toBe(true);

      const policyContent = JSON.parse(fs.readFileSync(customPolicy, 'utf8'));
      expect(policyContent.toolProfile).toBe('full');
    });

    it('refuses to write configuration file for claude-code and outputs claude mcp add instructions', () => {
      const customConfig = path.join(tmpDir, 'claude_config.json');

      const result = runInstall({
        client: 'claude-code',
        write: true,
        customConfigPath: customConfig,
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(fs.existsSync(customConfig)).toBe(false);
      expect(result.message).toContain('claude mcp add agent-computer-use -- node');
      expect(result.message).toContain('claude mcp remove agent-computer-use');
    });
  });

  describe('getProxyIndexPath', () => {
    it('returns an absolute path ending in index.js or index.ts', () => {
      const p = getProxyIndexPath();
      expect(path.isAbsolute(p)).toBe(true);
      expect(p).toMatch(/index\.(js|ts)$/);
    });
  });
});
