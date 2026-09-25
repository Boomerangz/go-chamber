# Ручной smoke на настоящих CLI

Перед релизом и после обновления `claude`/`codex`. Тратит немного подписки.

```bash
make build
mkdir -p /tmp/gc-smoke/{data,proj} && echo smoke > /tmp/gc-smoke/data/token
git -C /tmp/gc-smoke/proj init
./bin/go-chamber -addr 127.0.0.1:7799 -data /tmp/gc-smoke/data
# http://127.0.0.1:7799/?token=smoke
```

## Чек-лист

| # | Сценарий | Ожидание |
|---|---|---|
| 1 | Claude: новая сессия в `/tmp/gc-smoke/proj`, «Reply with exactly one word: pong» | стрим, ответ `pong`, `nativeId` сохранён, статус `idle`, полоса квоты |
| 2 | Claude: «Create hello.txt … Use the Write tool» | карточка разрешения + лоток; Allow → файл создан |
| 3 | Claude: «Use AskUserQuestion … Red or Blue» | карточка вопроса; выбор → ответ с выбранным вариантом |
| 4 | `kill -9` процесса `claude` посреди хода | статус `interrupted` (`crashed`) |
| 5 | Новое сообщение после п.4 | процесс поднят с `--resume <тот же id>`, контекст помнит п.1 |
| 6 | Codex: новая сессия, «pong» | стрим, ответ, квота и аккаунт |
| 7 | Codex: команда, требующая сети (`curl -sI https://example.com`) | запрос одобрения; Allow → команда выполнена |
| 8 | Codex: Stop посреди хода | статус `idle` |
| 8a | Codex: «Approvals: ask me», затем команда с сетью | карточка одобрения, даже если в конфиге `auto_review` |
| 8b | Codex: «Approvals: auto-review», новый ход с той же командой | запроса нет, команда выполнена |
| 9 | Терминал: New terminal, `echo $0 $TERM` | shell пользователя, `xterm-256color` |

## Прогон 2026-09-25 (claude 2.1.282, codex 0.153.0)

Все 9 пунктов прошли после двух исправлений адаптера Claude (найдены этим прогоном):
ожидание `system/init` до первого сообщения (сессия не стартовала вообще) и
`--permission-prompts host` вместо `--permission-prompt-tool stdio` (разрешения молча
отклонялись). Codex 0.153.0 не принимал `model = "gpt-6-sol"` с ChatGPT-аккаунтом (падал и
сам `codex exec`); в 0.157.0 это исправлено, ход через go-chamber проходит без обёрток, схема
сверена (`scripts/codex-schema-check`). Для п.7 выберите «Approvals: ask me» в шапке чата:
при `auto_review` эскалации одобряет ревьюер Codex и карточка в go-chamber не появляется.
Переключатель действует со следующего хода (п.8a/8b проверены на codex 0.157.0).

Замечено, но не исправлено:
- история чата не переживает перезапуск go-chamber — элементы не сохраняются в SQLite;
- карточка одобрения изменения файла Codex не показывает путь: в запросе его нет, он в
  элементе `fileChange`, пришедшем раньше;
- глобальные Stop-хуки пользователя (`~/.claude`, `~/.codex`) срабатывают и в сессиях
  go-chamber и добавляют к ходу второй, служебный ответ.
