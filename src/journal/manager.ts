import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfigDir } from '../policy/schema.js';
import {
  JournalEntry,
  TaskSummary,
  AppendOptions,
  ReadOptions,
} from './types.js';
import { logger } from '../utils/logger.js';

export function generateSessionId(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const shortId = crypto.randomBytes(3).toString('hex');
  return `session-${year}${month}${day}-${hours}${minutes}${seconds}-${shortId}`;
}

export class JournalManager {
  private baseDir: string;
  private currentSessionId: string;

  constructor(customDir?: string, sessionId?: string) {
    this.baseDir = customDir ?? path.join(getConfigDir(), 'journal');
    this.currentSessionId = sessionId ?? generateSessionId();
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getCurrentSessionId(): string {
    return this.currentSessionId;
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private getFilePath(taskId: string): string {
    // Sanitize taskId to prevent directory traversal
    const safeTaskId = path.basename(taskId).replace(/[^\w-]/g, '_');
    return path.join(this.baseDir, `${safeTaskId}.jsonl`);
  }

  /**
   * Appends an entry to the journal file of the task.
   */
  append(options: AppendOptions): JournalEntry {
    this.ensureDir();
    const taskId = options.task_id || this.currentSessionId;
    const filePath = this.getFilePath(taskId);

    const entry: JournalEntry = {
      timestamp: new Date().toISOString(),
      note: options.note,
      status: options.status ?? 'in_progress',
    };

    const line = JSON.stringify(entry) + '\n';
    try {
      fs.appendFileSync(filePath, line, 'utf8');
      logger.debug(`Appended journal entry to task ${taskId}: ${entry.status}`);
    } catch (err) {
      logger.error(`Failed to append to journal file ${filePath}:`, err);
      throw err;
    }

    return entry;
  }

  /**
   * Reads all journal entries for a given task (or current session).
   */
  read(options?: ReadOptions): JournalEntry[] {
    const taskId = options?.task_id || this.currentSessionId;
    const filePath = this.getFilePath(taskId);

    if (!fs.existsSync(filePath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      const entries = lines.map((line) => JSON.parse(line) as JournalEntry);
      if (options?.limit && options.limit > 0) {
        return entries.slice(-options.limit);
      }
      return entries;
    } catch (err) {
      logger.error(`Failed to read journal file ${filePath}:`, err);
      return [];
    }
  }

  /**
   * Scans the journal directory and returns summaries for all tasks.
   */
  list(): TaskSummary[] {
    if (!fs.existsSync(this.baseDir)) {
      return [];
    }

    try {
      const files = fs.readdirSync(this.baseDir).filter((f) => f.endsWith('.jsonl'));
      const summaries: TaskSummary[] = [];

      for (const file of files) {
        const taskId = path.basename(file, '.jsonl');
        const filePath = path.join(this.baseDir, file);

        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.trim().split('\n').filter(Boolean);
          if (lines.length === 0) continue;

          const firstEntry = JSON.parse(lines[0]) as JournalEntry;
          const lastEntry = JSON.parse(lines[lines.length - 1]) as JournalEntry;

          summaries.push({
            task_id: taskId,
            created_at: firstEntry.timestamp,
            updated_at: lastEntry.timestamp,
            entry_count: lines.length,
            last_status: lastEntry.status,
          });
        } catch {
          // ignore corrupted files
        }
      }

      // Sort newest updated first
      summaries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return summaries;
    } catch (err) {
      logger.error(`Failed to list journals in ${this.baseDir}:`, err);
      return [];
    }
  }
}

export const journalManager = new JournalManager();
