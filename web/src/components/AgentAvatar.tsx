import type { AgentKind } from '../lib/api'

// Distinct silhouettes remain recognizable even without colour.
export default function AgentAvatar({ agent, small = false }: { agent: AgentKind; small?: boolean }) {
  return (
    <span className={`avatar ${small ? 'avatar-sm ' : ''}avatar-${agent}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="currentColor" focusable="false">
        {agent === 'native' ? <path d="M4 20V4h4l8 11V4h4v16h-4L8 9v11z" /> : agent === 'claude' ? <path d="M12 1.5 13.8 7l4-4-1.4 5.5 5.5-1.4-4 4L23 13l-5.5 1.5 4 4-5.5-1.4 1.4 5.5-4-4L12 24l-1.8-5.4-4 4 1.4-5.5-5.5 1.4 4-4L.5 13l5.6-1.9-4-4 5.5 1.4L6.2 3l4 4z" /> : agent === 'codex' ? <path fillRule="evenodd" d="M12 2 21 7v10l-9 5-9-5V7zm0 3.1L6 8.4v7.2l6 3.3 6-3.3V8.4zm0 2.3 3.9 2.2v4.8L12 16.6l-3.9-2.2V9.6z" /> : <path d="M3 4h8v8H3zm10 0h8v8h-8zM3 14h8v6H3zm10 0h8v6h-8z" />}
      </svg>
    </span>
  )
}
