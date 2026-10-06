import type { Session, Worktree } from '../../lib/api'
import { basename } from '../../lib/format'
import { usePending } from '../../lib/pending'
import { useSessionStore } from '../../stores/session'

// WorktreeGone stands where the composer was once a session's worktree
// folder is removed: the agent has nowhere to work, so the session takes no
// more turns. Its conversation can go on in a fork in the repository (the
// branch stays there), or the session can be put away.
export default function WorktreeGone({ session, worktree }: { session: Session; worktree: Worktree }) {
  const forkSession = useSessionStore((s) => s.forkSession)
  const archiveSession = useSessionStore((s) => s.archiveSession)
  const [fork, forking] = usePending(() => forkSession(session.id), { holdOnSuccess: true })
  const [archive, archiving] = usePending(() => archiveSession(session.id))
  const repo = basename(worktree.repo)
  return (
    <div className="worktree-gone" role="group" aria-label="Worktree removed">
      <p>
        <span className="worktree-gone-kw">Worktree removed</span> · branch {worktree.branch} kept in{' '}
        <span title={worktree.repo}>{repo}</span>
      </p>
      <div className="worktree-gone-actions">
        {session.nativeId && (
          <button type="button" className="btn btn-primary" aria-busy={forking || undefined} onClick={() => void fork()}>
            {forking ? 'Forking…' : `Fork into ${repo}`}
          </button>
        )}
        {!session.archivedAt && (
          <button type="button" className="btn" aria-busy={archiving || undefined} onClick={() => void archive()}>
            {archiving ? 'Archiving…' : 'Archive'}
          </button>
        )}
      </div>
    </div>
  )
}
