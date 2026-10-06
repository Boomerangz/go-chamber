import type { ISearchOptions } from '@xterm/addon-search'
import type { ITheme } from '@xterm/xterm'

// TokenReader returns the current value of a CSS custom property, or '' when
// it is not set (tests, a page without the stylesheet).
export type TokenReader = (name: string) => string

function pageTokens(): TokenReader {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return () => ''
  const style = getComputedStyle(document.documentElement)
  return (name) => style.getPropertyValue(name).trim()
}

// The tokens' values when the stylesheet is not there to read.
const fallback = {
  dark: { paper: '#0f1012', ink: '#e4e2dc', act: '#8c98ff', bad: '#f07a6a', paper3: '#1e2023', rule: '#2a2c30', ruleStrong: '#5e6066' },
  light: { paper: '#f3f3f1', ink: '#16171a', act: '#2433d6', bad: '#b3261e', paper3: '#dfdfda', rule: '#d3d3cd', ruleStrong: '#8c8c86' },
}

// searchDecorations marks scrollback matches in the sheet's quiet tones and
// the current one with the focus colour's border. On the dark sheet each
// mark is one tone stronger: its deep paper sits too close to the sheet.
export function searchDecorations(dark: boolean, token: TokenReader = pageTokens()): ISearchOptions['decorations'] {
  const base = dark ? fallback.dark : fallback.light
  const paper3 = token('--paper-3') || base.paper3
  const rule = token('--rule') || base.rule
  const ruleStrong = token('--rule-strong') || base.ruleStrong
  const act = token('--act') || base.act
  return {
    matchBackground: dark ? rule : paper3,
    matchOverviewRuler: ruleStrong,
    activeMatchBackground: dark ? ruleStrong : rule,
    activeMatchBorder: act,
    activeMatchColorOverviewRuler: act,
  }
}

// terminalTheme prints the terminal in the page's ink: the sheet, ink,
// accent and failure red come from the page tokens, so the terminal follows
// the design; the other ANSI colours are tuned for each sheet. Yellow leans
// green of the "needs you" amber so shell output never reads as a request.
export function terminalTheme(dark: boolean, token: TokenReader = pageTokens()): ITheme {
  const base = dark ? fallback.dark : fallback.light
  const paper = token('--paper') || base.paper
  const ink = token('--ink') || base.ink
  const act = token('--act') || base.act
  const bad = token('--bad') || base.bad
  if (dark) {
    return {
      background: paper,
      foreground: ink,
      cursor: act,
      cursorAccent: paper,
      selectionBackground: 'rgba(140, 152, 255, 0.28)',
      black: '#34363b',
      red: bad,
      green: '#8fc27a',
      yellow: '#d6c45a',
      blue: '#8c98ff',
      magenta: '#c79bdc',
      cyan: '#6fc0c6',
      white: ink,
      brightBlack: '#6b6d73',
      brightRed: '#ff9a8b',
      brightGreen: '#a9d894',
      brightYellow: '#ecdc7e',
      brightBlue: '#aab3ff',
      brightMagenta: '#dcb6ec',
      brightCyan: '#8fd6db',
      brightWhite: '#ffffff',
    }
  }
  return {
    background: paper,
    foreground: ink,
    cursor: act,
    cursorAccent: paper,
    selectionBackground: 'rgba(36, 51, 214, 0.18)',
    black: ink,
    red: bad,
    green: '#2f6f2a',
    yellow: '#6f6300',
    blue: '#2433d6',
    magenta: '#7a2f8f',
    cyan: '#11636b',
    white: '#8d8f95',
    brightBlack: '#5e6066',
    brightRed: '#d0342b',
    brightGreen: '#3b8a35',
    brightYellow: '#857700',
    brightBlue: '#4050e8',
    brightMagenta: '#9340ab',
    brightCyan: '#167a84',
    brightWhite: '#44464c',
  }
}
