# Подводные камни Codex app-server (проверено 2026-09-25)

- **Codex app-server (0.157.0)**: хуки приходят как `hook/started` / `hook/completed`
  (`run.status`: completed/blocked/failed/stopped, `run.entries[].text`); id прогона повторяется.
  Codex сам присылает `userMessage` на каждое сообщение пользователя — для своих сессий его
  не показываем (go-chamber записывает сообщение сам).
