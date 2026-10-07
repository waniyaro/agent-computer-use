# agent-computer-use

> **Безопасный и устойчивый MCP-прокси для прямого управления GUI macOS через Cua Driver**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/Platform-macOS-lightgrey.svg)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-blue.svg)]()

`agent-computer-use` — это специализированный MCP-сервер (Model Context Protocol), функционирующий в качестве прокси поверх [Cua Driver](https://github.com/trycua/cua). Он добавляет строгие политики безопасности (allowlist/denylist по Bundle ID), защиту от несанкционированного ввода, устойчивость к падениям приложений, маскирование конфиденциальных данных в аудите и долговечный журнал шагов задачи.

---

## Архитектура

```
+-----------------------------------------------------------------------------------+
|                            MCP Client (IDE / Agent)                               |
|                     (Antigravity, Claude Code, Codex, Cursor)                     |
+-----------------------------------------------------------------------------------+
                                        | (stdio JSON-RPC)
                                        v
+-----------------------------------------------------------------------------------+
|                        agent-computer-use (Proxy Server)                          |
|                                                                                   |
|  +--------------------+  +--------------------+  +-----------------------------+  |
|  |   PolicyEnforcer   |  |    AuditLogger     |  |       JournalManager        |  |
|  | - Fail-Closed      |  | - JSONL Rotation   |  | - session_id                |  |
|  | - Bundle ID Filter |  | - Mask Typed Text  |  | - task_journal_append/read  |  |
|  | - Emergency STOP   |  |                    |  |                             |  |
|  +--------------------+  +--------------------+  +-----------------------------+  |
|                                                                                   |
|  +-----------------------------------------------------------------------------+  |
|  |                            AppRecoveryManager                               |  |
|  |                   - ensure_app_running / autoRelaunch                       |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
                                        | (stdio JSON-RPC)
                                        v
+-----------------------------------------------------------------------------------+
|                             Cua Driver (0.34.0+)                                  |
|               macOS Accessibility API (AXUIElement) + Direct Screen               |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|                        Целевые приложения macOS (Calculator, etc.)                |
+-----------------------------------------------------------------------------------+
```

---

## Ключевые возможности

1. **Строгие политики безопасности (Fail-Closed):**
   - Блокировка доступа к неразрешенным окнам по macOS Bundle ID (`allowedApps`).
   - Встроенный запрет (`deniedApps`) на взаимодействие с менеджерами паролей (1Password, Bitwarden, Keychain), системными настройками и терминалами.
   - Лимит действий на сессию (`maxActionsPerSession`).
   - Аварийный файловый выключатель (`~/.config/agent-computer-use/STOP`), моментально прерывающий все операции.
2. **Аудит и конфиденциальность:**
   - Полный аудит вызовов в `audit.log` (JSONL) с авто-ротацией при достижении 10 МБ.
   - Маскирование набираемого текста (`logTypedText: false`) во избежание утечки чувствительных строк.
3. **Восстановление и журналирование:**
   - Отслеживание крашей целевых процессов (`APP_NOT_RUNNING`) и функция `ensure_app_running`.
   - Встроенный Task Journal для сохранения контекста агента при сжатии контекстного окна.
4. **Удобный CLI (`acu`):**
   - `acu doctor` — диагностика окружения, прав macOS (Accessibility, Screen Recording) и конфигураций клиентов.
   - `acu install` — безопасная регистрация в конфигах клиентов без перезаписи существующих серверов и с автоматическим бэкапом.

---

## Быстрый старт

### 1. Требования
- macOS 13+ (Apple Silicon или Intel).
- Node.js 18+ (рекомендуется Node.js 22+).
- Установленный [Cua Driver](https://github.com/trycua/cua):
  ```bash
  /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
  ```

### 2. Сборка и установка
```bash
git clone https://github.com/your-username/agent-computer-use.git
cd agent-computer-use
npm install
npm run build
```

### 3. Диагностика системы (`acu doctor`)
```bash
# Через npx или локальный бинарник
node dist/bin/acu.js doctor
```

Пример вывода:
```
======================================================
           agent-computer-use Doctor Report           
======================================================
--- 1. macOS Environment ---
  [OK]   Operating System: macOS 26.6.2 (25G83) - arm64
--- 2. Cua Driver ---
  [OK]   Binary executable: /Users/username/.local/bin/cua-driver (cua-driver 0.34.0)
--- 3. macOS Permissions ---
  [OK]   TCC Grants (Accessibility & Screen Recording): Accessibility: granted, Screen Recording: granted
--- 4. Policy Configuration ---
  [OK]   policy.json validation: Valid: toolProfile='minimal', allowedApps=1, deniedApps=14
--- 5. Kill-Switch Status ---
  [OK]   Emergency STOP file: Inactive (normal operation)
--- 6. Client Integrations ---
  [OK]   Antigravity IDE: Configured in /Users/username/.gemini/config/mcp_config.json
------------------------------------------------------
Overall Status: [OK]
======================================================
```

### 4. Подключение к MCP-клиенту (`acu install`)
```bash
# Dry-run (только просмотр сгенерированного JSON)
node dist/bin/acu.js install --client antigravity --dry-run

# Запись с автоматическим бэкапом существующего файла конфига
node dist/bin/acu.js install --client antigravity --write
```

Поддерживаемые клиенты: `antigravity`, `claude-code`, `codex`.

---

## Конфигурация безопасности (`policy.json`)

Файл настроек располагается по пути: `~/.config/agent-computer-use/policy.json`.

```json
{
  "allowedApps": [
    "com.apple.calculator"
  ],
  "deniedApps": [
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "com.bitwarden.desktop",
    "com.apple.keychainaccess",
    "com.apple.systempreferences",
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "1Password",
    "Bitwarden",
    "Keychain",
    "System Settings",
    "Terminal",
    "iTerm"
  ],
  "maxActionsPerSession": 200,
  "toolProfile": "minimal",
  "allowForeground": false,
  "logTypedText": false,
  "autoRelaunch": false
}
```

### Параметры:
- `allowedApps`: Список Bundle ID или названий приложений, с которыми разрешено взаимодействовать. Если список пуст, ни одно приложение не будет доступно (Fail-Closed).
- `deniedApps`: Черный список критических приложений, блокируемых независимо от allowlist.
- `maxActionsPerSession`: Максимальное количество интерактивных действий за одну сессию MCP-сервера (защита от зацикливания агента).
- `toolProfile`:
  - `"minimal"`: Экспонирует базовые инструменты (`get_window_state`, `list_windows`, `click`, `type_text`, `press_hotkey`, `scroll`, `ensure_app_running`, `task_journal_*`).
  - `"full"`: Открывает расширенный набор инструментов Cua Driver (`drag_and_drop`, `swipe`, `hover` и т.д.).
- `allowForeground`: Разрешает ли переводить приложения на передний план (`delivery_mode: "foreground"`).
- `logTypedText`: Маскировать ли вводимый текст в `audit.log` (при `false` текст заменяется на `***`).
- `autoRelaunch`: Автоматически перезапускать упавшее целевое приложение при сбое.

### Аварийный выключатель (Kill-Switch)
Для экстренной мгновенной блокировки всех действий агента создайте файл:
```bash
touch ~/.config/agent-computer-use/STOP
```
Пока файл существует, прокси будет немедленно отвечать ошибкой `KILL_SWITCH_ACTIVE` на любые вызовы инструментов взаимодействия.

---

## Собственные инструменты прокси

В дополнение к возможностям Cua Driver, прокси предоставляет расширенные инструменты:

### 1. `ensure_app_running`
Проверяет запущен ли целевой процесс по его Bundle ID. Если процесс завершен, производит его запуск через `open -b <bundle_id>`.
```json
{
  "bundle_id": "com.apple.calculator",
  "timeout_ms": 5000
}
```

### 2. `task_journal_append`
Записывает веху или результат шага в журнал задачи `~/.config/agent-computer-use/journal/<task_id>.jsonl`.
```json
{
  "note": "Посчитан результат 17 * 23 = 391",
  "status": "success",
  "step_index": 2
}
```

### 3. `task_journal_read`
Считывает последние записи журнала текущей сессии для восстановления контекста агента.
```json
{
  "limit": 20
}
```

### 4. `task_journal_list`
Возвращает список всех сохраненных файлов журналов задач с размером и временем изменения.

---

## Тестирование

Проект покрыт всесторонними тестами с использованием Vitest:
```bash
npm test
```
Тесты проверяют:
- Прозрачное проксирование и авто-восстановление процесса Cua Driver.
- Контроль доступа `PolicyEnforcer` (Allowlist, Denylist, Unknown process, STOP-файл, лимит действий).
- Маскирование текста в `AuditLogger`.
- Сохранение и считывание Task Journal.
- Функционирование CLI (`acu doctor`, `acu install --dry-run`, `acu install --write` с бэкапами).

---

## Лицензия

Распространяется под лицензией [MIT](LICENSE).
Основано на драйвере автоматизации [Cua Driver](https://github.com/trycua/cua) от команды Cua.
