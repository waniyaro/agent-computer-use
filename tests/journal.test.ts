import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JournalManager, generateSessionId } from '../src/journal/manager.js';

describe('JournalManager Tests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('генерирует валидный идентификатор сессии', () => {
    const id = generateSessionId();
    expect(id).toMatch(/^session-\d{8}-\d{6}-[a-f0-9]{6}$/);
  });

  it('добавляет и считывает записи журнала текущей сессии', () => {
    const manager = new JournalManager(tempDir);
    const sessionId = manager.getCurrentSessionId();

    const entry1 = manager.append({
      note: 'Step 1: Open calculator',
      status: 'in_progress',
    });
    expect(entry1.note).toBe('Step 1: Open calculator');
    expect(entry1.status).toBe('in_progress');
    expect(entry1.timestamp).toBeTruthy();

    const entry2 = manager.append({
      note: 'Step 2: Computed 17 * 23 = 391',
      status: 'completed',
    });

    const entries = manager.read();
    expect(entries.length).toBe(2);
    expect(entries[0].note).toBe('Step 1: Open calculator');
    expect(entries[1].note).toBe('Step 2: Computed 17 * 23 = 391');
    expect(entries[1].status).toBe('completed');

    const expectedFile = path.join(tempDir, `${sessionId}.jsonl`);
    expect(fs.existsSync(expectedFile)).toBe(true);
  });

  it('поддерживает чтение с ограничением количества записей (limit)', () => {
    const manager = new JournalManager(tempDir);

    for (let i = 1; i <= 5; i++) {
      manager.append({ note: `Step ${i}`, status: 'in_progress' });
    }

    const allEntries = manager.read();
    expect(allEntries.length).toBe(5);

    const limitedEntries = manager.read({ limit: 2 });
    expect(limitedEntries.length).toBe(2);
    expect(limitedEntries[0].note).toBe('Step 4');
    expect(limitedEntries[1].note).toBe('Step 5');
  });

  it('изолирует записи разных задач (task_id)', () => {
    const manager = new JournalManager(tempDir);

    manager.append({ task_id: 'task-alpha', note: 'Alpha step 1' });
    manager.append({ task_id: 'task-beta', note: 'Beta step 1' });
    manager.append({ task_id: 'task-alpha', note: 'Alpha step 2' });

    const alphaEntries = manager.read({ task_id: 'task-alpha' });
    const betaEntries = manager.read({ task_id: 'task-beta' });

    expect(alphaEntries.length).toBe(2);
    expect(betaEntries.length).toBe(1);
    expect(alphaEntries.map((e) => e.note)).toEqual(['Alpha step 1', 'Alpha step 2']);
    expect(betaEntries[0].note).toBe('Beta step 1');
  });

  it('формирует корректную сводку задач через list()', () => {
    const manager = new JournalManager(tempDir);

    manager.append({ task_id: 'task-1', note: 'Start task 1', status: 'in_progress' });
    manager.append({ task_id: 'task-1', note: 'Finish task 1', status: 'completed' });

    manager.append({ task_id: 'task-2', note: 'Failed task 2', status: 'failed' });

    const summaries = manager.list();
    expect(summaries.length).toBe(2);

    const s1 = summaries.find((s) => s.task_id === 'task-1');
    const s2 = summaries.find((s) => s.task_id === 'task-2');

    expect(s1).toBeDefined();
    expect(s1?.entry_count).toBe(2);
    expect(s1?.last_status).toBe('completed');

    expect(s2).toBeDefined();
    expect(s2?.entry_count).toBe(1);
    expect(s2?.last_status).toBe('failed');
  });

  it('журнал переживает перезапуск сервера (данные сохраняются на диске)', () => {
    // 1. Первый инстанс сервера пишет в журнал задачи
    const instance1 = new JournalManager(tempDir);
    instance1.append({
      task_id: 'task-persistent-42',
      note: 'State before server crash or shutdown',
      status: 'in_progress',
      target: { bundle_id: 'com.apple.calculator', window_id: 123 },
    });

    // 2. Имитация перезапуска сервера: создаем совершенно новый инстанс JournalManager с тем же каталогом
    const instance2 = new JournalManager(tempDir);
    const loadedEntries = instance2.read({ task_id: 'task-persistent-42' });

    expect(loadedEntries.length).toBe(1);
    expect(loadedEntries[0].note).toBe('State before server crash or shutdown');
    expect(loadedEntries[0].status).toBe('in_progress');
    expect(loadedEntries[0].timestamp).toBeTruthy();

    // 3. Дописываем новую запись после рестарта
    instance2.append({
      task_id: 'task-persistent-42',
      note: 'Successfully resumed after restart',
      status: 'completed',
    });

    const updatedEntries = instance2.read({ task_id: 'task-persistent-42' });
    expect(updatedEntries.length).toBe(2);
    expect(updatedEntries[1].note).toBe('Successfully resumed after restart');
    expect(updatedEntries[1].status).toBe('completed');
  });
});
