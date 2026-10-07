import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuditLogger } from '../src/audit/logger.js';
import { prepareAuditDetails } from '../src/server.js';

describe('AuditLogger & Sanitization Tests', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
    logPath = path.join(tempDir, 'audit.log');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('записывает структурированные JSONL записи с duration_ms', () => {
    const audit = new AuditLogger(logPath);

    audit.log({
      tool: 'click',
      target_bundle_id: 'com.apple.calculator',
      status: 'ok',
      duration_ms: 125,
      details: { pid: 1234, element_token: 'btn_5' },
    });

    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, 'utf8').trim();
    const entry = JSON.parse(content);

    expect(entry.tool).toBe('click');
    expect(entry.target_bundle_id).toBe('com.apple.calculator');
    expect(entry.status).toBe('ok');
    expect(entry.duration_ms).toBe(125);
    expect(entry.details.element_token).toBe('btn_5');
    expect(entry.timestamp).toBeTruthy();
  });

  it('маскирует конфиденциальный текст при logTypedText: false', () => {
    const rawArgs = {
      pid: 1234,
      window_id: 5678,
      text: 'MySecretPassword!123',
    };

    const sanitized = prepareAuditDetails('type_text', rawArgs, false);
    expect(sanitized.text).toBeUndefined();
    expect(sanitized.masked).toBe(true);
    expect(sanitized.textLength).toBe(20);

    const audit = new AuditLogger(logPath);
    audit.log({
      tool: 'type_text',
      target_bundle_id: 'com.apple.calculator',
      status: 'ok',
      duration_ms: 45,
      details: sanitized,
    });

    const fileContent = fs.readFileSync(logPath, 'utf8');
    expect(fileContent).not.toContain('MySecretPassword!123');
    expect(fileContent).toContain('"masked":true');
  });

  it('сохраняет открытый текст только при logTypedText: true', () => {
    const rawArgs = {
      pid: 1234,
      window_id: 5678,
      text: 'harmless math input: 17 * 23',
    };

    const unmasked = prepareAuditDetails('type_text', rawArgs, true);
    expect(unmasked.text).toBe('harmless math input: 17 * 23');
    expect(unmasked.masked).toBe(false);
  });

  it('вырезает base64 скриншоты и бинарные данные из аудит-лога', () => {
    const audit = new AuditLogger(logPath);

    const bigBase64 = 'iVBORw0KGgoAAAANSUhEUgAA' + 'A'.repeat(600);
    audit.log({
      tool: 'get_window_state',
      target_bundle_id: 'com.apple.calculator',
      status: 'ok',
      duration_ms: 210,
      details: {
        screenshot: bigBase64,
        image: bigBase64,
        normalParam: 'keep_this',
      },
    });

    const fileContent = fs.readFileSync(logPath, 'utf8');
    const entry = JSON.parse(fileContent.trim());

    expect(entry.details.screenshot).toBe('[OMITTED_IMAGE_OR_BINARY]');
    expect(entry.details.image).toBe('[OMITTED_IMAGE_OR_BINARY]');
    expect(entry.details.normalParam).toBe('keep_this');
    expect(fileContent).not.toContain(bigBase64);
  });

  it('выполняет автоматическую ротацию при превышении maxSizeBytes', () => {
    const tinyLimit = 200; // 200 байт лимит для теста
    const audit = new AuditLogger(logPath, tinyLimit);

    // Записываем 3 строки, превышающие 200 байт
    for (let i = 0; i < 3; i++) {
      audit.log({
        tool: `test_tool_${i}`,
        target_bundle_id: 'com.apple.calculator',
        status: 'ok',
        duration_ms: 10,
        details: { index: i, note: 'a'.repeat(80) },
      });
    }

    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.existsSync(logPath + '.old')).toBe(true);
  });
});
