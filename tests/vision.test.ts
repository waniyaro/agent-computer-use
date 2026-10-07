import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  normalizeFromScreenshot,
  toLogicalScreenPoint,
  toLogicalWindowPoint,
  pixelToLogicalWindow,
  pixelToLogicalScreen,
  clamp,
} from '../src/engine/coordinate-engine.js';
import {
  VisualClickInputSchema,
  PressHotkeyInputSchema,
  normalizeHotkey,
} from '../src/engine/schemas.js';
import { PolicyEnforcer } from '../src/policy/enforcer.js';
import { PolicyConfigSchema } from '../src/policy/schema.js';
import { AuditLogger } from '../src/audit/logger.js';
import { createProxyServer } from '../src/server.js';
import { CuaDriverBackend } from '../src/backend/cua-driver.js';

const mockServerPath = path.resolve(__dirname, 'fixtures/mock-mcp-server.mjs');

describe('Vision & Coordinate Engine Tests', () => {
  let tempDir: string;
  let stopFilePath: string;
  let auditLogPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-test-'));
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

  // --- 1. Корректность математики трансформации координат ---
  describe('1. Coordinate Transformation Mathematics', () => {
    it('1.1. Нормализация 1x дисплея (standard)', () => {
      const norm = normalizeFromScreenshot(400, 300, 800, 600);
      expect(norm.x_pct).toBe(0.5);
      expect(norm.y_pct).toBe(0.5);
    });

    it('1.2. Нормализация 2x Retina дисплея (physical screenshot pixels)', () => {
      // 1600x1200 Retina скриншот для окна 800x600 логических точек
      const norm = normalizeFromScreenshot(800, 600, 1600, 1200);
      expect(norm.x_pct).toBe(0.5);
      expect(norm.y_pct).toBe(0.5);

      const corner = normalizeFromScreenshot(1600, 1200, 1600, 1200);
      expect(corner.x_pct).toBe(1.0);
      expect(corner.y_pct).toBe(1.0);
    });

    it('1.3. Логические координаты экрана с многомониторными оффсетами', () => {
      // Окно на внешнем 4K мониторе, расположенном справа: x=1728, y=100, w=1000, h=800
      const bounds = { x: 1728, y: 100, width: 1000, height: 800 };
      const point = toLogicalScreenPoint({ x_pct: 0.25, y_pct: 0.5 }, bounds);

      expect(point.screenX).toBe(1728 + 250); // 1978
      expect(point.screenY).toBe(100 + 400); // 500
    });

    it('1.4. Логические координаты внутри окна (window-local)', () => {
      const bounds = { x: 200, y: 200, width: 800, height: 600 };
      const winPt = toLogicalWindowPoint({ x_pct: 0.1, y_pct: 0.2 }, bounds);

      expect(winPt.windowX).toBe(80);
      expect(winPt.windowY).toBe(120);
    });

    it('1.5. Комплексный пересчёт pixelToLogicalWindow для Retina 2x', () => {
      const options = {
        windowBounds: { x: 50, y: 50, width: 800, height: 600 },
        screenshotSize: { width: 1600, height: 1200 },
        scaleFactor: 2.0,
      };

      // Физический пиксель (400, 300) на Retina соответствует логическому (200, 150) окна
      const winPt = pixelToLogicalWindow(400, 300, options);
      expect(winPt.windowX).toBe(200);
      expect(winPt.windowY).toBe(150);

      // Экранные абсолютные координаты
      const scrPt = pixelToLogicalScreen(400, 300, options);
      expect(scrPt.screenX).toBe(250); // 50 + 200
      expect(scrPt.screenY).toBe(200); // 50 + 150
    });
  });

  // --- 2. Защита от выхода за границы окна (clamp) ---
  describe('2. Boundary Protection & Clamping', () => {
    it('2.1. Clamp отрицательных координат со скриншота', () => {
      const norm = normalizeFromScreenshot(-150, -50, 1600, 1200);
      expect(norm.x_pct).toBe(0.0);
      expect(norm.y_pct).toBe(0.0);

      const bounds = { x: 100, y: 100, width: 500, height: 400 };
      const pt = toLogicalScreenPoint(norm, bounds);
      expect(pt.screenX).toBe(100);
      expect(pt.screenY).toBe(100);
    });

    it('2.2. Clamp координат, превышающих размер скриншота', () => {
      const norm = normalizeFromScreenshot(2500, 3000, 1600, 1200);
      expect(norm.x_pct).toBe(1.0);
      expect(norm.y_pct).toBe(1.0);

      const bounds = { x: 100, y: 100, width: 500, height: 400 };
      const pt = toLogicalScreenPoint(norm, bounds);
      expect(pt.screenX).toBe(600); // 100 + 500
      expect(pt.screenY).toBe(500); // 100 + 400
    });

    it('2.3. Обработка нулевых/некорректных размеров экрана', () => {
      const norm = normalizeFromScreenshot(100, 100, 0, 0);
      expect(norm.x_pct).toBe(0);
      expect(norm.y_pct).toBe(0);

      expect(clamp(NaN)).toBe(0);
      expect(clamp(1.5, 0, 1)).toBe(1);
      expect(clamp(-0.5, 0, 1)).toBe(0);
    });
  });

  // --- 3. Валидация Zod для visual_click и press_hotkey ---
  describe('3. Zod Schema Validation', () => {
    it('3.1. VisualClickInputSchema валидирует x_percent/y_percent', () => {
      const validPercent = VisualClickInputSchema.safeParse({
        window_id: 1,
        pid: 100,
        x_percent: 0.5,
        y_percent: 0.25,
        button: 'right',
      });
      expect(validPercent.success).toBe(true);
      if (validPercent.success) {
        expect(validPercent.data.button).toBe('right');
      }

      // Недопустимый процент > 1
      const invalidPercent = VisualClickInputSchema.safeParse({
        window_id: 1,
        pid: 100,
        x_percent: 1.5,
        y_percent: 0.5,
      });
      expect(invalidPercent.success).toBe(false);
    });

    it('3.2. VisualClickInputSchema валидирует pixel coordinates', () => {
      const validPixels = VisualClickInputSchema.safeParse({
        window_id: 1,
        pid: 100,
        x_pixel: 200,
        y_pixel: 150,
        screenshot_width: 800,
        screenshot_height: 600,
        button: 'double',
      });
      expect(validPixels.success).toBe(true);
      if (validPixels.success) {
        expect(validPixels.data.button).toBe('double');
      }

      // Отсутствие как процентов, так и пикселей
      const missingBoth = VisualClickInputSchema.safeParse({
        window_id: 1,
        pid: 100,
      });
      expect(missingBoth.success).toBe(false);
    });

    it('3.3. PressHotkeyInputSchema и нормализация клавиш', () => {
      const validChord = PressHotkeyInputSchema.safeParse({
        window_id: 1,
        pid: 100,
        keys: ['Command', 's'],
      });
      expect(validChord.success).toBe(true);

      const emptyKeys = PressHotkeyInputSchema.safeParse({
        window_id: 1,
        pid: 100,
        keys: [],
      });
      expect(emptyKeys.success).toBe(false);

      // Тест нормализации
      const chord = normalizeHotkey(['Command', 'Shift', '4']);
      expect(chord.isSingleKey).toBe(false);
      expect(chord.chord).toEqual(['cmd', 'shift', '4']);

      const single = normalizeHotkey(['Enter']);
      expect(single.isSingleKey).toBe(true);
      expect(single.singleKey).toBe('return');

      const esc = normalizeHotkey(['Escape']);
      expect(esc.isSingleKey).toBe(true);
      expect(esc.singleKey).toBe('escape');
    });
  });

  // --- 4. Безопасность: Блокировка запрещённых приложений (Terminal) ---
  describe('4. PolicyEnforcer Security & Denylist', () => {
    it('4.1. visual_click блокируется при клике в Terminal (APP_DENIED)', async () => {
      const config = PolicyConfigSchema.parse({
        allowedApps: ['*'], // Разрешено всё, кроме deniedApps
        deniedApps: ['com.apple.Terminal', 'Terminal'],
      });

      const audit = new AuditLogger(auditLogPath);
      const enforcer = new PolicyEnforcer(config, stopFilePath);
      enforcer.updateWindowCache([
        {
          pid: 9999,
          window_id: 8888,
          app_name: 'Terminal',
          bundle_id: 'com.apple.Terminal',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
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
          pid: 9999,
          window_id: 8888,
          x_percent: 0.5,
          y_percent: 0.5,
        },
      });

      expect(res.isError).toBe(true);
      const content = res.content?.[0] as { type: string; text: string };
      expect(content.text).toContain('Policy Violation (APP_DENIED)');

      // Проверка аудит-лога
      const auditLines = fs.readFileSync(auditLogPath, 'utf8').trim().split('\n');
      const lastAudit = JSON.parse(auditLines[auditLines.length - 1]);
      expect(lastAudit.status).toBe('APP_DENIED');
      expect(lastAudit.target_bundle_id).toBe('com.apple.Terminal');

      await client.close();
      await server.close();
      await backend.stop();
    });

    it('4.2. press_hotkey блокируется в запрещённом окне', async () => {
      const config = PolicyConfigSchema.parse({
        allowedApps: ['*'],
        deniedApps: ['com.apple.Terminal'],
      });

      const audit = new AuditLogger(auditLogPath);
      const enforcer = new PolicyEnforcer(config, stopFilePath);
      enforcer.updateWindowCache([
        {
          pid: 9999,
          window_id: 8888,
          app_name: 'Terminal',
          bundle_id: 'com.apple.Terminal',
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
        name: 'press_hotkey',
        arguments: {
          pid: 9999,
          window_id: 8888,
          keys: ['Command', 'c'],
        },
      });

      expect(res.isError).toBe(true);
      const content = res.content?.[0] as { type: string; text: string };
      expect(content.text).toContain('Policy Violation (APP_DENIED)');

      await client.close();
      await server.close();
      await backend.stop();
    });
  });

  // --- 5. Срабатывание TARGET_MISMATCH при несовпадении PID ---
  describe('5. Target Mismatch Defense', () => {
    it('5.1. visual_click отклоняется при несовпадении PID (TARGET_MISMATCH)', async () => {
      const config = PolicyConfigSchema.parse({
        allowedApps: ['*'],
        deniedApps: [],
      });

      const audit = new AuditLogger(auditLogPath);
      const enforcer = new PolicyEnforcer(config, stopFilePath);
      enforcer.updateWindowCache([
        {
          pid: 1234,
          window_id: 5678,
          app_name: 'App1',
          bundle_id: 'com.example.app1',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
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

      // Передаём неверный pid: 9999 вместо 1234 для window_id: 5678
      const res = await client.callTool({
        name: 'visual_click',
        arguments: {
          pid: 9999,
          window_id: 5678,
          x_percent: 0.5,
          y_percent: 0.5,
        },
      });

      expect(res.isError).toBe(true);
      const content = res.content?.[0] as { type: string; text: string };
      expect(content.text).toContain('Policy Violation (TARGET_MISMATCH)');

      await client.close();
      await server.close();
      await backend.stop();
    });

    it('5.2. press_hotkey отклоняется при несовпадении PID', async () => {
      const config = PolicyConfigSchema.parse({
        allowedApps: ['*'],
        deniedApps: [],
      });

      const audit = new AuditLogger(auditLogPath);
      const enforcer = new PolicyEnforcer(config, stopFilePath);
      enforcer.updateWindowCache([
        {
          pid: 1234,
          window_id: 5678,
          app_name: 'App1',
          bundle_id: 'com.example.app1',
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
        name: 'press_hotkey',
        arguments: {
          pid: 9999,
          window_id: 5678,
          keys: ['Enter'],
        },
      });

      expect(res.isError).toBe(true);
      const content = res.content?.[0] as { type: string; text: string };
      expect(content.text).toContain('Policy Violation (TARGET_MISMATCH)');

      await client.close();
      await server.close();
      await backend.stop();
    });
  });

  // --- 6. Успешное выполнение visual_click через прокси ---
  describe('6. End-to-End Successful Execution', () => {
    it('6.1. visual_click рассчитывает координаты и вызывает backend click', async () => {
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
          bounds: { x: 100, y: 50, width: 1000, height: 800 },
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

      // Клик в 20% по X и 30% по Y окна
      const res = await client.callTool({
        name: 'visual_click',
        arguments: {
          pid: 500,
          window_id: 10,
          x_percent: 0.2,
          y_percent: 0.3,
          button: 'left',
        },
      });

      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as Record<string, any>;
      expect(sc.status).toBe('ok');
      expect(sc.coords.window_logical.windowX).toBe(200); // 0.2 * 1000
      expect(sc.coords.window_logical.windowY).toBe(240); // 0.3 * 800
      expect(sc.coords.screen_logical.screenX).toBe(300); // 100 + 200
      expect(sc.coords.screen_logical.screenY).toBe(290); // 50 + 240

      await client.close();
      await server.close();
      await backend.stop();
    });

    it('6.2. visual_click со скриншотными пикселями Retina (2x)', async () => {
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
          bounds: { x: 0, y: 0, width: 800, height: 600 },
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

      // Пиксели со скриншота 1600x1200: (400, 300) -> 25% X, 25% Y
      const res = await client.callTool({
        name: 'visual_click',
        arguments: {
          pid: 500,
          window_id: 10,
          x_pixel: 400,
          y_pixel: 300,
          screenshot_width: 1600,
          screenshot_height: 1200,
          button: 'double',
        },
      });

      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as Record<string, any>;
      expect(sc.status).toBe('ok');
      expect(sc.button).toBe('double');
      expect(sc.coords.window_logical.windowX).toBe(200); // 0.25 * 800
      expect(sc.coords.window_logical.windowY).toBe(150); // 0.25 * 600

      await client.close();
      await server.close();
      await backend.stop();
    });

    it('6.3. press_hotkey успешно выполняет аккорд в разрешенное окно', async () => {
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
        name: 'press_hotkey',
        arguments: {
          pid: 500,
          window_id: 10,
          keys: ['Command', 's'],
        },
      });

      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as Record<string, any>;
      expect(sc.status).toBe('ok');
      expect(sc.keys).toEqual(['Command', 's']);
      expect(sc.parsed_keys.chord).toEqual(['cmd', 's']);

      await client.close();
      await server.close();
      await backend.stop();
    });

    it('6.4. get_window_screenshot возвращает скриншот и метаданные Retina 2x', async () => {
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
          pid: 500,
          window_id: 10,
        },
      });

      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as Record<string, any>;
      expect(sc.width_px).toBe(1600);
      expect(sc.height_px).toBe(1200);
      expect(sc.logical_width).toBe(800);
      expect(sc.logical_height).toBe(600);
      expect(sc.scale_factor).toBe(2.0);

      const img = res.content?.find((c) => c.type === 'image');
      expect(img).toBeDefined();

      await client.close();
      await server.close();
      await backend.stop();
    });
  });
});
