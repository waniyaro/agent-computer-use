import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JournalManager } from '../src/journal/manager.js';
import { PolicyEnforcer } from '../src/policy/enforcer.js';
import { PolicyConfigSchema } from '../src/policy/schema.js';
import { CuaDriverBackend } from '../src/backend/cua-driver.js';
import { createProxyServer } from '../src/server.js';
import { AuditLogger } from '../src/audit/logger.js';
import { AppRecoveryManager } from '../src/recovery/app-manager.js';

const mockServerPath = path.resolve(__dirname, 'fixtures/mock-mcp-server.mjs');

describe('Phase 3 Recovery & Task Journal Tests', () => {
  let tempDir: string;
  let journalDir: string;
  let auditLogPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-test-'));
    journalDir = path.join(tempDir, 'journal');
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

  it('1. Журнал задач: запись шагов, чтение, листинг нескольких задач, автосессия по умолчанию', async () => {
    const journal = new JournalManager(journalDir, 'session-20261007-test-default');
    expect(journal.getCurrentSessionId()).toBe('session-20261007-test-default');

    // 1. Append using default session
    journal.append({ note: 'Step 1: Opened browser', status: 'in_progress' });
    journal.append({ note: 'Step 2: Found login button', status: 'in_progress' });
    journal.append({ note: 'Step 3: Logged in successfully', status: 'completed' });

    // Read default session
    const defaultEntries = journal.read();
    expect(defaultEntries).toHaveLength(3);
    expect(defaultEntries[0].note).toBe('Step 1: Opened browser');
    expect(defaultEntries[2].status).toBe('completed');

    // 2. Append to a custom task ID
    journal.append({ task_id: 'custom-task-42', note: 'Running calculation', status: 'in_progress' });
    journal.append({ task_id: 'custom-task-42', note: 'Calculation failed', status: 'failed' });

    const customEntries = journal.read({ task_id: 'custom-task-42' });
    expect(customEntries).toHaveLength(2);
    expect(customEntries[1].status).toBe('failed');

    // 3. List all tasks
    const list = journal.list();
    expect(list).toHaveLength(2);

    const taskIds = list.map((t) => t.task_id);
    expect(taskIds).toContain('session-20261007-test-default');
    expect(taskIds).toContain('custom-task-42');

    const defaultSummary = list.find((t) => t.task_id === 'session-20261007-test-default');
    expect(defaultSummary?.entry_count).toBe(3);
    expect(defaultSummary?.last_status).toBe('completed');
  });

  it('2. Журнал переживает перезапуск (проверка чтения с диска сохраненного файла)', async () => {
    const taskId = 'persistent-task-100';

    // Первая сессия работы с журналом
    const session1 = new JournalManager(journalDir, 'session-one');
    session1.append({ task_id: taskId, note: 'State before restart', status: 'in_progress' });

    // Имитируем перезапуск сервера (создаем новый экземпляр JournalManager с тем же каталогом)
    const session2 = new JournalManager(journalDir, 'session-two');
    const restoredEntries = session2.read({ task_id: taskId });

    expect(restoredEntries).toHaveLength(1);
    expect(restoredEntries[0].note).toBe('State before restart');
    expect(restoredEntries[0].status).toBe('in_progress');

    // Дописываем в восстановленную задачу
    session2.append({ task_id: taskId, note: 'State after restart', status: 'completed' });
    const updatedEntries = session2.read({ task_id: taskId });
    expect(updatedEntries).toHaveLength(2);
    expect(updatedEntries[1].note).toBe('State after restart');
  });

  it('3. ensure_app_running: успешный старт разрешенного приложения и отказ для запрещенного', async () => {
    const config = PolicyConfigSchema.parse({
      allowedApps: ['com.apple.calculator', 'Калькулятор'],
      deniedApps: ['com.apple.Terminal', 'Terminal'],
      toolProfile: 'full',
    });

    const enforcer = new PolicyEnforcer(config, path.join(tempDir, 'STOP'));
    const backend = new CuaDriverBackend({
      command: 'node',
      args: [mockServerPath],
      maxRetries: 3,
      retryDelayMs: 100,
    });
    await backend.start();

    const audit = new AuditLogger(auditLogPath);
    const journal = new JournalManager(journalDir);
    const recovery = new AppRecoveryManager(backend, enforcer);

    const server = createProxyServer(backend, enforcer, audit, journal, recovery);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    // 1. Пробуем запустить запрещенное приложение (Terminal) -> отказ APP_DENIED
    const deniedRes = await client.callTool({
      name: 'ensure_app_running',
      arguments: { bundle_id: 'com.apple.Terminal', name: 'Terminal' },
    });
    expect(deniedRes.isError).toBe(true);
    const deniedStructured = deniedRes.structuredContent as Record<string, unknown>;
    expect(deniedStructured.code).toBe('APP_DENIED');

    // 2. Пробуем запустить незарегистрированное приложение -> отказ APP_NOT_ALLOWED
    const notAllowedRes = await client.callTool({
      name: 'ensure_app_running',
      arguments: { bundle_id: 'com.unknown.app' },
    });
    expect(notAllowedRes.isError).toBe(true);
    const notAllowedStructured = notAllowedRes.structuredContent as Record<string, unknown>;
    expect(notAllowedStructured.code).toBe('APP_NOT_ALLOWED');

    // 3. Запускаем разрешенное приложение (Calculator) -> успех
    const allowedRes = await client.callTool({
      name: 'ensure_app_running',
      arguments: { bundle_id: 'com.apple.calculator', name: 'Калькулятор' },
    });
    expect(allowedRes.isError).toBeFalsy();
    const allowedStructured = allowedRes.structuredContent as Record<string, unknown>;
    expect(allowedStructured.status).toBe('running');
    expect(allowedStructured.bundle_id).toBe('com.apple.calculator');
    expect(allowedStructured.requires_new_state).toBe(true);
    expect(allowedStructured.pid).toBe(1234);
    expect(allowedStructured.window_id).toBe(5678);

    await client.close();
    await server.close();
    await backend.stop();
  });

  it('4. Тест APP_NOT_RUNNING: при симуляции падения процесса возвращается структурированная ошибка с хинтом ensure_app_running', async () => {
    const config = PolicyConfigSchema.parse({
      allowedApps: ['com.apple.calculator', 'Калькулятор'],
      deniedApps: [],
      autoRelaunch: false, // Тестируем прямой возврат APP_NOT_RUNNING
      toolProfile: 'full',
    });

    const enforcer = new PolicyEnforcer(config, path.join(tempDir, 'STOP'));
    // Регистрируем в кэше окон упавший процесс 9999
    enforcer.updateWindowCache([
      {
        pid: 9999,
        window_id: 8888,
        app_name: 'Калькулятор',
        bundle_id: 'com.apple.calculator',
      },
    ]);

    const backend = new CuaDriverBackend({
      command: 'node',
      args: [mockServerPath],
      maxRetries: 3,
      retryDelayMs: 100,
    });
    await backend.start();

    const audit = new AuditLogger(auditLogPath);
    const journal = new JournalManager(journalDir);
    const recovery = new AppRecoveryManager(backend, enforcer);

    const server = createProxyServer(backend, enforcer, audit, journal, recovery);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    // Вызываем click на pid 9999 (мок-сервер вернет 'process not found: pid 9999 is dead')
    const clickRes = await client.callTool({
      name: 'click',
      arguments: { pid: 9999, window_id: 8888 },
    });

    expect(clickRes.isError).toBe(true);
    const structured = clickRes.structuredContent as Record<string, unknown>;
    expect(structured).toBeDefined();
    expect(structured.code).toBe('APP_NOT_RUNNING');
    expect(structured.suggested_action).toBe('ensure_app_running');
    expect(structured.target_bundle_id).toBe('com.apple.calculator');
    expect((clickRes.content[0] as { text: string }).text).toContain('ensure_app_running');

    await client.close();
    await server.close();
    await backend.stop();
  });
});
