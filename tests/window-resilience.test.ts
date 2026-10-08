import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PolicyEnforcer } from '../src/policy/enforcer.js';
import { PolicyConfigSchema } from '../src/policy/schema.js';
import { AuditLogger } from '../src/audit/logger.js';
import { createProxyServer, isWindowFocusError, isInsertKey } from '../src/server.js';
import { CuaDriverBackend } from '../src/backend/cua-driver.js';
import {
  VisualClickInputSchema,
  GetWindowScreenshotInputSchema,
  ClickInputSchema,
  TypeTextInputSchema,
  PressKeyInputSchema,
  HotkeyInputSchema,
  ScrollInputSchema,
  PressHotkeyInputSchema,
  ClipboardPasteInputSchema,
  ExecuteActionSequenceInputSchema,
} from '../src/engine/schemas.js';

const mockServerPath = path.resolve(__dirname, 'fixtures/mock-mcp-server.mjs');

describe('Window Resilience, Optional PID & Actions Alias Tests', () => {
  let tempDir: string;
  let stopFilePath: string;
  let auditLogPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resilience-test-'));
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

  describe('1. Zod schemas with optional pid and actions alias', () => {
    it('1.1. Все схемы действий валидируются без указания pid', () => {
      expect(VisualClickInputSchema.safeParse({ window_id: 10, x_pixel: 100, y_pixel: 100 }).success).toBe(true);
      expect(GetWindowScreenshotInputSchema.safeParse({ window_id: 10 }).success).toBe(true);
      expect(ClickInputSchema.safeParse({ window_id: 10, x: 50, y: 50 }).success).toBe(true);
      expect(TypeTextInputSchema.safeParse({ window_id: 10, text: 'hello' }).success).toBe(true);
      expect(PressKeyInputSchema.safeParse({ window_id: 10, key: 'Return' }).success).toBe(true);
      expect(HotkeyInputSchema.safeParse({ window_id: 10, keys: ['cmd', 'c'] }).success).toBe(true);
      expect(ScrollInputSchema.safeParse({ window_id: 10, delta_y: -10 }).success).toBe(true);
      expect(ClipboardPasteInputSchema.safeParse({ window_id: 10, text: 'test' }).success).toBe(true);
      expect(PressHotkeyInputSchema.safeParse({ window_id: 10, keys: ['Return'] }).success).toBe(true);
      expect(ExecuteActionSequenceInputSchema.safeParse({ window_id: 10, steps: [{ action: 'sleep', ms: 10 }] }).success).toBe(true);
    });

    it('1.2. ExecuteActionSequenceInputSchema валидирует алиас actions и преобразует его в steps', () => {
      const parsed = ExecuteActionSequenceInputSchema.safeParse({
        window_id: 10,
        actions: [
          { action: 'sleep', ms: 50 },
          { action: 'type', text: '1C:Предприятие' },
        ],
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.steps).toHaveLength(2);
        expect(parsed.data.steps[0].action).toBe('sleep');
        expect(parsed.data.steps[1].action).toBe('type');
      }
    });

    it('1.3. ExecuteActionSequenceInputSchema отклоняет запрос без steps и actions', () => {
      const parsed = ExecuteActionSequenceInputSchema.safeParse({ window_id: 10 });
      expect(parsed.success).toBe(false);
    });

    it('1.4. isInsertKey корректно распознает клавиши Insert и Help', () => {
      expect(isInsertKey('Insert')).toBe(true);
      expect(isInsertKey('insert')).toBe(true);
      expect(isInsertKey('help')).toBe(true);
      expect(isInsertKey('Return')).toBe(false);
    });
  });

  describe('2. Автоматическое определение pid из кэша окон', () => {
    it('2.1. Автоматически достает pid при вызове get_window_screenshot без pid', async () => {
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
        name: 'get_window_screenshot',
        arguments: {
          window_id: 10, // pid опущен
        },
      });

      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as Record<string, any>;
      expect(sc.pid).toBe(500);
      expect(sc.window_id).toBe(10);

      await client.close();
      await server.close();
      await backend.stop();
    });

    it('2.2. Возвращает ошибку WINDOW_NOT_FOUND, если окно не найдено в кэше', async () => {
      const config = PolicyConfigSchema.parse({
        allowedApps: ['com.google.antigravity-ide'],
        deniedApps: [],
      });
      const audit = new AuditLogger(auditLogPath);
      const enforcer = new PolicyEnforcer(config, stopFilePath);
      // Кэш пустой

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
        name: 'get_window_screenshot',
        arguments: {
          window_id: 99999, // Не существует
        },
      });

      expect(res.isError).toBe(true);
      const sc = res.structuredContent as Record<string, any>;
      expect(sc.code).toBe('WINDOW_NOT_FOUND');

      await client.close();
      await server.close();
      await backend.stop();
    });
  });

  describe('3. execute_action_sequence с алиасом actions и наследованием окна', () => {
    it('3.1. Шаги батча наследуют window_id и pid с верхнего уровня при использовании actions', async () => {
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

      // Передаем actions и только window_id на верхнем уровне (без pid)
      const res = await client.callTool({
        name: 'execute_action_sequence',
        arguments: {
          window_id: 10,
          delay_between_ms: 10,
          actions: [
            { action: 'click', x_pixel: 200, y_pixel: 250 },
            { action: 'type', text: 'Номенклатура_01' },
            { action: 'sleep', ms: 10 },
            { action: 'hotkey', keys: ['Return'] },
          ],
        },
      });

      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as Record<string, any>;
      expect(sc.status).toBe('ok');
      expect(sc.executed_steps).toBe(4);
      expect(sc.total_steps).toBe(4);

      await client.close();
      await server.close();
      await backend.stop();
    });
  });

  describe('4. Авто-фоллбек при ошибках фокуса окна (exact target window did not become focused)', () => {
    it('4.1. isWindowFocusError корректно определяет ошибку фокуса Cua Driver', () => {
      expect(isWindowFocusError('exact target window did not become focused')).toBe(true);
      expect(isWindowFocusError('Error: exact target window did not become focused on macOS')).toBe(true);
      expect(isWindowFocusError('Process not found')).toBe(false);
      expect(isWindowFocusError('')).toBe(false);
    });

    it('4.2. Автоматический фоллбек на background режим для обычного клика', async () => {
      const config = PolicyConfigSchema.parse({
        allowedApps: ['com.google.antigravity-ide'],
        deniedApps: [],
        allowForeground: true,
      });
      const audit = new AuditLogger(auditLogPath);
      const enforcer = new PolicyEnforcer(config, stopFilePath);
      // Окно 777 эмулирует ошибку фокуса при foreground в mock-сервере
      enforcer.updateWindowCache([
        {
          pid: 500,
          window_id: 777,
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
        name: 'click',
        arguments: {
          window_id: 777,
          delivery_mode: 'foreground',
        },
      });

      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as Record<string, any>;
      expect(sc.delivery_mode_fallback).toBe(true);
      expect(sc.fallback_delivery_mode).toBe('background');

      await client.close();
      await server.close();
      await backend.stop();
    });

    it('4.3. Автоматический фоллбек в visual_click с пометкой в структурированном ответе', async () => {
      const config = PolicyConfigSchema.parse({
        allowedApps: ['com.google.antigravity-ide'],
        deniedApps: [],
        allowForeground: true,
      });
      const audit = new AuditLogger(auditLogPath);
      const enforcer = new PolicyEnforcer(config, stopFilePath);
      enforcer.updateWindowCache([
        {
          pid: 500,
          window_id: 777,
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
          window_id: 777,
          x_pixel: 200,
          y_pixel: 200,
          delivery_mode: 'foreground',
        },
      });

      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as Record<string, any>;
      expect(sc.status).toBe('ok');
      expect(sc.delivery_mode_fallback).toBe(true);
      expect(sc.fallback_delivery_mode).toBe('background');

      await client.close();
      await server.close();
      await backend.stop();
    });

    it('4.4. Автоматический фоллбек внутри execute_action_sequence при ошибке фокуса на шаге', async () => {
      const config = PolicyConfigSchema.parse({
        allowedApps: ['com.google.antigravity-ide'],
        deniedApps: [],
        allowForeground: true,
      });
      const audit = new AuditLogger(auditLogPath);
      const enforcer = new PolicyEnforcer(config, stopFilePath);
      enforcer.updateWindowCache([
        {
          pid: 500,
          window_id: 777,
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
          window_id: 777,
          delivery_mode: 'foreground',
          actions: [
            { action: 'click', x_pixel: 150, y_pixel: 150 },
            { action: 'sleep', ms: 10 },
          ],
        },
      });

      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as Record<string, any>;
      expect(sc.status).toBe('ok');
      expect(sc.delivery_mode_fallback).toBe(true);
      expect(sc.step_results[0].delivery_mode_fallback).toBe(true);
      expect(sc.step_results[0].fallback_delivery_mode).toBe('background');

      await client.close();
      await server.close();
      await backend.stop();
    });
  });
});
