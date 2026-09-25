import type { ITheme } from '@xterm/xterm'

// terminalTheme prints the terminal in the page's ink: the same sheet, ink
// and accent as the rest of the UI, with ANSI colours tuned for each sheet.
export function terminalTheme(dark: boolean): ITheme {
  if (dark) {
    return {
      background: '#0f1012',
      foreground: '#e4e2dc',
      cursor: '#8c98ff',
      cursorAccent: '#0f1012',
      selectionBackground: 'rgba(140, 152, 255, 0.28)',
      black: '#34363b',
      red: '#f07a6a',
      green: '#8fc27a',
      yellow: '#e3a33a',
      blue: '#8c98ff',
      magenta: '#c79bdc',
      cyan: '#6fc0c6',
      white: '#e4e2dc',
      brightBlack: '#6b6d73',
      brightRed: '#ff9a8b',
      brightGreen: '#a9d894',
      brightYellow: '#f2bd5c',
      brightBlue: '#aab3ff',
      brightMagenta: '#dcb6ec',
      brightCyan: '#8fd6db',
      brightWhite: '#ffffff',
    }
  }
  return {
    background: '#f3f3f1',
    foreground: '#16171a',
    cursor: '#2433d6',
    cursorAccent: '#f3f3f1',
    selectionBackground: 'rgba(36, 51, 214, 0.18)',
    black: '#16171a',
    red: '#b3261e',
    green: '#2f6f2a',
    yellow: '#8a5200',
    blue: '#2433d6',
    magenta: '#7a2f8f',
    cyan: '#11636b',
    white: '#8d8f95',
    brightBlack: '#5e6066',
    brightRed: '#d0342b',
    brightGreen: '#3b8a35',
    brightYellow: '#a86400',
    brightBlue: '#4050e8',
    brightMagenta: '#9340ab',
    brightCyan: '#167a84',
    brightWhite: '#44464c',
  }
}
