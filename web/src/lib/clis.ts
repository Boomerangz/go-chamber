import { create } from 'zustand'
import { listAgents, type AgentKind, type CLIStatus, type AgentCapabilities } from './api'

// useCLIs knows which agent CLIs the server found on its PATH, so the
// new-session form offers only agents that can start. Until the server
// answers (or when it can't), every CLI is assumed to be there: the server
// still refuses a missing one in plain words.
interface CLIs {
  clis: CLIStatus[]
  load: () => Promise<void>
}

export const useCLIs = create<CLIs>((set) => ({
  clis: [],
  load: async () => {
    try {
      set({ clis: await listAgents() })
    } catch {
      // keep what was known
    }
  },
}))

export function missingCLIs(clis: CLIStatus[]): AgentKind[] {
  return clis.filter((c) => !c.found).map((c) => c.agent)
}

// cliMissingText is the server's own sentence for a missing CLI.
export function cliMissingText(status: CLIStatus): string {
  const name = status.name ?? (status.agent === 'claude' ? 'Claude Code' : status.agent === 'opencode' ? 'OpenCode' : 'Codex')
  return `${name} CLI not found on PATH${status.hint ? `. Install it with ${status.hint}` : ''}`
}

export function resetCLIs(): void {
  useCLIs.setState({ clis: [] })
}

export function useCapabilities(agent: AgentKind): AgentCapabilities {
  const caps = useCLIs((s) => s.clis.find((c) => c.agent === agent)?.capabilities)
  return caps ?? { steer: true, images: true, fork: true, subagents: true, permissionModes: agent !== 'opencode', approvalReviewer: agent === 'codex', login: agent === 'codex', quotas: agent !== 'opencode', historyImport: agent !== 'opencode' }
}
