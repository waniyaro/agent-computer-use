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
import { optimizeScreenshot, targetImageSize, nTokensForImg } from '../src/engine/image-optimizer.js';
import { BATCH_REMINDER_TEXT } from '../src/server.js';

const mockServerPath = path.resolve(__dirname, 'fixtures/mock-mcp-server.mjs');

describe('Vision Engine & Latency Optimization Tests', () => {
  let tempDir: string;
  let stopFilePath: string;
  let auditLogPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-opt-test-'));
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

  it('1. optimizeScreenshot handles PNG buffer, downsamples to JPEG and measures downscale ratio', () => {
    // 1x1 transparent PNG in base64
    const minimalPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const pngBuf = Buffer.from(minimalPngBase64, 'base64');

    const result = optimizeScreenshot(pngBuf, {
      maxWidth: 1440,
      format: 'jpeg',
      quality: 80,
    });

    expect(result).toBeDefined();
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.downscaleRatio).toBe(1.0);
    expect(result.width).toBeGreaterThanOrEqual(1);
    expect(result.height).toBeGreaterThanOrEqual(1);
  });

  it('2. wait_for_window successfully finds existing window without sleeping', async () => {
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
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const res = await client.callTool({
      name: 'wait_for_window',
      arguments: {
        bundle_id: 'com.google.antigravity-ide',
        state: 'opened',
        timeout_ms: 2000,
      },
    });

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.status).toBe('ok');
    expect(sc.state).toBe('opened');
    expect(sc.window).toBeDefined();

    await client.close();
    await server.close();
    await backend.stop();
  });

  it('3. wait_for_window times out cleanly when waiting for non-existent window', async () => {
    const config = PolicyConfigSchema.parse({
      allowedApps: ['com.google.antigravity-ide'],
      deniedApps: [],
    });

    const audit = new AuditLogger(auditLogPath);
    const enforcer = new PolicyEnforcer(config, stopFilePath);

    const backend = new CuaDriverBackend({
      command: 'node',
      args: [mockServerPath],
    });
    await backend.start();

    const server = createProxyServer(backend, enforcer, audit);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const res = await client.callTool({
      name: 'wait_for_window',
      arguments: {
        title: 'NonExistentModalTitle_xyz',
        state: 'opened',
        timeout_ms: 300,
        poll_interval_ms: 50,
      },
    });

    expect(res.isError).toBe(true);
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.status).toBe('timeout');

    await client.close();
    await server.close();
    await backend.stop();
  });

  it('4. get_window_screenshot downscales and returns JPEG metadata and ratio', async () => {
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
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const savedFile = path.join(tempDir, 'shot.jpg');
    const res = await client.callTool({
      name: 'get_window_screenshot',
      arguments: {
        window_id: 10,
        max_width: 1440,
        format: 'jpeg',
        quality: 80,
        save_to_file: savedFile,
      },
    });

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.format).toBe('image/jpeg');
    expect(sc.downscale_ratio).toBeDefined();
    expect(fs.existsSync(savedFile)).toBe(true);

    await client.close();
    await server.close();
    await backend.stop();
  });

  it('5. execute_action_sequence handles stop_on_new_window without error when state remains steady', async () => {
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
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const res = await client.callTool({
      name: 'execute_action_sequence',
      arguments: {
        pid: 500,
        window_id: 10,
        stop_on_new_window: true,
        steps: [
          { action: 'click', x_pixel: 100, y_pixel: 150 },
          { action: 'sleep', ms: 10 },
          { action: 'hotkey', keys: ['Return'] },
        ],
      },
    });

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, any>;
    expect(sc.status).toBe('ok');
    expect(sc.executed_steps).toBe(3);

    await client.close();
    await server.close();
    await backend.stop();
  });

  it('6. targetImageSize adheres strictly to 1568-tile and 1568px long-edge budget (Anthropic standard)', () => {
    // 16:10 MacBook native resolution (e.g. 1710x1073 or 3420x2146)
    const [w1, h1] = targetImageSize(1710, 1073);
    expect(w1).toBe(1384);
    expect(h1).toBe(868);
    expect(w1).toBeLessThanOrEqual(1568);
    expect(h1).toBeLessThanOrEqual(1568);
    expect(nTokensForImg(w1, h1)).toBeLessThanOrEqual(1568);

    const [w2, h2] = targetImageSize(3420, 2146);
    expect(w2).toBe(1384);
    expect(h2).toBe(868);
    expect(nTokensForImg(w2, h2)).toBeLessThanOrEqual(1568);

    // Standard 4:3 display (1600x1200)
    const [w3, h3] = targetImageSize(1600, 1200);
    expect(w3).toBe(1269);
    expect(h3).toBe(952);
    expect(nTokensForImg(w3, h3)).toBeLessThanOrEqual(1568);

    // Small image within budget returns unchanged
    const [w4, h4] = targetImageSize(800, 600);
    expect(w4).toBe(800);
    expect(h4).toBe(600);
  });

  it('7. standalone pointer action returns batch reminder to steer model toward execute_action_sequence', async () => {
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
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const res = await client.callTool({
      name: 'visual_click',
      arguments: {
        window_id: 10,
        x_pixel: 200,
        y_pixel: 150,
      },
    });

    expect(res.isError).toBeFalsy();
    const textItem = res.content?.find((c) => c.type === 'text');
    expect(textItem).toBeDefined();
    expect((textItem as any).text).toContain('<reminder>');
    expect((textItem as any).text).toContain('execute_action_sequence');

    await client.close();
    await server.close();
    await backend.stop();
  });
});
