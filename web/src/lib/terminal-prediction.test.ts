import { expect, it } from 'vitest'
import { TerminalPrediction } from './terminal-prediction'

it('predicts only after confirmed prompt, matching echo and high RTT', () => {
  const p = new TerminalPrediction(() => {})
  p.rtt(50); p.input('secret'); expect(p.view().text).toBe('')
  p.prompt(1, true); p.input('a'); expect(p.view().text).toBe('')
  p.output('a'); p.input('b'); expect(p.view().text).toBe('b')
  p.rtt(25); expect(p.view().text).toBe('b')
  p.rtt(19); expect(p.view().text).toBe('')
  p.rtt(31); expect(p.view().text).toBe('b')
  p.input('\x7f'); expect(p.view().text).toBe('')
  p.output('b\b \b'); expect(p.view().text).toBe('')
})
it('never predicts passwords or TUIs after Enter; a stale prompt cannot re-enable it', () => {
  const p = new TerminalPrediction(() => {})
  p.rtt(50); p.prompt(1, true); p.input('a'); p.output('a')
  p.input('\r'); p.prompt(1, true); p.input('password'); p.output('Password: ')
  expect(p.view().text).toBe('')
  p.prompt(2, true); p.input('x'); p.output('x'); p.input('y'); expect(p.view().text).toBe('y')
  p.output('unexpected'); expect(p.view().text).toBe('')
  p.prompt(2, true); p.input('z'); expect(p.view().text).toBe('')
})
it('clears predictions on paste, control keys, resize/disconnect and ownership change', () => {
  for (const input of ['paste text', '\x1b[A', '\x03']) {
    const p = new TerminalPrediction(() => {})
    p.rtt(50); p.prompt(1, true); p.input('a'); p.output('a'); p.input('b')
    p.input(input); expect(p.view().text).toBe('')
  }
  const p = new TerminalPrediction(() => {})
  p.prompt(1, true); p.rtt(50); p.input('a'); p.output('a'); p.input('b'); p.reset()
  expect(p.view().text).toBe('')
})
it('does not accept a queued old prompt after blind Enter or password input', () => {
  const p = new TerminalPrediction(() => {})
  p.rtt(80); p.prompt(1, true, 0); p.input('\r'); p.input('\r')
  p.prompt(2, true, 1); p.input('p'); p.output('p'); p.input('a')
  expect(p.view().text).toBe('')
  p.prompt(3, true, 2); p.input('x'); p.output('x'); p.input('y')
  expect(p.view().text).toBe('y')
})
it('predicts Backspace over confirmed simple echo without crossing the prompt', () => {
  const p = new TerminalPrediction(() => {})
  p.rtt(80); p.prompt(1, true); p.input('a'); p.output('a')
  p.input('\x7f'); expect(p.view()).toEqual({text: ' ', offset: -1})
  p.output('\b \b'); expect(p.view()).toEqual({text: '', offset: 0})
  p.input('\x7f'); expect(p.view().text).toBe('')
})
