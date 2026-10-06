import { useSyncExternalStore } from 'react'
import { listFolders } from './api'

// The server's home folder, asked once (the folder listing carries it), so
// paths can read "~/…". Unknown until it arrives, or while it can't.
let home: string | undefined
let asking = false
const listeners = new Set<() => void>()

function ask() {
  if (home !== undefined || asking) return
  asking = true
  Promise.resolve()
    .then(() => listFolders())
    .then((l) => {
      home = l.home || undefined
      listeners.forEach((f) => f())
    })
    .catch(() => {})
    .finally(() => {
      asking = false
    })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  ask()
  return () => listeners.delete(listener)
}

export function useHome(): string | undefined {
  return useSyncExternalStore(subscribe, () => home)
}

// resetHome forgets the home folder (tests).
export function resetHome() {
  home = undefined
  asking = false
  listeners.clear()
}
