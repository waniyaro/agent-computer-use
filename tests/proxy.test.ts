import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CuaDriverBackend } from '../src/backend/cua-driver.js';
import { createProxyServer } from '../src/server.js';

const mockServerPath = path.resolve(__dirname, 'fixtures/mock-mcp-server.mjs');

describe('Transparent Proxy Tests', () => {
  let tempStateFile: string;

  beforeEach(() => {
    tempStateFile = path.join(os.tmpdir(), `mock-state-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  });

  afterEach(() => {
    if (fs.existsSync(tempStateFile)) {
      try {
        fs.unlinkSync(tempStateFile);
      } catch {
        // ignore
      }
    }
  });

  it('1. Корректная передача списка инструментов (tools/list)', async () => {
    const backend = new CuaDriverBackend({
      command: 'node',
      args: [mockServerPath],
      maxRetries: 3,
      retryDelayMs: 100,
    });

    await backend.start();
    expect(backend.getState()).toBe('ready');

    const server = createProxyServer(backend);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(clientTransport);

    const toolsRes = await client.listTools();
    const toolNames = toolsRes.tools.map((t) => t.name);

    // Бэкенд инструменты
    expect(toolNames).toContain('echo_tool');
    expect(toolNames).toContain('screenshot_tool');
    expect(toolNames).toContain('crash_tool');
    // Кастомные прокси инструменты
    expect(toolNames).toContain('ensure_app_running');
    expect(toolNames).toContain('task_journal_append');

    await client.close();
    await server.close();
    await backend.stop();
  });

  it('2. Проксирование текстового и графического ответа (image/png base64)', async () => {
    const backend = new CuaDriverBackend({
      command: 'node',
      args: [mockServerPath],
      maxRetries: 3,
      retryDelayMs: 100,
    });

    await backend.start();
    const server = createProxyServer(backend);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(clientTransport);

    // Текстовый вызов
    const echoRes = await client.callTool({
      name: 'echo_tool',
      arguments: { message: 'macOS computer use' },
    });
    expect(echoRes.content).toHaveLength(1);
    expect(echoRes.content[0].type).toBe('text');
    expect((echoRes.content[0] as { text: string }).text).toBe('Echo: macOS computer use');

    // Графический вызов со скриншотом
    const shotRes = await client.callTool({
      name: 'screenshot_tool',
      arguments: {},
    });
    expect(shotRes.content).toHaveLength(2);

    const imageItem = shotRes.content.find((c) => c.type === 'image') as {
      type: 'image';
      data: string;
      mimeType: string;
    };
    expect(imageItem).toBeDefined();
    expect(imageItem.mimeType).toBe('image/png');
    expect(imageItem.data).toBe(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    );

    const textItem = shotRes.content.find((c) => c.type === 'text') as {
      type: 'text';
      text: string;
    };
    expect(textItem).toBeDefined();
    expect(textItem.text).toBe('Screenshot successfully captured');

    await client.close();
    await server.close();
    await backend.stop();
  });

  it('3. Падение процесса и успешный авторестарт', async () => {
    const backend = new CuaDriverBackend({
      command: 'node',
      args: [mockServerPath],
      maxRetries: 3,
      retryDelayMs: 200,
    });

    await backend.start();
    const server = createProxyServer(backend);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(clientTransport);

    // Вызываем инструмент, который принудительно убивает процесс бэкенда
    const crashRes = await client.callTool({
      name: 'crash_tool',
      arguments: {},
    });

    // Проверяем, что прокси перехватил падение и вернул понятную ошибку
    expect(crashRes.isError).toBe(true);
    const structured = crashRes.structuredContent as Record<string, unknown>;
    expect(structured).toBeDefined();
    expect(['backend_crashed', 'backend_down']).toContain(structured.code);

    // Ждём завершения автоматического рестарта
    await new Promise((r) => setTimeout(r, 600));

    expect(backend.getState()).toBe('ready');
    expect(backend.getConsecutiveFailures()).toBe(0);

    // Проверяем, что после авторестарта последующие вызовы проходят успешно
    const recoverRes = await client.callTool({
      name: 'echo_tool',
      arguments: { message: 'recovered' },
    });
    expect(recoverRes.isError).toBeFalsy();
    expect((recoverRes.content[0] as { text: string }).text).toBe('Echo: recovered');

    await client.close();
    await server.close();
    await backend.stop();
  });

  it('4. Переход в backend_down после 3 неудачных падений подряд', async () => {
    // Настраиваем мок-сервер в режим always-crash
    const backend = new CuaDriverBackend({
      command: 'node',
      args: [mockServerPath],
      env: {
        MOCK_STATE_FILE: tempStateFile,
        MOCK_MODE: 'always-crash',
      },
      maxRetries: 3,
      retryDelayMs: 50,
      connectTimeoutMs: 1500,
    });

    // Запуск бэкенда должен завершиться ошибкой, исчерпав 3 попытки
    await expect(backend.start()).rejects.toThrow();

    // Проверяем, что состояние перешло в backend_down
    expect(backend.getState()).toBe('backend_down');
    expect(backend.getConsecutiveFailures()).toBe(3);

    // Проверяем, что вызов инструмента возвращает структурированную ошибку backend_down
    const toolCallRes = await backend.callTool('echo_tool', {});
    expect(toolCallRes.isError).toBe(true);
    const structured = toolCallRes.structuredContent as Record<string, unknown>;
    expect(structured.code).toBe('backend_down');
    expect(structured.consecutive_failures).toBe(3);

    // Проверяем, что вызов listTools выбрасывает ошибку
    await expect(backend.listTools()).rejects.toThrow(/Backend is DOWN/);

    await backend.stop();
  });
});
