# Native runtime: запуск и текущее поведение

Native встроен в основной Go-бинарник и доступен в выборе агента. Он не запускает
Pi, OpenCode или Codex CLI. Старые адаптеры и сохранённые сессии остаются доступны.

```sh
./bin/go-chamber -data /path/to/data \
  -native-openrouter-key-file ~/.local/share/opencode/auth.json
```

Для OpenRouter также поддерживаются `OPENROUTER_API_KEY`, plain key file и файл
с записью `OPENROUTER_API_KEY=...` (например, `~/.env`). Файл читается напрямую,
без исполнения shell. Ключи не входят в историю сессии и сообщения об ошибках.
`-native-openrouter-url` позволяет указать совместимый endpoint.

В панели аккаунтов Native кнопка **Connect Codex subscription** запускает
собственный device OAuth. Его credential file по умолчанию —
`<data>/native/codex.json`; `-native-codex-auth` задаёт отдельный путь.
Логин установленного Codex CLI не читается. Подписка Codex и OpenRouter имеют
независимые credentials и оплату.

## Каталоги моделей

Codex и OpenRouter запрашиваются по API, список ID не зашит в бинарник. Каталог
обновляется при начале/возобновлении сессии и открытии model picker, если истёк
TTL 15 минут. **Refresh models** обходит TTL. Одновременные запросы объединяются;
после ошибки сохранённый список остаётся доступен с отметкой stale, повторная
автоматическая попытка — через минуту. После успешного входа Codex кэш сбрасывается.
Кэш находится в памяти; без активности фоновых сетевых запросов нет.

Выбранная модель закрепляется в сессии; обновление каталога не переключает её.
Новые и удалённые модели отражаются после refresh. Context window, image input и
Codex reasoning efforts берутся из каталога. При недоступности каталога уже
заданную модель можно продолжить использовать; удалённая из свежего каталога
модель требует нового выбора.

## Возможности

- Потоковые ответы и reasoning, read/write/edit/bash, ls/find/grep.
- Режимы read-only, запрос разрешения перед изменениями и full-access;
  отдельные разрешения и вопросы пользователя через существующий UI.
- Изображения, сохранение контекста в SQLite, resume и независимый fork.
- Steering между пакетами инструментов, interrupt, журналирование неизвестного
  исхода каждого вызова **до** его выполнения; незавершённые действия не повторяются
  автоматически после перезапуска.
- Субагенты с отдельной историей и наследованием разрешений: spawn/wait/send/stop,
  максимум четыре активных дочерних задачи, один уровень вложенности. Родительская
  отмена распространяется на его потомков, включая ещё не подключённые задачи.
- План работы (`update_plan`) и долгие цели (`/goal`) — см. разделы ниже.
- `/compact` и автоматическое сжатие: summary заменяет старый контекст только после
  успешного ответа и сохранения; последние пары вызовов/результатов остаются целыми.
- AGENTS.md по цепочке предков, локальные и пользовательские skills из
  `.agents/skills`, `.codex/skills`, `.claude/skills`. Вложенные AGENTS.md агент
  проверяет перед правками. Файловые записи ограничены рабочим каталогом;
  глобальные skills и handoff transcripts доступны только для чтения.

MCP включается явно через `-native-mcp /path/to/servers.json`:

```json
[
  {"name":"local","command":"my-mcp-server","args":[]},
  {"name":"remote","url":"https://example.org/mcp",
   "headerEnv":{"Authorization":"MY_MCP_AUTH_HEADER"}}
]
```

Поддерживаются stdio и Streamable HTTP, discovery и вызовы инструментов,
структурированные результаты и отмена. Все удалённые инструменты требуют разрешения
(кроме full-access); подсказки сервера не дают автоматических разрешений.
OAuth чужих MCP-серверов и JS extensions Pi не импортируются автоматически.

## Проверки

