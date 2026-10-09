---
name: mutation-testing
description: Пороги и подводные камни мутационного тестирования go-chamber (gremlins, Stryker, scripts/mutation-gate). Загружать перед make mutate / mutate-go / npm run mutate или правкой scripts/mutation-gate.
---

# Мутационное тестирование

Запускать только вручную (`make mutate`), по одному, когда больше ничего не гоняется.

## Пороги
- Go — `gremlins unleash --threshold-efficacy`: ≥ 80% для `domain` и `app`, ≥ 65% для адаптеров.
- TS — Stryker (`thresholds.break`): ≥ 70% для `src/stores` и `src/lib`.
- На изменённых пакетах при каждой фазе/PR, полностью — перед релизом.

## Подводные камни gremlins (проверено 2026-09-25)
- **gremlins и кэш сборки Go**: каждый мутант — отдельная сборка, полный `make mutate-go` раздувал
  `~/Library/Caches/go-build` до 16 ГБ и заполнял диск (падали сбор покрытия, git и сам shell).
  `scripts/mutation-gate` поэтому собирает в собственный временный `GOCACHE` и удаляет его на выходе.
- **gremlins** под `-race` по умолчанию репортит мутанты как TIMED OUT; `scripts/mutation-gate`
  поэтому использует `--timeout-coefficient 20 --workers 2`.
- **gremlins v0.6.0 игнорирует `--threshold-efficacy`** и всегда выходит с кодом 0 (пакет с
  эффективностью 33% «проходил» порог 65%). Поэтому `scripts/mutation-gate` сам разбирает строку
  `Test efficacy:` и сравнивает её с порогом; на код возврата gremlins не полагайся.
- **gremlins `--exclude-files`**: шаблоны сопоставляются с путём относительно каталога пакета
  (`^session_(darwin|linux)\.go$`, а не `adapters/pty/session_...`). Код, который шлёт сигналы
  по списку процессов, под мутации не отдавать: мутант в `pty/session_*.go` разослал SIGHUP
  чужим процессам пользователя и убил сам gremlins.
