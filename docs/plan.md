# go-chamber — веб-интерфейс для Claude Code и Codex

## Context
Нужен локальный однопользовательский веб-UI в духе OpenChamber для запуска Claude Code и Codex CLI
**по подписке** (Claude Pro/Max, ChatGPT). Полная интеграция: стриминг, вопросы агента и
permissions, квоты, субагенты. Плюс: diff изменений, git worktree на сессию, встроенный терминал
(в т.ч. самостоятельный, не привязанный к сессии/рабочей директории), мобильный/PWA UI с push.
Директория `/Users/igorzygin/Develop/go-chamber` пустая — greenfield.
Стек: **Go** (один бинарник, фронт через `embed`) + **React/Vite/TS**. Установлено: go 1.26,
node 26, claude 2.1.282, codex 0.153.0.

## Ключевые решения (по результатам исследования)
- **SDK не нужен ни для одного агента** — их SDK сами являются обёртками над CLI-протоколами.
  Go говорит с CLI напрямую по stdio. Подписка работает, т.к. запускается штатный бинарник
  с логином пользователя (`claude login`, `~/.codex/auth.json`). Мы токены не читаем и не храним.
  - Политика Anthropic: личное использование своего бинарника со своей подпиской — разрешено;
    мультиюзер/хранение чужих токенов — нет. Undocumented `api/oauth/usage` **не используем**.
- **Claude**: процесс на активную сессию:
  `claude -p --input-format stream-json --output-format stream-json --verbose
   --include-partial-messages --permission-prompt-tool stdio --forward-subagent-text
   [--resume <id>] [--model] [--permission-mode]`. **Без `--bare`** (он отключает OAuth).
  Фича-детект по `system/init.capabilities`, а не по версии.
- **Codex**: **один** долгоживущий `codex app-server` (JSON-RPC 2.0, NDJSON по stdio) на все
  треды. `initialize` (+`experimentalApi:true`) → `initialized` → `thread/start|resume` → `turn/start`.
  Типы — ручное подмножество, сверяемое со схемой `codex app-server generate-json-schema`
  (скрипт `scripts/codex-schema-check`), версию Codex пиним в README. Документация местами
  врёт (`decision` vs `result`, `item/tool/requestUserInput`) — источник истины схема.
- **Нормализованная модель событий** — ядро системы. Адаптеры переводят протоколы в общий
  формат; UI знает только его.

## Правила проекта (первый коммит: `CLAUDE.md` + `AGENTS.md` → симлинк на него, чтобы Codex читал те же правила)
Содержимое файла правил:
- **TDD**: red → green → refactor. Продакшен-код пишется только под падающий тест; баг-фикс
  начинается с теста, воспроизводящего баг. Коммит без тестов на новое поведение не принимается.
- **DDD**: слои с зависимостями только внутрь:
  - `internal/domain` — сущности и value objects (Session, Turn, Item, AgentRequest,
    QuotaSnapshot, Worktree, Terminal), доменные события, инварианты. Никакого I/O,
    никаких внешних пакетов кроме stdlib.
  - `internal/app` — use cases (StartSession, SendMessage, ResumeSession, AnswerRequest,
    InterruptTurn, OpenTerminal, CreateWorktree…) и **порты** (интерфейсы `AgentRuntime`,
    `SessionRepo`, `EventBus`, `PTYFactory`, `GitRepo`, `Notifier`, `Clock`).
  - `internal/adapters/*` — реализации портов: `claude`, `codex`, `sqlite`, `pty`, `git`,
    `webpush`, `http` (REST/WS). Протокольные типы CLI не выходят за пределы своего адаптера —
    anti-corruption layer переводит их в доменные.
  - Единый язык (ubiquitous language): Session / Turn / Item / Request / Quota — одни и те же
    термины в коде, API и UI.
- **SOLID**: маленькие интерфейсы на стороне потребителя (ISP/DIP); новый агент добавляется
  новым адаптером `AgentRuntime` без правок в domain/app (OCP); один пакет — одна причина
  изменения (SRP); все реализации порта проходят общий контрактный тест (LSP).
