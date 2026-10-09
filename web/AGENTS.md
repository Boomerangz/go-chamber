# Подводные камни web-тулинга (проверено 2026-09-25)

- **Stryker + vitest**: `@stryker-mutator/vitest-runner@10.0.0` с vitest 5 не активирует мутанты,
  и все они «выживают» (скор 0%). Поэтому vitest зафиксирован на `^4`; перед обновлением
  проверь, что `npm run mutate` даёт ненулевой скор.
- **Stryker `tempDirName`** нельзя класть внутрь `node_modules`: vitest не ищет там тесты,
  получится «No tests were executed».
- **Node 22+ и `localStorage` в vitest**: у Node свой глобальный `localStorage`, без
  `--localstorage-file` он `undefined` и перекрывает jsdom (`sessionStorage` при этом работает).
  `src/test/setup.ts` подставляет хранилище в памяти.
