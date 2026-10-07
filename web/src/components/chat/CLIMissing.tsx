import { Copy } from 'lucide-react'
import type { CLIStatus } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { useCLIs } from '../../lib/clis'
import { usePending } from '../../lib/pending'
import { notify } from '../../stores/notices'
import { icon } from '../icon'
import GoneNote from '../ui/GoneNote'

const agentName = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' } as const

// CLIMissing stands where the composer was while the session's agent CLI
// is not on go-chamber's PATH: no turn can start, so it says how to install
// the CLI (a command to copy) and checks again once that is done. Laid out
// like FolderGone.
export default function CLIMissing({ cli }: { cli: CLIStatus }) {
  const load = useCLIs((s) => s.load)
  const [check, checking] = usePending(load)
  const name = agentName[cli.agent]
  const copy = async () => {
    if (!cli.hint) return
    if (await copyText(cli.hint, 'install command')) notify({ kind: 'info', text: 'Copied the install command', key: 'copy-install' })
  }
  return (
    <div className="worktree-gone cli-missing" role="group" aria-label={`${name} CLI missing`}>
      <GoneNote label={`${name} CLI missing`}>Not found on go-chamber’s PATH.</GoneNote>
      {cli.hint && (
        <div className="cli-install">
          <code title={cli.hint}>{cli.hint}</code>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Copy install command" title="Copy install command" onClick={() => void copy()}>
            <Copy {...icon(14)} />
          </button>
        </div>
      )}
      <div className="worktree-gone-actions">
        <button type="button" className="btn" aria-busy={checking || undefined} onClick={() => void check()}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </div>
  )
}