- **Пороги покрытия (CI падает ниже)**:
  - Go unit: `domain` ≥ 95%, `app` ≥ 90%, адаптеры ≥ 80%, всего ≥ 85%
    (`go test -race -coverprofile`, проверка скриптом `scripts/coverage-gate`).
  - Frontend unit (Vitest + Testing Library): ≥ 80% строк/ветвей для `stores`, `lib`,
    компонентов карточек запросов.
- **Мутационное тестирование**:
  - Go — `gremlins` (`gremlins unleash --threshold-efficacy`): efficacy ≥ 80% для `domain`
    и `app`, ≥ 65% для адаптеров.
  - TS — Stryker (`thresholds.break`): ≥ 70% для `stores`/`lib`.
  - Запускается в CI на изменённых пакетах и полностью по ночам/перед релизом.
- **E2E**: Playwright против собранного бинарника с **фейковыми CLI** (детерминированно, без
  трат подписки): чат со стримингом, permission, вопрос, субагент, квоты, обрыв+resume,
  терминал, worktree+diff, мобильный вьюпорт. Каждая пользовательская фича — минимум один
  e2e-сценарий. Отдельный ручной smoke-чеклист на реальных `claude`/`codex` перед релизом.
- **Контрактные тесты протоколов**: golden-транскрипты реальных CLI в `testdata`; при
  обновлении версии CLI — перезапись фикстур и `scripts/codex-schema-check`.
- **Код-ревью по окончании каждой фазы**: перед тем как объявить фазу закрытой, запускаются
  два независимых ревью-субагента — по Go-коду и по TS/JS-коду. Каждый проверяет дифф фазы
  на баги, регрессии, дыры в безопасности, нарушения SOLID и пробелы в покрытии тестами и
  возвращает список находок; находки разбираются до закрытия фазы.
- Definition of Done: тесты зелёные, пороги покрытия и мутантов пройдены, `golangci-lint`,
  `eslint`, `tsc --noEmit` чистые, код-ревью двумя субагентами (Go и JS) пройдено.

## Архитектура

```
Browser (React PWA) ──WS /api/ws (JSON events, seq/replay)──┐
                    ──WS /api/pty/{id} (binary)───────────┐  │
                    ──REST /api/*──────────────────────┐   │  │
Go server: httpapi → session.Manager → agent.Adapter ─┴───┴──┴─
              ├─ claude.Adapter  (proc per session, stream-json + control_request)
              ├─ codex.Adapter   (single app-server, JSON-RPC multiplex by threadId)
              ├─ pty.Manager     (creack/pty, ring-buffer scrollback, независим от сессий)
              ├─ git (worktree, diff), quota.Service, push.Service (VAPID), store (SQLite)
```

### Пакеты (Go, `module github.com/igorzygin/go-chamber` — уточнить)
Ниже пакеты описаны по назначению; раскладка по DDD-слоям:
`event`, модели Session/Request/Quota → `internal/domain`; `session.Manager`, `quota.Service`,
логика resume → `internal/app`; `agent/claude`, `agent/codex`, `store`, `pty`, `git`,
`push`, `hub`+`httpapi` → `internal/adapters/...`; интерфейс `agent.Adapter` = порт
`app.AgentRuntime`.
- `cmd/go-chamber/main.go` — флаги (`--addr 127.0.0.1:7777`, `--data ~/.go-chamber`), старт.
- `internal/event` — нормализованные типы:
  - `Session{ID, Agent(claude|codex), NativeID, Cwd, WorktreeID, Title, Model, Status, ParentID}`
  - `Item{ID, SessionID, TurnID, ParentItemID, Kind, Status, Payload}`; Kind: `user_message`,
    `assistant_message`, `reasoning`, `tool_call` (generic), `command`, `file_change`,
    `subagent`, `plan`, `error`.
  - `Request{ID, SessionID, Kind(permission|question|elicitation), Payload}` — блокирующие
    запросы агента; `Resolve(answer)`.
  - `Delta` (текст/вывод потоком), `QuotaSnapshot{Agent, Windows[{Name, UsedPct, ResetsAt}]}`,
    `Usage{tokens, cost}`.
  - Каждое событие в сессии получает монотонный `seq` → replay при реконнекте.
