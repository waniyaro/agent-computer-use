#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { runDoctor, formatDoctorReport } from '../cli/doctor.js';
import { runInstall, SupportedClient } from '../cli/install.js';
import { runExec } from '../cli/exec.js';

const HELP_TEXT = `
Usage: acu <command> [options]

Commands:
  doctor                     Inspect system environment, permissions, Cua Driver, and configs
  install                    Configure agent-computer-use in an MCP client
  exec                       Execute a tool call directly through the proxy (headless runner)

Options for 'install':
  --client <client>          Target client: antigravity | claude-code | codex (required)
  --write                    Write changes to config and create a backup (default: dry-run)
  --dry-run                  Explicitly run in dry-run mode without modifying files
  --profile <minimal|full>   Security & tool profile (default: minimal)

Options for 'exec':
  --tool <tool_name>         Name of the tool to execute (required)
  --args '<json>'            JSON arguments string for the tool
  --file <path>              Path to JSON file containing arguments

Global Options:
  -h, --help                 Show help message
  -v, --version              Show version information
`;

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        client: { type: 'string' },
        write: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        profile: { type: 'string', default: 'minimal' },
        tool: { type: 'string' },
        args: { type: 'string' },
        file: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
      allowPositionals: true,
      strict: false,
    });
  } catch (err) {
    console.error(`Error parsing arguments: ${err instanceof Error ? err.message : String(err)}`);
    console.log(HELP_TEXT);
    process.exit(1);
  }

  const { values, positionals } = parsed;

  if (values.version) {
    console.log('agent-computer-use CLI (acu) v1.0.0');
    process.exit(0);
  }

  const command = positionals[0];

  if (values.help || !command) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (command === 'doctor') {
    const report = await runDoctor();
    console.log(formatDoctorReport(report));
    if (report.overallStatus === 'FAIL') {
      process.exit(1);
    }
    return;
  }

  if (command === 'install') {
    const client = values.client as string | undefined;
    if (!client) {
      console.error('Error: Missing required option --client <antigravity|claude-code|codex>');
      console.log(HELP_TEXT);
      process.exit(1);
    }

    const validClients: SupportedClient[] = ['antigravity', 'claude-code', 'codex'];
    if (!validClients.includes(client as SupportedClient)) {
      console.error(`Error: Unsupported client '${client}'. Supported: ${validClients.join(', ')}`);
      process.exit(1);
    }

    const profile = values.profile as string;
    if (profile !== 'minimal' && profile !== 'full') {
      console.error(`Error: Invalid profile '${profile}'. Supported: minimal, full`);
      process.exit(1);
    }

    const write = Boolean(values.write) && !values['dry-run'];

    try {
      const result = runInstall({
        client: client as SupportedClient,
        write,
        profile: profile as 'minimal' | 'full',
      });
      console.log(result.message);
      if (!result.success) {
        process.exit(1);
      }
    } catch (err) {
      console.error(`Installation failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'exec') {
    const tool = values.tool as string | undefined;
    if (!tool) {
      console.error('Error: Missing required option --tool <tool_name>');
      console.log(HELP_TEXT);
      process.exit(1);
    }

    let toolArgs: Record<string, unknown> = {};
    if (values.file) {
      try {
        const fileContent = fs.readFileSync(values.file as string, 'utf-8');
        toolArgs = JSON.parse(fileContent);
      } catch (err) {
        console.error(`Error reading args from file '${values.file}': ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    } else if (values.args) {
      try {
        toolArgs = JSON.parse(values.args as string);
      } catch (err) {
        console.error(`Error parsing --args JSON: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }

    try {
      const result = await runExec({ tool, args: toolArgs });
      console.log(JSON.stringify(result, null, 2));
      if (result.isError) {
        process.exit(1);
      }
      return;
    } catch (err) {
      console.error(`Execution failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  console.error(`Unknown command: '${command}'`);
  console.log(HELP_TEXT);
  process.exit(1);
}

main().catch((err) => {
  console.error('Unexpected CLI failure:', err);
  process.exit(1);
});
