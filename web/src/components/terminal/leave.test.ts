import { afterEach, describe, expect, it } from 'vitest'
import { leaveTerminal } from './leave'

afterEach(() => {
  document.body.innerHTML = ''
})

function terminal(): HTMLTextAreaElement {
  const box = document.createElement('div')
  box.className = 'xterm'
  const input = document.createElement('textarea')
  box.append(input)
  document.body.append(box)
  input.focus()
  return input
}

describe('leaveTerminal', () => {
  it('takes the focus to the composer when a chat shows one', () => {
    const form = document.createElement('form')
    form.className = 'composer'
    const composer = document.createElement('textarea')
    form.append(composer)
    document.body.append(form)
    terminal()
    leaveTerminal()
    expect(document.activeElement).toBe(composer)
  })

  it('leaves the terminal for nowhere without a composer, so single keys answer', () => {
    const input = terminal()
    expect(document.activeElement).toBe(input)
    leaveTerminal()
    expect(document.activeElement).toBe(document.body)
  })
})