- `internal/agent` — интерфейс `Adapter`: `Start/Resume(opts) Session`, `Send(input)`,
  `Interrupt`, `Respond(requestID, answer)`, `SetModel/SetMode`, `Events() <-chan event`,
  `ListModels`, `ListHistory`, `Quota()`.
- `internal/agent/claude`:
  - `proc.go` — spawn, NDJSON reader/writer, `control_request` корреляция по `request_id`.
  - `map.go` — `stream_event` → дельты; `assistant/user` блоки → Items; `tool_use` Edit/Write/
    MultiEdit → `file_change`, Bash → `command`, Task/Agent → `subagent`.
  - permissions: `can_use_tool` → `Request{permission}`; ответ `allow{updatedInput,
    updatedPermissions}` / `deny{message}`. `AskUserQuestion` → `Request{question}`, ответ
    `allow{updatedInput:{questions, answers:{"<text>": label|[labels]}}}`.
  - субагенты: дерево по `parent_tool_use_id`; фоновые — `task_started/task_notification`,
    остановка `stop_task`.
  - квоты: `rate_limit_event.rate_limit_info` (five_hour/seven_day/...) → `QuotaSnapshot`
    (кэш последнего значения в SQLite — событие приходит только во время работы).
  - usage: `result.usage/total_cost_usd/model_usage`.
  - история: импорт `~/.claude/projects/<slug>/<id>.jsonl` для списка/просмотра старых сессий.
- `internal/agent/codex`:
  - `rpc.go` — JSON-RPC клиент (id-корреляция, server→client requests, notifications).
  - `map.go` — `item/started|completed` + `item/*/delta` → Items; `turn/diff/updated` → diff сессии;
    `turn/plan/updated` → `plan`.
  - approvals: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
    `item/permissions/requestApproval` → `Request{permission}`, ответ `{decision: accept|
    acceptForSession|decline|cancel}`; `mcpServer/elicitation/request` → elicitation;
    `item/tool/requestUserInput` → `Request{question}`, ответ `{answers:{qid:{answers:[..]}}}`;
    `serverRequest/resolved` → закрыть запрос в UI.
  - субагенты: `collabAgentToolCall` (receiverThreadIds, agentsStates) → `subagent` item +
    дочерние Session с `ParentID`; стримы детей — через подписку/`thread/read`.
  - квоты: `account/rateLimits/read` при старте + `account/rateLimits/updated`;
    `thread/tokenUsage/updated`; `account/read` (email, planType).
  - login: если не залогинен — `account/login/start {type: chatgptDeviceCode}` → показать код в UI.
  - `model/list`, `collaborationMode/list`, `thread/list`, `thread/read` для истории.
  - `turn/steer` — дописать в идущий ход (у Claude — просто следующий user message в stdin).
- `internal/session` — Manager: реестр сессий, lifecycle процессов (idle-kill Claude-процессов
  через N минут с resume по требованию), глобальный индекс pending requests (как
  `global-blocking-requests` в OpenChamber), fan-out в hub.
- `internal/hub` — WS-хаб: подписки клиента на сессии, буфер последних событий с seq, replay
  `since=seq`, при разрыве больше буфера — клиент перезапрашивает snapshot.
- `internal/store` — SQLite (`modernc.org/sqlite`, без cgo): projects, sessions, items (финальные
  состояния, не дельты), pending requests, quota cache, push subscriptions, terminals meta.
- `internal/pty` — `creack/pty`; терминал = `{ID, Cwd, Shell, Title, SessionID?}`; кольцевой
  буфер ~1 МБ для восстановления после перезагрузки страницы; resize; живёт независимо от
  сессий (можно открыть в `$HOME` или любой директории).
- `internal/git` — `worktree add <repo>/.git/../../.go-chamber-wt/<repo>/<slug> -b chamber/<slug>`
  (путь уточним; вне репо), list/remove, `git diff <base>...` + untracked, статус, per-file diff.
