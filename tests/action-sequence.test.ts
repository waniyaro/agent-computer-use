import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PolicyEnforcer } from '../src/policy/enforcer.js';
import { PolicyConfigSchema } from '../src/policy/schema.js';
import { AuditLogger } from '../src/audit/logger.js';
import { createProxyServer } from '../src/server.js';
import { CuaDriverBackend } from '../src/backend/cua-driver.js';
import { getSystemClipboard } from '../src/engine/clipboard.js';

const mockServerPath = path.resolve(__dirname, 'fixtures/mock-mcp-server.mjs');

describe('Action Sequence & Productivity Tools Tests', () => {
  let tempDir: string;
  let stopFilePath: string;
  let auditLogPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-test-'));
    stopFilePath = path.join(tempDir, 'STOP');
    auditLogPath = path.join(tempDir, 'audit.log');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('1. clipboard_paste копирует кириллический текст в системный буфер и жмёт Cmd+V', async () => {
    const config = PolicyConfigSchema.parse({
      allowedApps: ['com.google.antigravity-ide'],
      deniedApps: [],
    });

    const audit = new AuditLogger(auditLogPath);
    const enforcer = new PolicyEnforcer(config, stopFilePath);
    enforcer.updateWindowCache([
      {
        pid: 500,
        window_id: 10,
        app_name: 'Antigravity IDE',
        bundle_id: 'com.google.antigravity-ide',
        bounds: { x: 100, y: 100, width: 800, height: 600 },
      },
    ]);

    const backend = new CuaDriverBackend({
      command: 'node',
      args: [mockServerPath],
    });
    await backend.start();

    const server = createProxyServer(backend, enforcer, audit);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(clientTransport);

    const testText = 'ПриходнаяНакладная_Материалы_123';
    const res = await client.callTool({
      name: 'clipboard_paste',
      arguments: {
        pid: 500,
        window_id: 10,
        text: testText,
      },
    });

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, any>;
    expect(sc.status).toBe('ok');
    expect(sc.text_length).toBe(testText.length);

    // Проверяем, что в системном буфере обмена macOS реально лежит нужный текст
    const currentClipboard = getSystemClipboard();
    expect(currentClipboard).toBe(testText);

    await client.close();
    await server.close();
    await backend.stop();
  });

  it('2. execute_action_sequence пакетно выполняет клик, паузу, вставку текста и нажатие Enter за один вызов', async () => {
    const config = PolicyConfigSchema.parse({
      allowedApps: ['com.google.antigravity-ide'],
      deniedApps: [],
    });

    const audit = new AuditLogger(auditLogPath);
    const enforcer = new PolicyEnforcer(config, stopFilePath);
    enforcer.updateWindowCache([
      {
        pid: 500,
        window_id: 10,
        app_name: 'Antigravity IDE',
        bundle_id: 'com.google.antigravity-ide',
        bounds: { x: 100, y: 100, width: 800, height: 600 },
      },
    ]);

    const backend = new CuaDriverBackend({
      command: 'node',
      args: [mockServerPath],
    });
    await backend.start();

    const server = createProxyServer(backend, enforcer, audit);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(clientTransport);

    const res = await client.callTool({
      name: 'execute_action_sequence',
      arguments: {
        pid: 500,
        window_id: 10,
        delay_between_ms: 10,
        steps: [
          { action: 'click', x_pixel: 250, y_pixel: 300, button: 'left' },
          { action: 'sleep', ms: 20 },
          { action: 'paste', text: 'КолонкаКоличество' },
          { action: 'hotkey', keys: ['Return'] },
        ],
      },
    });

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, any>;
    expect(sc.status).toBe('ok');
    expect(sc.executed_steps).toBe(4);
    expect(sc.total_steps).toBe(4);
    expect(sc.step_results).toHaveLength(4);
    expect(sc.step_results.every((r: any) => r.status === 'ok')).toBe(true);

    await client.close();
    await server.close();
    await backend.stop();
  });

  it('3. get_window_screenshot с save_to_file сохраняет PNG на диск и исключает base64 при include_image: false', async () => {
    const config = PolicyConfigSchema.parse({
      allowedApps: ['com.google.antigravity-ide'],
      deniedApps: [],
    });

    const audit = new AuditLogger(auditLogPath);
    const enforcer = new PolicyEnforcer(config, stopFilePath);
    enforcer.updateWindowCache([
      {
        pid: 500,
        window_id: 10,
        app_name: 'Antigravity IDE',
        bundle_id: 'com.google.antigravity-ide',
        bounds: { x: 100, y: 100, width: 800, height: 600 },
      },
    ]);

    const backend = new CuaDriverBackend({
      command: 'node',
      args: [mockServerPath],
    });
    await backend.start();

    const server = createProxyServer(backend, enforcer, audit);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(clientTransport);

    const targetFilePath = path.join(tempDir, 'screenshots', 'output.png');
    const res = await client.callTool({
      name: 'get_window_screenshot',
      arguments: {
        pid: 500,
        window_id: 10,
        save_to_file: targetFilePath,
        include_image: false,
      },
    });

    expect(res.isError).toBeFalsy();
    // Файл должен быть создан на диске
    expect(fs.existsSync(targetFilePath)).toBe(true);
    const fileBytes = fs.readFileSync(targetFilePath);
    expect(fileBytes.length).toBeGreaterThan(0);

    // В ответе нет тяжёлого base64, только текст и структурированные данные
    const imgItem = res.content?.find((c) => c.type === 'image');
    expect(imgItem).toBeUndefined();

    const sc = res.structuredContent as Record<string, any>;
    expect(sc.saved_to_file).toBe(targetFilePath);
    expect(sc.width_px).toBe(1600);

    await client.close();
    await server.close();
    await backend.stop();
  });

  it('4. visual_click поддерживает явный delivery_mode: background для дочерних окон', async () => {
    const config = PolicyConfigSchema.parse({
      allowedApps: ['com.google.antigravity-ide'],
      deniedApps: [],
    });

    const audit = new AuditLogger(auditLogPath);
    const enforcer = new PolicyEnforcer(config, stopFilePath);
    enforcer.updateWindowCache([
      {
        pid: 500,
        window_id: 10,
        app_name: 'Antigravity IDE',
        bundle_id: 'com.google.antigravity-ide',
        bounds: { x: 100, y: 100, width: 800, height: 600 },
      },
    ]);

    const backend = new CuaDriverBackend({
      command: 'node',
      args: [mockServerPath],
    });
    await backend.start();

    const server = createProxyServer(backend, enforcer, audit);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(clientTransport);

    const res = await client.callTool({
      name: 'visual_click',
      arguments: {
        pid: 500,
        window_id: 10,
        x_pixel: 150,
        y_pixel: 200,
        delivery_mode: 'background',
      },
    });

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, any>;
    expect(sc.status).toBe('ok');

    await client.close();
    await server.close();
    await backend.stop();
  });
});
