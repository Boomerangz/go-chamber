import type { SessionEvent } from './api'
import { chimesHere, watchingHere } from './presence'

// Chimes are short synthesized tones, off unless the owner turns them on: a
// rising pair when an agent needs a decision, one soft note when a turn ends.
export type Chime = 'request' | 'done'

const KEY = 'gc.sound'
const BURST_MS = 600

export function soundOn(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on'
  } catch {
    return false
  }
}

export function setSoundOn(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    // storage unavailable: the setting lasts for this page only
  }
}

export function chimeFor(ev: SessionEvent): Chime | null {
  if (ev.type === 'request.opened') return 'request'
  if (ev.type === 'turn.ended') return 'done'
  return null
}

let ctx: AudioContext | null = null
let last = -Infinity

// play sounds a chime; several sessions finishing at once make one sound.
export function play(chime: Chime): void {
  const now = Date.now()
  if (now - last < BURST_MS) return
  if (typeof AudioContext === 'undefined') return
  last = now
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
  const notes = chime === 'request' ? [659.25, 880] : [587.33]
  notes.forEach((freq, i) => tone(ctx!, freq, ctx!.currentTime + i * 0.11))
}

function tone(ctx: AudioContext, freq: number, at: number) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, at)
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.linearRampToValueAtTime(0.08, at + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(at)
  osc.stop(at + 0.4)
}

// chimeOnEvent sounds on one page only: the one the owner was at last, on
// whichever device; and on a focused page showing that very session, which
// is where they look.
export function chimeOnEvent(ev: SessionEvent): void {
  const chime = chimeFor(ev)
  if (chime && soundOn() && (chimesHere() || watchingHere(ev.sessionId))) play(chime)
}
