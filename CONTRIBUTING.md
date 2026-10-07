# Contributing to agent-computer-use

First off, thank you for considering contributing to `agent-computer-use`! Open-source tools for AI agent reliability and desktop automation thrive on community contributions.

## Development Setup

### Prerequisites
- macOS 13+ (Ventura, Sonoma, Sequoia or newer)
- Node.js 20+ (Node.js 22 LTS recommended)
- [Cua Driver](https://github.com/trycua/cua):
  ```bash
  /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
  ```

### Getting Started
1. Fork and clone the repository:
   ```bash
   git clone https://github.com/waniyaro/agent-computer-use.git
   cd agent-computer-use
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the project:
   ```bash
   npm run build
   ```
4. Run tests:
   ```bash
   npm test
   ```

## Pull Request Guidelines

1. **Keep it tested**: Ensure all tests pass (`npm test`) and add unit tests for any new features or bug fixes.
2. **Follow Fail-Closed principle**: Security guardrails and policies MUST always fail closed. If target resolution or validation cannot guarantee safety, actions must be rejected.
3. **No stdout pollution**: The proxy communicates over `stdio` via JSON-RPC. NEVER write debug logs or info text to `process.stdout`. All logs MUST go to `process.stderr` via `logger`.
4. **Clean commits**: Write concise, conventional commit messages (`feat: ...`, `fix: ...`, `docs: ...`, `test: ...`).

## Code Architecture

- `src/server.ts`: External MCP server endpoint and request routing.
- `src/backend/cua-driver.ts`: Child-process driver manager, resilience & auto-restart.
- `src/policy/`: Policy enforcer, Zod schemas, minimal/full tool profiling, kill-switch.
- `src/audit/`: Structured JSONL audit logging with data sanitization and size rotation.
- `src/journal/`: Task journal storage and context retrieval across agent sessions.
- `src/recovery/`: Target application crash detection and self-healing.
- `src/cli/`: `acu doctor` diagnostic suite and `acu install` configuration installer.
- `skills/`: Agent behavior playbooks and operational guidelines (`SKILL.md`).

Thank you for helping build a safer desktop automation layer for AI agents!
