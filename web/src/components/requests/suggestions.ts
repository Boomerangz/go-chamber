// describeSuggestions says what "Allow for session" would add, from the
// permission_suggestions Claude sends with a permission request: rules such
// as Bash(npm test:*), a permission mode, or extra directories.
export function describeSuggestions(suggestions: unknown): string[] {
  if (!Array.isArray(suggestions)) return []
  const out: string[] = []
  for (const s of suggestions) {
    if (!s || typeof s !== 'object') continue
    const { type, rules, mode, directories } = s as Record<string, unknown>
    if ((type === 'addRules' || type === 'replaceRules') && Array.isArray(rules)) {
      const names = rules.map(ruleName).filter((r): r is string => !!r)
      if (names.length) out.push(`${names.length === 1 ? 'adds rule' : 'adds rules'}: ${names.join(', ')}`)
    } else if (type === 'setMode' && typeof mode === 'string') {
      out.push(`sets mode: ${mode}`)
    } else if (type === 'addDirectories' && Array.isArray(directories)) {
      const dirs = directories.filter((d): d is string => typeof d === 'string')
      if (dirs.length) out.push(`${dirs.length === 1 ? 'adds directory' : 'adds directories'}: ${dirs.join(', ')}`)
    }
  }
  return out
}

function ruleName(rule: unknown): string | undefined {
  if (!rule || typeof rule !== 'object') return undefined
  const { toolName, ruleContent } = rule as Record<string, unknown>
  if (typeof toolName !== 'string' || !toolName) return undefined
  return typeof ruleContent === 'string' && ruleContent ? `${toolName}(${ruleContent})` : toolName
}