- `internal/push` — Web Push (`SherClockHolmes/webpush-go`, VAPID-ключи в data-dir): уведомления
  «агент спрашивает», «нужно разрешение», «ход завершён».
- `internal/httpapi` — REST + WS, auth: случайный токен при первом запуске, печатается в
  консоль как URL `?token=` → httpOnly cookie. Bind по умолчанию 127.0.0.1; удалённый доступ —
  через Tailscale serve (даёт HTTPS, нужен для PWA/push).
- `web/` — фронт, `web/dist` встраивается `//go:embed`.

### Фронтенд (`web/`)
React 19 + Vite + TS + Tailwind 4 + Radix/shadcn + Zustand. Библиотеки: `react-markdown` +
`shiki`, `@xterm/xterm` (+fit, webgl), diff — `@git-diff-view/react` (или `react-diff-view`),
`vite-plugin-pwa`.
- Лэйаут: сайдбар (проекты → сессии, бейджи агента/статуса/pending-вопросов, дерево субагентов),
  центр — чат, правая панель — вкладки Diff / Terminal / Quotas; на мобиле — табы снизу.
- Чат: стриминг с троттлингом ~100мс; карточки tool calls (команда+вывод, файл+inline diff,
  MCP), свёрнутый reasoning, план/тудушки, субагент как раскрываемая вложенная лента.
- Request-карточки: permission (Allow / Allow for session / Deny с комментарием), вопросы
  (радио/чекбоксы + «другое», мультивопрос), глобальный лоток pending-запросов по всем сессиям.
- Композер: выбор агента/модели/effort/режима (plan/default/acceptEdits/bypass ↔ Codex
  approvalPolicy+sandbox), прикрепление картинок, Stop, steer во время хода.
- Новая сессия: проект (путь) → «в worktree?» → агент → модель.
- Quotas-виджет: полосы 5h/weekly для Claude и primary/secondary для Codex с таймером сброса,
  плюс токены/стоимость сессии.
- Терминалы: список вкладок, «новый терминал» с выбором cwd (по умолчанию $HOME), также
  «терминал в директории сессии».
- Store-принципы из OpenChamber: гранулярные селекторы, обновление только изменённых полей,
  при ошибке отправки — статус «unknown» и сверка после реконнекта.

## Прерывание и продолжение сессий (сквозное требование, закладывается с фазы 1)
Процесс агента — расходный материал. Сессия продолжает существовать в SQLite и в родной истории
агента (`~/.claude/projects/*.jsonl`, `~/.codex/sessions`), а её можно в любой момент
«поднять» заново.
- **Нативный ID сохраняем сразу**: Claude — `session_id` из `system/init`; Codex — `threadId`
  из ответа `thread/start`. Запись в SQLite до первого хода, чтобы падение в середине не
  потеряло связь.
- **Причины обрыва и реакция** (`Session.Status`: `running | idle | detached | interrupted | error`):
  - процесс упал или был убит (краш, OOM, `kill`) — `interrupted`; ход помечаем
    незавершённым, pending-запросы → `stale`, карточка в UI гаснет;
  - idle-kill Claude-процесса по таймауту — `detached` (это нормальное состояние, не ошибка);
  - перезапуск самого go-chamber — при старте все `running/idle` → `detached`;
  - `codex app-server` упал — перезапуск супервизором с backoff, затем `thread/resume` для
    всех тредов, у которых есть подписчики; остальные → `detached`;
  - лимит подписки (`rate_limit_event.status=rejected` / Codex `rateLimitReachedType`) —
    `interrupted` с причиной `quota` и временем `resets_at`; в UI кнопка «продолжить после
    сброса» (опционально — авто-продолжение по таймеру).
- **Продолжение**: любое действие в `detached/interrupted` сессии (новое сообщение, «Continue»,
  ответ) лениво поднимает процесс: Claude — `claude ... --resume <session_id>` (cwd = cwd
  сессии/worktree, иначе транскрипт не найдётся на старых версиях); Codex — `thread/resume
  {threadId}`. Для прерванного хода кнопка **Continue** отправляет короткое «продолжай с места
  остановки» в уже поднятую сессию.
