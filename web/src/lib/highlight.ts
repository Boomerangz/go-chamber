import { createHighlighterCore, type HighlighterCore, type ThemedToken } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

let highlighter: Promise<HighlighterCore> | undefined

// ponytail: a fixed set of common grammars keeps ~8 MB of shiki langs out of the embedded binary; add entries as needed.
const grammars: Record<string, () => Promise<unknown>> = {
  'bash': () => import('shiki/langs/bash.mjs'),
  'c': () => import('shiki/langs/c.mjs'),
  'cpp': () => import('shiki/langs/cpp.mjs'),
  'css': () => import('shiki/langs/css.mjs'),
  'diff': () => import('shiki/langs/diff.mjs'),
  'dockerfile': () => import('shiki/langs/dockerfile.mjs'),
  'go': () => import('shiki/langs/go.mjs'),
  'graphql': () => import('shiki/langs/graphql.mjs'),
  'html': () => import('shiki/langs/html.mjs'),
  'ini': () => import('shiki/langs/ini.mjs'),
  'java': () => import('shiki/langs/java.mjs'),
  'javascript': () => import('shiki/langs/javascript.mjs'),
  'json': () => import('shiki/langs/json.mjs'),
  'jsonc': () => import('shiki/langs/jsonc.mjs'),
  'jsx': () => import('shiki/langs/jsx.mjs'),
  'kotlin': () => import('shiki/langs/kotlin.mjs'),
  'lua': () => import('shiki/langs/lua.mjs'),
  'makefile': () => import('shiki/langs/makefile.mjs'),
  'markdown': () => import('shiki/langs/markdown.mjs'),
  'php': () => import('shiki/langs/php.mjs'),
  'proto': () => import('shiki/langs/proto.mjs'),
  'python': () => import('shiki/langs/python.mjs'),
  'ruby': () => import('shiki/langs/ruby.mjs'),
  'rust': () => import('shiki/langs/rust.mjs'),
  'sql': () => import('shiki/langs/sql.mjs'),
  'swift': () => import('shiki/langs/swift.mjs'),
  'toml': () => import('shiki/langs/toml.mjs'),
  'tsx': () => import('shiki/langs/tsx.mjs'),
  'typescript': () => import('shiki/langs/typescript.mjs'),
  'xml': () => import('shiki/langs/xml.mjs'),
  'yaml': () => import('shiki/langs/yaml.mjs'),
}
const aliases: Record<string, string> = {
  'ts': 'typescript',
  'js': 'javascript',
  'py': 'python',
  'sh': 'bash',
  'shell': 'bash',
  'zsh': 'bash',
  'shellscript': 'bash',
  'yml': 'yaml',
  'md': 'markdown',
  'rs': 'rust',
  'kt': 'kotlin',
  'c++': 'cpp',
  'docker': 'dockerfile',
  'make': 'makefile',
  'rb': 'ruby',
  'protobuf': 'proto',
}

// tokenize colours code for both sheets (--shiki-light / --shiki-dark);
// grammars load on first use. Unknown languages resolve to undefined.
export async function tokenize(code: string, lang: string): Promise<ThemedToken[][] | undefined> {
  const lower = lang.toLowerCase()
  const id = aliases[lower] ?? lower
  const load = grammars[id]
  if (!load) return undefined
  highlighter ??= createHighlighterCore({
    themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  })
  const h = await highlighter
  if (!h.getLoadedLanguages().includes(id)) {
    await h.loadLanguage((await load()) as Parameters<HighlighterCore['loadLanguage']>[0])
  }
  return h.codeToTokens(code, {
    lang: id,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  }).tokens
}
