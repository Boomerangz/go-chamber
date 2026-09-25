# go-chamber

Локальный однопользовательский веб-UI для запуска Claude Code и Codex CLI по подписке.
Go-бэкенд (один бинарник, фронт встроен через `embed`) + React/Vite/TS в `web/`.
Агенты запускаются как штатные CLI-подпроцессы: `claude -p` (stream-json) и `codex app-server`
(JSON-RPC). Токены подписки не читаем и не храним — используется логин самого CLI.

## Команды
- `make test` — Go unit-тесты с `-race`
- `make cover-gate` — проверка порогов покрытия
- `make mutate` — мутационное тестирование
- `make e2e` — Playwright против собранного бинарника с фейковыми CLI
- `make lint` — `golangci-lint`, `oxlint`, `tsc -b`
- `make check` — всё вместе: lint, cover-gate, mutate, e2e
- `make dev` / `make build`

## TDD
- Red → green → refactor. Продакшен-код пишется только под падающий тест.
- Баг-фикс начинается с теста, воспроизводящего баг.
- Изменение поведения без теста не принимается.

## DDD — слои, зависимости только внутрь
- `internal/domain` — сущности и value objects (Session, Turn, Item, AgentRequest,
  QuotaSnapshot, Worktree, Terminal), доменные события, инварианты.
  Без I/O, без внешних пакетов — только stdlib.
- `internal/app` — use cases (StartSession, SendMessage, ResumeSession, AnswerRequest,
  InterruptTurn, OpenTerminal, CreateWorktree…) и порты — интерфейсы `AgentRuntime`,
  `SessionRepo`, `EventBus`, `PTYFactory`, `GitRepo`, `Notifier`, `Clock`.
  Зависит только от `domain`.
- `internal/adapters/*` — реализации портов: `claude`, `codex`, `sqlite`, `pty`, `git`,
  `webpush`, `http`. Протокольные типы CLI не покидают свой адаптер: anti-corruption layer
  переводит их в доменные.
- `cmd/go-chamber` — composition root: единственное место, где адаптеры связываются с app.
- Единый язык: Session / Turn / Item / Request / Quota — одинаково в коде, API и UI.

## SOLID
- Интерфейсы маленькие и объявляются на стороне потребителя (ISP, DIP).
- Новый агент — новый адаптер `AgentRuntime` без правок `domain`/`app` (OCP).
- Один пакет — одна причина изменения (SRP).
- Все реализации порта проходят общий контрактный тест (LSP).

## Пороги покрытия (гейт падает ниже)
| Область | Порог |
|---|---|
| Go `internal/domain` | ≥ 95% |
| Go `internal/app` | ≥ 90% |
| Go `internal/adapters/*` | ≥ 80% |
| Go всего | ≥ 85% |
| Web `src/stores`, `src/lib`, карточки запросов (Vitest) | ≥ 80% строк и ветвей |

## Мутационное тестирование
- Go — `gremlins unleash --threshold-efficacy`: ≥ 80% для `domain` и `app`, ≥ 65% для адаптеров.
- TS — Stryker (`thresholds.break`): ≥ 70% для `src/stores` и `src/lib`.
- На изменённых пакетах при каждой фазе/PR, полностью — перед релизом.

## E2E
- Playwright против собранного бинарника с фейковыми CLI (`testutil/fakeclaude`,
  `testutil/fakecodex`) — детерминированно, без трат подписки.
- Каждая пользовательская фича — минимум один e2e-сценарий: чат со стримингом, permission,
  вопрос, субагент, квоты, обрыв + resume, терминал, worktree + diff, мобильный вьюпорт.
- Перед релизом — ручной smoke на реальных `claude`/`codex` (`docs/smoke.md`).

## Контрактные тесты протоколов
- Golden-транскрипты реальных CLI лежат в `internal/adapters/*/testdata`.
- При обновлении версии CLI — перезаписать фикстуры и прогнать `scripts/codex-schema-check`.
- Источник истины для Codex — сгенерированная схема (`codex app-server generate-json-schema`),
  а не документация.

## Definition of Done
`make check` зелёный: тесты, пороги покрытия и мутантов, `golangci-lint`, `oxlint`, `tsc -b`,
e2e-сценарий для новой фичи есть.

## Подводные камни инструментов (проверено 2026-09-25)
- **Stryker + vitest**: `@stryker-mutator/vitest-runner@10.0.0` с vitest 5 не активирует мутанты,
  и все они «выживают» (скор 0%). Поэтому vitest зафиксирован на `^4`; перед обновлением
  проверь, что `npm run mutate` даёт ненулевой скор.
- **Stryker `tempDirName`** нельзя класть внутрь `node_modules`: vitest не ищет там тесты,
  получится «No tests were executed».
- **gremlins** под `-race` по умолчанию репортит мутанты как TIMED OUT; `scripts/mutation-gate`
  поэтому использует `--timeout-coefficient 20 --workers 2`.
- **gremlins v0.6.0 игнорирует `--threshold-efficacy`** и всегда выходит с кодом 0 (пакет с
  эффективностью 33% «проходил» порог 65%). Поэтому `scripts/mutation-gate` сам разбирает строку
  `Test efficacy:` и сравнивает её с порогом; на код возврата gremlins не полагайся.
- **gremlins `--exclude-files`**: шаблоны сопоставляются с путём относительно каталога пакета
  (`^session_(darwin|linux)\.go$`, а не `adapters/pty/session_...`). Код, который шлёт сигналы
  по списку процессов, под мутации не отдавать: мутант в `pty/session_*.go` разослал SIGHUP
  чужим процессам пользователя и убил сам gremlins.
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
- **Codex app-server (0.157.0)**: хуки приходят как `hook/started` / `hook/completed`
  (`run.status`: completed/blocked/failed/stopped, `run.entries[].text`); id прогона повторяется.
  Codex сам присылает `userMessage` на каждое сообщение пользователя — для своих сессий его
  не показываем (go-chamber записывает сообщение сам).
- **Node 22+ и `localStorage` в vitest**: у Node свой глобальный `localStorage`, без
  `--localstorage-file` он `undefined` и перекрывает jsdom (`sessionStorage` при этом работает).
  `src/test/setup.ts` подставляет хранилище в памяти.
- Go-пакет `web` без тега `embedweb` отдаёт заглушку: `go test ./...` работает без
  `npm run build`, а `make build` встраивает настоящий `web/dist`.