2026-11-21: живой запуск основного приложения в изолированном data directory:
OpenRouter `openai/gpt-4.1-mini` и Codex subscription `gpt-6-luna` успешно выполнили
`write` → `read` и проверили файл. Каталоги вернули 444 и 8 видимых моделей.
Desktop/mobile E2E покрывают refresh моделей, чат, permission, question, reload,
fork, дочерние сессии и interrupt. Тесты используют локальный HTTP/SSE provider.

Финальный `make check` прошёл: линтеры, Go race/coverage, frontend coverage,
протокольные проверки и полная E2E-сюита — 611 passed, 123 skipped.
Отдельный прогон Native, terminal-v2 и worktree — 28 passed.

Ниже сохранены исследование и промежуточные результаты, предшествовавшие интеграции.

---

# Native runtime: перенос поведения Pi в Go

Статус: проектирование и инвентаризация исходников, 2026-11-21.
Нативный runtime пока не реализован. Этот документ фиксирует объём переноса,
источники и проверки; наличие строки в таблице не означает готовую поддержку.

## Цель и границы

Заменить OpenCode как третий runtime собственным движком go-chamber, без зависимости
от Pi/Node в поставке. Существующие Claude Code и Codex остаются отдельными
runtime. Модели доступны через OpenAI-compatible endpoints и подписочный доступ
Codex. Anthropic/Gemini и другие собственные протоколы провайдеров не входят в объём.

OpenAI-compatible здесь не означает один wire protocol: Chat Completions,
Responses и используемый Pi подписочный Codex Responses имеют различия.
Они должны иметь отдельные преобразования запросов и контрактные тесты.
Модель, endpoint и способ авторизации выбираются явно; автоматического перехода
с подписки на платный API при ошибке нет.

Переносим алгоритмы и проверяемое поведение Pi, адаптируя хранение, параллелизм
и управление сессиями к Go и существующим слоям. Не переносим TUI, Node RPC,
менеджер npm-пакетов и произвольные TypeScript-расширения. Совместимость с ними
не подразумевается. Markdown skills и AGENTS.md — отдельная часть контракта.

## Зафиксированные источники

- Pi: https://github.com/earendil-works/pi-mono/tree/780bf31fcaeb252fa9b68df3964c735eae75bde3
  — исходники версии 1.6.0, SHA `780bf31fcaeb252fa9b68df3964c735eae75bde3`.
- pi-subagents: https://github.com/nicobailon/pi-subagents/tree/fb7ce3ce7524e35b241a2aa6ae13cd574dd1c593
  — SHA `fb7ce3ce7524e35b241a2aa6ae13cd574dd1c593`.
- Локальные checkout исследования:
  `/tmp/go-chamber-pi-probe.vQFTNE/pi-mono` и
  `/tmp/go-chamber-pi-probe.vQFTNE/pi-subagents-source`.
  Это временные копии; воспроизводимый идентификатор — URL и полный SHA.

Оба проекта используют MIT. При переносе существенных фрагментов кода или тестов
сохраняем copyright и текст лицензии рядом с производными исходниками/фикстурами
и в уведомлениях поставки. OAuth flow адаптирован в `internal/adapters/openai/codex_auth.go`; лицензия сохранена в `internal/adapters/openai/LICENSE.pi`.

Установленный пользовательский Pi 0.75.3 не обновлялся. Он не равен исследуемой
версии: например, в 1.6.0 есть исходники встроенного MCP-расширения. Выводы по
старому установленному README нельзя автоматически переносить на новый baseline.

## Авторизация: два разных подписочных пути

В Pi 1.6.0 обнаружены оба пути:

1. `packages/ai/src/providers/openai-codex.ts`,
   `src/auth/oauth/openai-codex.ts`, `src/api/openai-codex-responses.ts`:
   подписочный Codex transport через `https://chatgpt.com/backend-api`,
   OAuth, account identity и специфические правила запросов.
   Это источник для требуемого поведения «как Pi с подпиской Codex».