- **Fork**: «Продолжить в новой ветке» — Claude `--resume <id> --fork-session`, Codex
  `thread/fork`; в сайдбаре показываем связь с родителем.
- **Сессии, начатые вне UI** (в терминале через `claude`/`codex`): вкладка «History» читает
  `~/.claude/projects` и `thread/list`; любую можно открыть и продолжить тем же механизмом
  (импорт создаёт запись Session с NativeID).
- **Консистентность UI после поднятия**: при resume перечитываем историю из первоисточника
  (Claude jsonl / Codex `thread/read includeTurns`) и сверяем с Items в SQLite, чтобы
  показать то, что агент успел записать до обрыва.
- **Фоновые субагенты Claude** при обрыве теряются — помечаем их `interrupted`, в родителе
  показываем, что результат не получен.
- Тесты: фейковый CLI, который умирает посреди хода / посреди pending-запроса; проверка, что
  следующее сообщение вызывает spawn с `--resume <тот же id>`, а Codex — `thread/resume`.

## Фазы
0. **Скелет и правила**: `CLAUDE.md`/`AGENTS.md`, go mod, слои domain/app/adapters, main,
   httpapi с auth, embed пустого Vite-приложения, SQLite-миграции, Makefile (`make dev`,
   `make build`, `make test`, `make cover-gate`, `make mutate`, `make e2e`), фейковые CLI
   `testutil/fakeclaude`, `testutil/fakecodex`, каркас Playwright, `git init`.
1. **Claude-адаптер + чат**: процесс, стриминг, Items, отправка/стоп; lifecycle-статусы и
   ленивый `--resume` сразу (см. раздел выше); UI чата и сайдбара.
2. **Requests**: permissions + AskUserQuestion для Claude; UI карточек и глобальный лоток.
3. **Codex-адаптер**: app-server, треды, стриминг, approvals, requestUserInput, login device-code.
4. **Субагенты** для обоих: дерево в сайдбаре, вложенные ленты, stop_task/interruptAgent.
5. **Квоты и usage**: QuotaService, кэш, виджет.
6. **Терминал**: pty.Manager, WS-бинарный канал, xterm, независимые терминалы.
7. **Worktrees + Diff**: создание сессии в worktree, панель diff (git + per-turn), удаление/мерж-подсказки.
8. **PWA + push**: manifest, SW, адаптивная вёрстка, Web Push.
9. Полировка: импорт старых сессий из `~/.claude` и `~/.codex`, поиск, темы.

## Верификация
- **Юнит/golden-тесты адаптеров**: записанные NDJSON-транскрипты реальных `claude`/`codex`
  (fixtures в `internal/agent/*/testdata`) → ожидаемая последовательность нормализованных событий.
- **Фейковые CLI**: маленькие Go-бинарники, эмулирующие протоколы (включая can_use_tool,
  requestApproval, requestUserInput) — интеграционные тесты Manager+hub без трат подписки.
- **Schema-drift**: `scripts/codex-schema-check` генерирует схему установленного codex и
  сверяет используемые методы/поля.
- **E2E вручную на реальных CLI**: `make build && ./go-chamber` → открыть в браузере (Claude
  Browser pane) → сессия Claude: задача с правкой файла (permission-карточка, diff), вопрос
  через AskUserQuestion, субагент; то же для Codex; проверить полосы квот; открыть
  независимый терминал в `$HOME`; мобильный вьюпорт (resize_window mobile); перезагрузка
  страницы посреди хода → стрим восстанавливается по seq; `kill` процесса claude посреди хода
  → статус `interrupted` → Continue → тот же session_id продолжается; перезапуск go-chamber →
  сессии `detached` → новое сообщение продолжает их; `kill` codex app-server → авто-рестарт и
  `thread/resume`.
- `go test ./... -race`, `npm run build && npm run lint` в `web/`.
- Гейты из правил: `make cover-gate`, `make mutate`, `make e2e` — каждая фаза закрывается
  только при их прохождении, плюс код-ревью двумя субагентами (Go и JS) по диффу фазы.
