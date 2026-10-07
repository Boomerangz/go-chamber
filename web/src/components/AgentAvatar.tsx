import type { AgentKind } from '../lib/api'

// Agents are peers: a letter in a box, same weight for both.
export default function AgentAvatar({ agent }: { agent: AgentKind }) {
  return (
    <span className={`avatar avatar-${agent}`} aria-hidden="true">
      {agent === 'claude' ? 'C' : agent === 'opencode' ? 'O' : 'X'}
    </span>
  )
}
