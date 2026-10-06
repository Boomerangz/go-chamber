import { describeError, lastError } from '../../stores/notices'

// notSent is the inline line under an answer that didn't go through. The
// store already raised a notice; this keeps the reason next to the request.
// A thrown error names itself; a refused answer (false) takes the store's
// latest error notice.
export function notSent(err?: unknown): string {
  const reason = err !== undefined ? describeError(err) : lastError()
  return reason ? `Not sent: ${reason}` : 'Not sent'
}

// answerKey is the shortcut a key press means on a permission, if any.
export function shortcut(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): 'a' | 's' | 'd' | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null
  const key = e.key.toLowerCase()
  return key === 'a' || key === 's' || key === 'd' ? key : null
}
