import type { SessionRequest } from '../../lib/api'

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

// requestGist says in one line what a request asks: the command to run, the
// file to change, the question; its generic title ("Run command",
// "Question") only when nothing more telling is known.
export function requestGist(r: SessionRequest): string {
  const input = r.payload?.input
  const questions = input?.questions ?? []
  const first = questions[0]?.question
  if (first?.trim()) return questions.length > 1 ? `${flat(first)} (+${questions.length - 1} more)` : flat(first)
  if (typeof input?.command === 'string' && input.command.trim()) return flat(input.command)
  const file = typeof input?.file_path === 'string' ? input.file_path : typeof input?.path === 'string' ? input.path : ''
  if (file.trim()) {
    const name = file.replace(/\/+$/, '').split('/').pop() || file
    return r.payload?.toolName ? `${r.payload.toolName} ${name}` : name
  }
  for (const text of [r.prompt, r.title, r.payload?.toolName]) if (text?.trim()) return flat(text)
  return 'Request'
}
