import fs from 'node:fs';
import path from 'node:path';
import { getAuditLogPath } from '../policy/schema.js';
import { logger } from '../utils/logger.js';

export interface AuditEntry {
  timestamp: string;
  tool: string;
  target_bundle_id: string | null;
  status: 'ok' | string;
  duration_ms?: number;
  details: Record<string, unknown>;
}

export class AuditLogger {
  private logPath: string;
  private maxSizeBytes: number;

  constructor(customPath?: string, maxSizeBytes = 10 * 1024 * 1024) {
    this.logPath = customPath ?? getAuditLogPath();
    this.maxSizeBytes = maxSizeBytes;
  }

  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Appends an entry to the audit log in JSONL format, performing rotation if needed.
   */
  log(entry: Omit<AuditEntry, 'timestamp'>): void {
    const fullEntry: AuditEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    const sanitizedDetails = this.sanitizeDetails(entry.tool, fullEntry.details);
    fullEntry.details = sanitizedDetails;

    const line = JSON.stringify(fullEntry) + '\n';

    try {
      this.ensureDirAndRotate();
      fs.appendFileSync(this.logPath, line, 'utf8');
    } catch (err) {
      logger.error(`Failed to write to audit log at ${this.logPath}:`, err);
    }
  }

  /**
   * Sanitizes details: strips raw typed text if needed, never logs images or base64.
   */
  private sanitizeDetails(
    toolName: string,
    details: Record<string, unknown>
  ): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(details)) {
      // Never log image/screenshot base64 data
      if (
        key === 'data' ||
        key === 'screenshot' ||
        key === 'image' ||
        key === 'base64' ||
        (typeof val === 'string' && val.length > 500 && /^[A-Za-z0-9+/=]+$/.test(val))
      ) {
        sanitized[key] = '[OMITTED_IMAGE_OR_BINARY]';
        continue;
      }

      if (typeof val === 'object' && val !== null) {
        sanitized[key] = this.sanitizeDetails(toolName, val as Record<string, unknown>);
      } else {
        sanitized[key] = val;
      }
    }

    return sanitized;
  }

  private ensureDirAndRotate(): void {
    const dir = path.dirname(this.logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(this.logPath)) {
      try {
        const stats = fs.statSync(this.logPath);
        if (stats.size >= this.maxSizeBytes) {
          const oldPath = this.logPath + '.old';
          if (fs.existsSync(oldPath)) {
            fs.unlinkSync(oldPath);
          }
          fs.renameSync(this.logPath, oldPath);
          logger.info(`Rotated audit log to ${oldPath}`);
        }
      } catch (err) {
        logger.warn('Audit log rotation check failed:', err);
      }
    }
  }
}

export const auditLogger = new AuditLogger();
