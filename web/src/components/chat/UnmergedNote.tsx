import { useEffect, useState } from 'react'
import { Copy } from 'lucide-react'
import { getUnmerged, type Session, type Unmerged } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { icon } from '../icon'

// UnmergedNote rides above the composer of a fork made after its parent's
// worktree was removed: the fork works in the repository, while the branch
// the worktree kept may still hold commits it doesn't have. It names them
// with the command that merges them, until they are merged. It asks again
// whenever a turn ends, as the agent (or the owner) may have merged meanwhile.
export default function UnmergedNote({ session }: { session: Session }) {
  const [branch, setBranch] = useState<{ id: string; unmerged: Unmerged } | null>(null)
  const asks = !!session.forkOf && !session.worktree
  const settled = session.status !== 'running'
  useEffect(() => {
    if (!asks || !settled) return
    let live = true
    getUnmerged(session.id).then(
      (unmerged) => live && setBranch(unmerged ? { id: session.id, unmerged } : null),
      // A note that can't be had is no news: the Changes panel still tells.
      () => live && setBranch(null),
    )
    return () => {
      live = false
    }
  }, [asks, settled, session.id])
  const shown = asks && branch?.id === session.id ? branch.unmerged : null
  if (!shown) return null
  const { ahead, into, merge } = shown
  return (
    <div className="unmerged-note" role="status" aria-label="Unmerged branch">
      <span className="unmerged-what">
        Branch <code>{shown.branch}</code> has {ahead} {ahead === 1 ? 'commit' : 'commits'} not in {into}
      </span>
      <span className="unmerged-merge">
        <code className="unmerged-cmd" title={merge}>
          {merge}
        </code>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Copy merge command"
          title="Copy merge command"
          onClick={() => void copyText(merge)}
        >
          <Copy {...icon(12)} />
        </button>
      </span>
    </div>
  )
}
