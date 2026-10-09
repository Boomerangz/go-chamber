# go-chamber

Локальный однопользовательский веб-UI для запуска Claude Code и Codex CLI по подписке.
Go-бэкенд (один бинарник, фронт встроен через `embed`) + React/Vite/TS в `web/`.
Агенты запускаются как штатные CLI-подпроцессы: `claude -p` (stream-json) и `codex app-server`
(JSON-RPC). Токены подписки не читаем и не храним — используется логин самого CLI.

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
Go-пороги задаёт и проверяет `scripts/coverage-gate`.

| Область | Порог |
|---|---|
| Web `src/stores`, `src/lib`, карточки запросов (Vitest) | ≥ 80% строк и ветвей |

## Мутационное тестирование
**Временно выключено из пайплайна** (`make check`) и из обязательных шагов агентов: вместе с
параллельными прогонами тестов агентов оно съедало всю память машины. Запускать только вручную
(`make mutate`), по одному, когда больше ничего не гоняется. Пороги и подводные камни gremlins/Stryker —
скилл `mutation-testing`. Код, который шлёт сигналы по списку процессов (`adapters/pty/session_*.go`),
под мутации не отдавать: мутант разослал SIGHUP чужим процессам пользователя.

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
`make check` зелёный: тесты, пороги покрытия, `golangci-lint`, `oxlint`, `tsc -b`,
e2e-сценарий для новой фичи есть.

## Подводные камни
- Go-пакет `web` без тега `embedweb` отдаёт заглушку: `go test ./...` работает без
  `npm run build`, а `make build` встраивает настоящий `web/dist`.
