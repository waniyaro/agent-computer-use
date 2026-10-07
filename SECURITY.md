# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Reporting a Vulnerability

Security is a foundational tenet of `agent-computer-use`. If you discover a vulnerability or security bypass, please help us keep users safe by reporting it responsibly.

**Please DO NOT report security vulnerabilities via public GitHub issues.**

Instead, please send an email to the project maintainer:
- **Email:** `shkeva2005@gmail.com`

Please include:
- A description of the vulnerability and its potential impact.
- Steps to reproduce or a minimal proof of concept (PoC).
- Your suggested remediation, if any.

You will receive an initial response within 48 hours acknowledging receipt of your report.

## Security Guarantees & Non-Goals

### Guarantees
- **Fail-Closed by Default**: An empty `allowedApps` list blocks all GUI interaction.
- **Strict Blacklisting**: Password managers, Keychain, System Settings, and Terminal are blocked unconditionally.
- **Immediate Kill-Switch**: The presence of `~/.config/agent-computer-use/STOP` takes effect immediately on every invocation without restarting processes.
- **Audit Masking**: Plaintext from `type_text` is omitted from logs by default (`logTypedText: false`), and screenshots are never persisted in the audit log.

### Advisory on Visual Prompt Injections
Content rendered inside third-party application windows is considered untrusted data. While `agent-computer-use` enforces process boundaries and interaction limits, agents must follow the guidance in `SKILL.md` to avoid executing instructions visually embedded in target windows.
