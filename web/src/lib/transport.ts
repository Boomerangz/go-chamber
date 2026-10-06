// Terminals upgrade to a direct WebRTC channel unless this device turns it
// off: from some networks it is no faster than the WebSocket through the
// server, and much slower for bulk output.
const KEY = 'gc.terminal.rtc'

let fallback = true
const listeners = new Set<(on: boolean) => void>()

export function rtcEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return fallback
  }
}

export function setRTCEnabled(on: boolean): void {
  fallback = on
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    // storage unavailable: the setting lasts for this page only
  }
  for (const listener of listeners) listener(on)
}

// onRTCChange calls listener with each new setting until the returned
// function is called.
export function onRTCChange(listener: (on: boolean) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
