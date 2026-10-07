import { execFileSync } from 'node:child_process';
import { logger } from '../utils/logger.js';

/**
 * Copies arbitrary UTF-8 text to the macOS system clipboard using pbcopy.
 * Handles Cyrillic (Russian), special symbols, and multi-line strings cleanly
 * without keyboard layout corruption.
 */
export function setSystemClipboard(text: string): void {
  try {
    execFileSync('pbcopy', [], {
      input: Buffer.from(text, 'utf-8'),
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch (err) {
    logger.error('Failed to set system clipboard via pbcopy:', err);
    throw new Error(`Failed to copy to clipboard: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Reads text from the macOS system clipboard using pbpaste.
 */
export function getSystemClipboard(): string {
  try {
    return execFileSync('pbpaste', [], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    logger.error('Failed to read system clipboard via pbpaste:', err);
    return '';
  }
}
