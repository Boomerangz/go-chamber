// A colour scheme is a pair of palettes, one for each sheet. The default,
// Chamber, is the stylesheet's own and has no palette here; every other
// scheme is written onto the page's root as the same tokens the stylesheet
// declares, so nothing else in the app knows schemes exist.
export interface Palette {
  paper: string
  paper2: string
  paper3: string
  ink: string
  ink2: string
  ink3: string
  rule: string
  ruleStrong: string
  act: string
  actInk: string
  req: string
  bad: string
}

export interface Scheme {
  id: string
  name: string
  light: Palette
  dark: Palette
}

export const DEFAULT_SCHEME = 'chamber'

export const schemes: Scheme[] = [
  {
    id: 'nord',
    name: 'Nord',
    light: { paper: '#eceff4', paper2: '#e5e9f0', paper3: '#d8dee9', ink: '#2e3440', ink2: '#434c5e', ink3: '#586378', rule: '#d8dee9', ruleStrong: '#8892a6', act: '#3e6389', actInk: '#eceff4', req: '#8a5a00', bad: '#a8343f' },
    dark: { paper: '#2e3440', paper2: '#343b49', paper3: '#3b4252', ink: '#d8dee9', ink2: '#b4bccb', ink3: '#97a2b7', rule: '#434c5e', ruleStrong: '#6b7790', act: '#88c0d0', actInk: '#2e3440', req: '#ebcb8b', bad: '#e58791' },
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    light: { paper: '#fbf1c7', paper2: '#f2e5bc', paper3: '#ebdbb2', ink: '#3c3836', ink2: '#504945', ink3: '#665c54', rule: '#d5c4a1', ruleStrong: '#928374', act: '#076678', actInk: '#fbf1c7', req: '#8a5000', bad: '#9d0006' },
    dark: { paper: '#282828', paper2: '#32302f', paper3: '#3c3836', ink: '#ebdbb2', ink2: '#bdae93', ink3: '#a89984', rule: '#45403d', ruleStrong: '#7c6f64', act: '#83a598', actInk: '#282828', req: '#fabd2f', bad: '#ff6650' },
  },
  {
    id: 'solarized',
    name: 'Solarized',
    light: { paper: '#fdf6e3', paper2: '#eee8d5', paper3: '#e3dcc6', ink: '#073642', ink2: '#42585f', ink3: '#586d74', rule: '#e6dfc8', ruleStrong: '#93a1a1', act: '#1d6aa5', actInk: '#fdf6e3', req: '#7d5a00', bad: '#bd2f2a' },
    dark: { paper: '#002b36', paper2: '#073642', paper3: '#0d4250', ink: '#9fb0b0', ink2: '#93a1a1', ink3: '#7e9296', rule: '#124855', ruleStrong: '#586e75', act: '#4aa3e0', actInk: '#002b36', req: '#d4a017', bad: '#ee7570' },
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    light: { paper: '#eff1f5', paper2: '#e6e9ef', paper3: '#ccd0da', ink: '#4c4f69', ink2: '#5c5f77', ink3: '#656880', rule: '#dce0e8', ruleStrong: '#9ca0b0', act: '#1a5ae0', actInk: '#eff1f5', req: '#8f5400', bad: '#c40d35' },
    dark: { paper: '#1e1e2e', paper2: '#181825', paper3: '#313244', ink: '#cdd6f4', ink2: '#bac2de', ink3: '#9399b2', rule: '#2a2b3c', ruleStrong: '#6c7086', act: '#89b4fa', actInk: '#1e1e2e', req: '#f9e2af', bad: '#f38ba8' },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    light: { paper: '#e1e2e7', paper2: '#d5d6db', paper3: '#c4c8da', ink: '#343b58', ink2: '#40476a', ink3: '#4d5578', rule: '#c8cad3', ruleStrong: '#8990b3', act: '#1f58c8', actInk: '#e1e2e7', req: '#7d5210', bad: '#b53048' },
    dark: { paper: '#1a1b26', paper2: '#16161e', paper3: '#292e42', ink: '#c0caf5', ink2: '#a9b1d6', ink3: '#8089b3', rule: '#24283b', ruleStrong: '#565f89', act: '#7aa2f7', actInk: '#1a1b26', req: '#e0af68', bad: '#f7768e' },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    light: { paper: '#fffbeb', paper2: '#f5f0dc', paper3: '#ebe5cc', ink: '#1f1f1f', ink2: '#3d3d3a', ink3: '#5c5744', rule: '#e3dcc2', ruleStrong: '#9a9376', act: '#644ac9', actInk: '#fffbeb', req: '#7a5300', bad: '#cb3a2a' },
    dark: { paper: '#282a36', paper2: '#21222c', paper3: '#343746', ink: '#f8f8f2', ink2: '#c9cad6', ink3: '#9ea3c0', rule: '#3a3d4f', ruleStrong: '#6272a4', act: '#bd93f9', actInk: '#282a36', req: '#ffb86c', bad: '#ff7b7b' },
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    light: { paper: '#faf4ed', paper2: '#f2e9e1', paper3: '#e8dfd6', ink: '#575279', ink2: '#5d5880', ink3: '#6e6a86', rule: '#e6dcd2', ruleStrong: '#9893a5', act: '#6b4f9a', actInk: '#faf4ed', req: '#8f5509', bad: '#a8405f' },
    dark: { paper: '#191724', paper2: '#1f1d2e', paper3: '#26233a', ink: '#e0def4', ink2: '#c4c1da', ink3: '#908caa', rule: '#2a2740', ruleStrong: '#6e6a86', act: '#c4a7e7', actInk: '#191724', req: '#f6c177', bad: '#eb6f92' },
  },
]

export function findScheme(id: string): Scheme | undefined {
  return schemes.find((s) => s.id === id)
}

const chevron = (ink3: string) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none' stroke='%23${ink3.slice(1)}' stroke-width='1.5'%3E%3Cpath d='M1 1l4 4 4-4'/%3E%3C/svg%3E")`

const wash = (colour: string, percent: number) => `color-mix(in srgb, ${colour} ${percent}%, transparent)`

// tokens maps a palette to the custom properties the stylesheet declares.
export function tokens(p: Palette): Record<string, string> {
  return {
    '--paper': p.paper,
    '--paper-2': p.paper2,
    '--paper-3': p.paper3,
    '--ink': p.ink,
    '--ink-2': p.ink2,
    '--ink-3': p.ink3,
    '--rule': p.rule,
    '--rule-strong': p.ruleStrong,
    '--act': p.act,
    '--act-ink': p.actInk,
    '--act-wash': wash(p.act, 12),
    '--act-ring': wash(p.act, 55),
    '--req': p.req,
    '--req-mark': p.req,
    '--req-wash': wash(p.req, 10),
    '--bad': p.bad,
    '--bad-wash': wash(p.bad, 10),
    '--chevron': chevron(p.ink3),
  }
}