2. `packages/ai/src/auth/oauth/openai-chatgpt.ts` и провайдер `openai`:
   отдельная регистрация Sign in with ChatGPT для публичного Responses API.
   Это другой OAuth grant и другой маршрут, а не переименование первого.

Официальная документация описывает второй путь для open-source/local apps:
[overview](https://developers.openai.com/siwc/token-sharing-open-source),
[inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
[limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
Он требует собственного OAuth flow и допускает запросы к публичному Responses API;
документированы `store: false`, `stream: true` и передача истории клиентом.
Доступ конкретного аккаунта и соответствие его лимитов текущему Codex не проверены.
Нельзя подменять этим путём требование пользователя без проверки.

Первый этап реализации должен проверить выбранный подписочный путь до переноса
остального движка. Секреты не выводятся в UI, события и диагностику. Существующий
CLI login не считается автоматически пригодным для произвольного endpoint.
Native runtime потребует явного решения о собственном локальном хранилище
авторизации: прежнее правило проекта «авторизацией владеет CLI» уже не описывает
его работу. Ротация refresh token должна быть сериализована между сессиями и
записываться атомарно; auth отдельно от истории и экспортируемых транскриптов.

## Карта переноса

Пути Pi ниже относительны зафиксированному checkout, `coding` означает
`packages/coding-agent`, `ai` — `packages/ai`.

| Область | Источник | Что проверять в Go |
|---|---|---|
| Цикл агента | `packages/agent/src/agent-loop.ts`, `test/agent-loop.test.ts` | Порядок событий, завершение, цикл tool call/result, ошибки и abort |
| Steering/follow-up | `packages/agent/src/agent.ts`, `agent-loop.ts`, тесты обоих | Доставка на границе инструментов, порядок сообщений, отсутствие потерь при завершении/compaction |
| Responses | `ai/src/api/openai-responses.ts`, `openai-responses-shared.ts` | SSE, call IDs, reasoning replay, итоговые usage/status, terminal event |
| Codex subscription | `ai/src/api/openai-codex-responses.ts`, `ai/src/auth/oauth/openai-codex.ts` | Login/refresh, account isolation, параметры, завершение/обрыв stream, retry |
| Chat Completions | `ai/src/api/openai-completions.ts` | Частичные аргументы инструментов, finish reason, различия endpoints, reasoning details |
| История и fork | `coding/src/core/session-manager.ts`, `agent-session.ts` | Возобновление, ветки, границы tool call/result, повреждённая/неполная запись |
| Compaction | `coding/src/core/compaction/`, `test/suite/agent-session-compaction.test.ts` | Token budget, сохранение свежих шагов, отмена, повторная ошибка, неполное резюме |
| Файловые инструменты | `coding/src/core/tools/` | Read/grep/find/ls, точное редактирование, неоднозначное совпадение, усечение вывода |
| Shell | `coding/src/core/tools/bash.ts`, shell regression tests | Timeout, cancel, потомки процесса, поздний вывод, лимит вывода |
| Instructions/skills | `coding/src/core/skills.ts` и загрузчик контекста | Порядок обнаружения, коллизии, явная загрузка, рабочий каталог |
| MCP client | `packages/mcp/`, `coding/src/extensions/mcp/` | Tool schemas/results, reconnect, cancellation, auth, имена инструментов |
| Субагенты | pi-subagents `src/runs/`, `src/extension/rpc.ts`, `test/unit/`, `test/integration/` | Ownership, concurrency, stop/steer/resume, доставка результата и восстановление |
| Permissions/questions | go-chamber `domain.Request`, `Manager.RespondRequest` | Allow once/session/deny, отмена ожидания, pending request после restart |

В первой инвентаризации прочитаны цикл Pi, части подписочной авторизации,
провайдер Codex, список и отдельные фрагменты regression tests. Это не полный
аудит всех перечисленных модулей. Upstream suites в этой работе не запускались.

## Архитектура внутри go-chamber

```text
HTTP / React / MCP server
             |
      app session manager
             |
      native runtime / agent loop
       |          |           |
   model port   tools port   conversation journal port
       |          |           |
   HTTP/SSE    fs/shell/MCP    SQLite
```

Существующие `Session`, `Turn`, `Item`, `Request`, EventBus, SQLite, worktree,
push и UI используются повторно. Runtime реализует текущий `AgentRuntime` и
его общий контрактный тест. Для native availability проверяем конфигурацию и
авторизацию, а не наличие CLI в PATH.

Чистые типы сообщений, вызовов и результатов принадлежат domain. Цикл, очередь,
правила восстановления и порты — app. HTTP/SSE, OAuth, файловые операции,
процессы, внешний MCP-клиент и SQLite — adapters. Типы SDK/провайдера не выходят
из адаптеров; необходимые непрозрачные данные replay хранятся под версией и
идентификатором провайдера и не интерпретируются доменом.

Журнал UI не используется как единственный источник контекста модели. Нужны
полные сообщения модели, tool-call IDs/results, данные reasoning replay,
границы compaction и состояние выполнения. Их храним в той же SQLite отдельной
структурой. Авторитетное состояние и события для UI должны согласовываться при
падении между записью и публикацией.

Субагент — полноценная дочерняя Session с собственным контекстом, моделью и
бюджетом. Для native детей не нужен ещё один внешний процесс Pi и его file-RPC:
их lifecycle принадлежит приложению. Родитель получает ID и может ждать,
отправлять сообщение или останавливать принадлежащего ему ребёнка. Результат
сохраняется до уведомления родителя, повторная доставка дедуплицируется.
Native inference выполняется асинхронно в Go; shell/MCP-процессы имеют отдельных
владельцев и отмену. Существующий app-код пассивного подключения внешних
субагентов потребуется адаптировать; готовый UI не означает готовую оркестрацию.

## Инварианты, которые переносим тестами

- Вызовы инструментов не исполняются из ответа, оборванного token limit,
  ошибки stream или отмены. Валидный JSON сам по себе не доказывает завершённость.
- Для каждой объявленной модели tool-call записи имеется результат либо явная
  отметка отмены/неопределённого исхода. Это включает ещё не начавшиеся вызовы
  отменённого batch.
- Параллельность инструментов определяется их семантикой. Операции, требующие
  последовательности, не становятся конкурентными из-за общего режима parallel.
- Steering не теряется между завершением batch и следующим запросом. Follow-up
  начинает работу после текущей цепочки, а не подменяет steering.
- Конец HTTP/SSE без терминального события — ошибка/неопределённый исход,
  а не успешный TurnEnded. Счётчики usage не удваиваются при replay/retry.
- После crash неизвестный результат побочного эффекта не приводит к
  автоматическому повтору shell, записи файла или внешнего MCP-вызова.
  Локальный журнал не обещает exactly-once внешнего эффекта.
- У одной Conversation один активный writer. Fork создаёт новую ветку,
  resume продолжает старую. Подписочные credentials привязаны к аккаунту.
- Остановка одного ребёнка не останавливает sibling. Поведение остановки
  родителя/всего дерева задаётся отдельно и подтверждается тестом.
- После restart видны завершённые результаты и прерванные задачи; приложение
  не изображает сохранённую goroutine работающим процессом. Продолжение явно.
- Compaction не разрывает пары call/result и не заменяет историю оборванным
  резюме. Новые сообщения, пришедшие во время compaction, сохраняются.

## Порядок реализации и критерии выхода

1. **Авторизация и transport.** Подписочный login/refresh, каталог моделей,
   Responses streaming; Chat Completions для настроенного compatible endpoint.
   Fake HTTP/SSE tests на success, tool calls, обрыв, лимит, отмену и refresh race.
   Затем короткий реальный smoke выбранного подписочного аккаунта. Пока он не
   прошёл, доступ через подписку считается непроверенным.
2. **Цикл и базовые инструменты.** Перенос выбранных Pi regression cases первым
   шагом (red), затем Go implementation (green). Чат → read → ответ,
   edit/shell с разрешением, steering и interrupt. Подключение как отдельного
   native runtime с минимальным UI и desktop/mobile E2E.
3. **Долговечность.** SQLite conversation journal, resume/fork, compaction,
   crash recovery и отсутствие повторных побочных эффектов.
4. **Субагенты.** Два параллельных ребёнка с отдельной историей и событиями,
   остановка одного, steer, сбор результата, продолжение после перезапуска.
   Переносить семантику pi-subagents, а не его detached runner/file inbox.
5. **Рабочая совместимость.** Skills/AGENTS.md, внешний MCP, изображения,
   выбранные модели/effort, вопросы, диагностика и вывод usage. Сопоставить с
   реальными OpenCode-сценариями пользователя и отметить каждое расхождение.
6. **Замена.** `make check` и реальные smoke зелёные; матрица закрыта тестами или
   явно согласованным исключением. Только тогда убрать OpenCode из создания
   новых сессий. Старые записи сохраняют исходный AgentKind и читаемую историю;
   cross-agent continuation переносит контекст, а не объявляет его native resume.

Для каждого кейса записываем upstream SHA/path/test name, Go test и результат.
Где возможно, одинаковые сценарии с fake provider выполняются в Pi и Go, а
нормализованные трассы сравниваются без случайных ID/времени. Upstream test,
прочитанный глазами, не считается проверкой Go реализации.

Требование «ничего не растерять» проверяем по этой явной границе совместимости.
Полный перенос всех возможностей Pi и его npm-экосистемы не заявляется.

## Реализованный этап 1

В ветке `native-runtime` добавлены порт `app.ModelClient`, канонические типы
сообщений в domain и адаптер `internal/adapters/openai`. Поддерживаются три
wire protocol: Chat Completions, Responses, Codex Responses. Tool calls
возвращаются вызывающему коду только после успешного терминального события.
Для Responses сохраняется opaque replay, включая encrypted reasoning.
Codex поддерживает `response.done` и завершённые `output_item.done`.

Отдельная команда не исполняет инструменты и не подключена к основному UI:

```sh
go run ./cmd/native-probe -login -data /path/to/isolated/native-data
go run ./cmd/native-probe -data /path/to/isolated/native-data -model MODEL_ID
go run ./cmd/native-probe -data /path/to/isolated/native-data -wire responses -base-url https://example.org/v1 -key-env MODEL_API_KEY -model MODEL_ID
```

Native device login хранит собственный `codex.json` (0600), атомарно заменяет
файл и сериализует refresh межпроцессной блокировкой. `~/.codex/auth.json`
не читается. API fallback отсутствует. Модель задаётся явно.

Ограничения этапа: нет agent loop, инструментов, журнала, compaction,
субагентов и UI-интеграции. Не реализованы автоматические retries,
WebSocket transport. Для OpenRouter добавлено сохранение reasoning_details.
Совместимость проверяется синтетическими SSE/HTTP контрактами; реальная
авторизация и inference требуют отдельного smoke с аккаунтом пользователя.

### Контракты этапа 1

| Источник Pi (SHA выше) / условие | Проверка Go |
|---|---|
| `openai-codex-responses.ts`: нормализация `response.done`; `openai-responses-shared.ts`: завершённые items | `TestCodexDoneUsesCompletedOutputItems` |
| Responses encrypted reasoning replay | `TestCodexStreamAndReplay` |
| `agent-loop.test.ts`: не исполнять tools из length-truncated ответа (транспортная часть инварианта) | `TestMalformedOrTruncatedStreamsCannotReturnTools`, `TestResponsesOnlyReturnsExecutableToolsAfterCompleted` |
| Fragmented Chat tool arguments | `TestChatStreamAssemblesToolArguments` |
| Tool result identity и provider replay | `TestToolResultConversationBothProtocols` |
| Device grant / refresh (OAuth flow адаптирован; синхронизация специфична для Go) | `TestCodexDeviceLoginAndSerializedRefresh` |
| Cancel и ошибки без утечки тела ответа | `TestStreamCancellationAndConsumerFailure`, `TestAuthNeverFollowsRedirectsOrIncludesBodies` |

Это синтетические проверки контрактов Go, не прогон upstream Pi suite
и не доказательство полной эквивалентности. В текущем прогоне Go race tests
и coverage gate прошли (адаптер 83,8%, общий показатель 90,4%);
frontend unit suite: 1808 passed. Реальный подписочный smoke пройден; результат ниже.

### Итог общей проверки

`make check`: Go lint, TypeScript, Go race/coverage, frontend unit tests
и protocol-tools прошли. E2E: 557 passed, 123 skipped, 50 failed.
В диагностическом повторе `--last-failed --workers=1` первые пять сценариев
`continue.spec.ts` снова упали; прогон остановлен, оставшиеся 45 не запускались.
Следовательно, зелёный `make check` не достигнут; причина всех E2E-сбоев
не установлена. Среди ошибок есть несовпадение ожидаемого заголовка с
`Generated chat name`. Native adapter в основной бинарник ещё не подключён.

Полные логи текущего исследования (временные локальные файлы):
`/tmp/go-chamber-pi-probe.vQFTNE/native-check.log` и
`/tmp/go-chamber-pi-probe.vQFTNE/native-e2e-retry.log`.

## Проверка подписки и профиль OpenRouter — 2026-11-21

Device login успешно завершён в отдельное native-хранилище. Реальный запрос
через `native-probe -model gpt-6-luna` вернул `native transport works`:
13 input tokens, 7 output tokens, 0 cached input. Модель `gpt-5.3-codex`
отклонена backend как недоступная для ChatGPT account. Это не ошибка входа.
Реальный Codex SSE пришёл без Content-Type; этот вариант разрешён только для
Codex и закреплён `TestCodexAcceptsSSEWithoutContentType`.

OpenRouter выбирается явно через `-wire openrouter`, использует
`https://openrouter.ai/api/v1/chat/completions` и отдельный API key:

```sh
go run ./cmd/native-probe -data /path/to/isolated/native-data -wire openrouter -key-env OPENROUTER_API_KEY -model provider/model
```

`OPENROUTER_API_KEY` задаётся в окружении запускающей оболочки. Codex credentials
этому профилю не передаются. `provider/model` — точный ID из каталога OpenRouter;
это позволяет пользоваться моделями разных поставщиков через единый compatible
протокол без их собственных SDK. Подписка Codex не оплачивает OpenRouter.

Профиль переводит effort в `reasoning.effort`, принимает `reasoning`, сохраняет
opaque `reasoning_details` (включая encrypted blocks/signatures), объединяет
соседние текстовые дельты одного блока и возвращает их в следующий tool turn.
Replay привязан к endpoint/model/credentials; переключение ключа требует нового
контекста. Профиль и CLI проверены fake HTTP/SSE тестами и реальным запросом
OpenRouter (результат ниже). UI подключения ещё не реализован.

Источник контракта: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
и Pi `openai-completions.ts` (`appendOpenAIReasoningDetail`), с MIT attribution.

### Реальный OpenRouter smoke

2026-11-21: по разрешению пользователя ключ прочитан из API auth entry OpenCode
и передан только в окружение дочернего `native-probe`; значение не выводилось
и не копировалось в репозиторий. `openai/gpt-4.1-mini` вернула
`native transport works`: 14 input tokens, 4 output tokens, 0 cached input;
процесс завершился с кодом 0.

Первый вызов выявил повтор завершённого choice в пакете usage после finish.
`TestOpenRouterUsageTrailerAfterFinish` воспроизвёл ошибку до исправления;
теперь такой пакет принимается только без нового содержимого/tool calls и с
тем же finish reason. Тесты также запрещают поздний текст, изменение finish
и повтор без usage. `go test -race ./internal/adapters/openai ./cmd/native-probe`
и lint этих пакетов прошли. Полный E2E-прогон повторно не запускался;
ранее зафиксированные сбои общего `make check` остаются открытыми.

## Динамические каталоги моделей

Native `Client.ListModels` запрашивает модели у провайдера, без зашитого списка:
Codex — `/backend-api/codex/models?client_version=0.160.1`, OpenRouter —
`/api/v1/models`. Полученные wire-объекты преобразуются в существующий `app.ModelInfo`;
скрытые Codex-модели не показываются. Efforts Codex и поддержка изображений берутся
из ответа; отсутствующие у провайдера возможности не выдумываются.

`app.ModelCache` принадлежит одному профилю endpoint/account. На первом обращении
получает каталог, далее обновляет по TTL (по умолчанию 15 минут). Одновременные
обращения объединяются. При ошибке возвращает прежний список вместе с ошибкой,
`stale: true` и временем последнего успешного обновления; повтор — через минуту.
Принудительный refresh обходит TTL/backoff. Если успешного ответа ещё не было,
возвращается ошибка и пустой список. Кэш пока в памяти; после рестарта требуется
новый успешный запрос. При смене аккаунта/endpoint создаётся отдельный кэш.

Точка подключения при интеграции native runtime: model picker и создание новой
сессии вызывают `List(ctx, false)`, ручное обновление — `List(ctx, true)`.
В уже работающих сессиях модель сама не переключается. Фонового таймера пока нет:
без обращений к каталогу сеть не используется. Это реализованный сервис, но
основной session manager/UI пока на него не переключены.

Для живой проверки без inference:

```sh
go run ./cmd/native-probe -data /path/to/native-data -list-models
go run ./cmd/native-probe -data /path/to/native-data -wire openrouter -key-env OPENROUTER_API_KEY -list-models
```

2026-11-21 оба запроса проверены через Go-команду: Codex — 8 видимых моделей,
OpenRouter — 444. Эти числа — снимок, не ожидаемые константы тестов.
Проверено также: Codex без `client_version` возвращал HTTP 400, с `0.116.0` —
HTTP 200 и только скрытую `codex-auto-review`. С `0.160.1` пришёл видимый каталог.
Версия является параметром совместимости протокола (`Client.CatalogClientVersion`),
не вызовом установленного CLI. При изменении протокола её потребуется пересмотреть;
TTL обновляет доступный этой версии каталог и не гарантирует появление моделей,
требующих ещё более новой версии клиента.

Тесты: изменение/удаление моделей, TTL, forced refresh, stale fallback,
восстановление после первого отказа, отмена ожидания, 12 одновременных обращений,
различия каталогов, malformed/duplicate entries и запрет redirect с credentials.
Go race tests затронутых app/adapter/probe пакетов прошли; до дополнительных тестов
покрытие составляло app 93,3%, openai adapter 84,6%.

### Скиллы в меню `/`

Native предлагает локальные и пользовательские `SKILL.md` в автодополнении
команд. Имя команды — имя каталога скилла; `/имя` в начале сообщения выбирает
инструкции скилла, оставшийся текст задаёт задачу. Агент получает соответствие
команды и пути и читает файл инструментом `read`.

Меню и инструкции используют один каталог: сначала `.agents/skills`,
`.claude/skills`, `.codex/skills` рабочей папки, затем пользовательские
`~/.agents/skills`, `~/.codex/skills`, `~/.claude/skills`.
Первое совпадение имени побеждает; `/compact` зарезервирована.
Родительские каталоги скиллов автоматически не сканируются.

### Граница делегирования

Только основной Native-агент может вызывать `spawn_agent`. Субагенты выполняют
поручения самостоятельно: инструмент создания агентов им не предлагается,
а прямой вызов отклоняется по `Parent`/`Depth` сохранённого conversation.
Лимит четырёх одновременно работающих дочерних агентов сохраняется.
Старые вложенные сессии и история остаются доступны, но создавать новых
потомков они больше не могут. Управление уже существующими детьми
(`wait_agent`, `send_agent`, `stop_agent`) остаётся доступным.

`spawn_agent` по умолчанию синхронный: родитель ждёт завершения ребёнка и получает
его итоговый ответ как результат вызова. `background: true` возвращает ID сразу.
Когда фоновый ребёнок завершает ход, его результат приходит родителю сам: в идущий
ход — как дополнение к контексту, простаивающему родителю — новым ходом с пометкой,
что это автоматическое уведомление. Остановленный ребёнок родителя не будит;
`wait_agent` (окно 30 секунд) остаётся для явного ожидания. Если менеджер сессий не подключил
ребёнка за 30 секунд, синхронный вызов завершается ошибкой, а задача снимается.
Системный промпт корневого агента требует делать зависимые шаги самому и не давать
двум агентам править одни файлы.

### План

`update_plan` принимает весь план целиком (`step` + `pending` / `in_progress` /
`completed`) и необязательное пояснение. В транскрипте это один элемент `plan` на
ход, обновляемый на месте; отдельной строки вызова инструмента нет. Одобрения не
требует и до инструментов рабочего каталога не доходит.

### Цели

`/goal <цель>` запускает преследование цели внутри одного хода: когда модель
останавливается без вызовов инструментов, отдельный запрос-аудитор (та же модель,
без истории и инструментов, только цель и последний ответ) возвращает вердикт
`continue` / `complete` / `blocked`. При `continue` в контекст добавляется
промпт-продолжение, и ход идёт дальше. Агент сам свою работу завершённой не
объявляет.

| Команда | Действие |
|---|---|
| `/goal` | показать состояние |
| `/goal pause`, `/goal resume`, `/goal clear` | пауза, новый заход на ту же цель, удаление |
| `/goal budget <токены>` | бюджет токенов; `0` снимает |

Ограничители (`internal/domain/goal.go`): 20 продолжений на заход, бюджет токенов
(статус `budgetLimited`), `blocked` только после трёх вердиктов-блокеров подряд,
пауза после двух сбоев аудита подряд. Остановка хода, ошибка хода и перезапуск
процесса ставят цель на паузу: активной она бывает только пока идёт её ход. Команды
`/goal`, присланные во время хода, применяются к цели и в контекст модели не
попадают. Форк цель не наследует; у субагентов целей нет. Состояние хранится в
`Conversation.Goal`.

Аудитор по умолчанию — модель самой сессии. Флаг `-native-goal-auditor
provider:model` задаёт отдельную (обычно более дешёвую) модель для всех сессий.

Рантайм сообщает состояние цели событием `goal`; менеджер кладёт его в снимок
сессии (`goal`), шапка чата показывает чип с целью в подсказке. В SQLite снимок цели
не хранится: после перезапуска чип появляется, когда рантайм сессии подключается.

### Цели Codex

У Codex цели свои (`thread/goal/*`, проверено на app-server 0.160.1): `set` и
возобновление сразу запускают ход, следующие ходы Codex начинает сам, завершённой
цель объявляет модель. Адаптер только пересылает те же команды `/goal` и состояние:
`thread/goal/updated` / `cleared` становятся событием `goal`, а ход, начатый Codex
при активной цели, — `turn.started`. После прерывания Codex оставляет цель
`active`, но ходов не начинает, поэтому остановка хода явно ставит её на паузу.
Лимита продолжений и аудита у Codex нет; бюджет нельзя снять, только увеличить.
Эфемерные треды целей не поддерживают.
