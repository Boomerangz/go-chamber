import { createHighlighterCore, type HighlighterCore, type ThemedToken } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages, bundledLanguagesAlias } from 'shiki/langs'

let highlighter: Promise<HighlighterCore> | undefined

// tokenize colours code for both sheets (--shiki-light / --shiki-dark);
// grammars load on first use. Unknown languages resolve to undefined.
export async function tokenize(code: string, lang: string): Promise<ThemedToken[][] | undefined> {
  const id = lang.toLowerCase()
  const known = (bundledLanguagesAlias as Record<string, unknown>)[id] ?? (bundledLanguages as Record<string, unknown>)[id]
  if (!known) return undefined
  highlighter ??= createHighlighterCore({
    themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  })
  const h = await highlighter
  if (!h.getLoadedLanguages().includes(id)) {
    await h.loadLanguage(known as Parameters<HighlighterCore['loadLanguage']>[0])
  }
  return h.codeToTokens(code, {
    lang: id,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  }).tokens
}
