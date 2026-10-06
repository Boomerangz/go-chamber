import { useSyncExternalStore } from 'react'

// Whether code blocks wrap long lines: one choice for every block, kept per
// browser.

const KEY = 'gc.code-wrap'
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

let wrap = read()

export function setCodeWrap(next: boolean): void {
  wrap = next
  try {
    if (next) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
    // Storage may be blocked; the choice lasts for this page.
  }
  listeners.forEach((l) => l())
}

// resetCodeWrap rereads the stored choice; used by tests.
export function resetCodeWrap(): void {
  wrap = read()
  listeners.forEach((l) => l())
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useCodeWrap(): boolean {
  return useSyncExternalStore(subscribe, () => wrap)
}
