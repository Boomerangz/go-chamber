import type { Terminal } from '../../lib/terminal'
import type { ConnState } from '../../stores/terminals'

// A terminal's state is the form of its square mark: solid while the shell
// runs and is attached, dashed while the connection is being made, struck
// once the connection is lost or the shell has exited.
export type MarkForm = 'running' | 'pending' | 'struck'

export function markOf(t: Terminal, conn?: ConnState): { form: MarkForm; label: string } {
  if (t.status === 'exited') return { form: 'struck', label: `exited ${t.exitCode}` }
  switch (conn?.state) {
    case 'connecting':
    case 'reconnecting':
      return { form: 'pending', label: conn.state }
    case 'disconnected':
      return { form: 'struck', label: 'disconnected' }
    default:
      return { form: 'running', label: 'running' }
  }
}

// sortForSession lists the terminals opened for the session first.
export function sortForSession(terminals: Terminal[], sessionId: string | null): Terminal[] {
  if (!sessionId) return terminals
  return [...terminals.filter((t) => t.sessionId === sessionId), ...terminals.filter((t) => t.sessionId !== sessionId)]
}
