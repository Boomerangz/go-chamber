# Подводные камни claude CLI (проверено 2026-09-25)

- **Реальный `claude -p --input-format stream-json` (2.1.282)**: `system/init` приходит только
  после первого user-сообщения — ждать его при старте нельзя; ID сессии задаём сами через
  `--session-id <uuid>` (работает и с `--resume X --fork-session`). Запросы разрешений и
  AskUserQuestion приходят как `control_request can_use_tool` только с
  `--permission-prompt-tool stdio`; без него (`--permission-prompts host` по умолчанию) CLI
  молча отказывает (`system/permission_denied`). Фейк `testutil/fakeclaude` повторяет оба правила.
  Модель и effort меняются на лету: `set_model {model}` (без `model` — модель по умолчанию) и
  `apply_flag_settings {settings:{effortLevel}}` (`null` — effort модели по умолчанию; неизвестное
  значение молча игнорируется). В `init` effort не виден (всегда null) — реальное состояние
  показывает `control_request get_settings` → `response.applied.{model,effort}`.
  Хуки видны только с `--include-hook-events`: `system/hook_started` и `system/hook_response`
  (`hook_event`, `output`, `stderr`, `exit_code`; блокировка — `{"decision":"block"}` или exit 2).
