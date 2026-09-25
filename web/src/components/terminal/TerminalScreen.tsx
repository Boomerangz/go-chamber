import { useTerminalStore } from '../../stores/terminals'
import TerminalView from './TerminalView'

// TerminalScreen attaches the active terminal. Only one is mounted at a
// time: every attached view answers the shell's terminal queries.
export default function TerminalScreen({ id }: { id: string }) {
  const focusId = useTerminalStore((s) => s.focusId)
  const load = useTerminalStore((s) => s.load)
  const markExited = useTerminalStore((s) => s.markExited)
  return (
    <div className="terminal-panel" id="terminal-panel" role="tabpanel" aria-labelledby={`terminal-tab-${id}`}>
      <TerminalView
        key={id}
        id={id}
        autoFocus={id === focusId}
        onExit={(code) => markExited(id, code)}
        onDisconnect={() => void load()}
      />
    </div>
  )
}
