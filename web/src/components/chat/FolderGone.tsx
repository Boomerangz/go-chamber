import type { Session } from '../../lib/api'
import { usePending } from '../../lib/pending'
import { useSessionStore } from '../../stores/session'
import GoneNote from '../ui/GoneNote'

// FolderGone stands where the composer was once a session's folder is no
// longer there: its agent can't start, and a fork would start in the same
// missing place, so what is left is to put the session away. Laid out like
// WorktreeGone.
export default function FolderGone({ session }: { session: Session }) {
  const archiveSession = useSessionStore((s) => s.archiveSession)
  const [archive, archiving] = usePending(() => archiveSession(session.id))
  return (
    <div className="worktree-gone folder-gone" role="group" aria-label="Folder gone">
      <GoneNote label="Folder gone" path={session.cwd}>
        This folder no longer exists, so the agent can’t start in it.
      </GoneNote>
      {!session.archivedAt && (
        <div className="worktree-gone-actions">
          <button type="button" className="btn" aria-busy={archiving || undefined} onClick={() => void archive()}>
            {archiving ? 'Archiving…' : 'Archive'}
          </button>
        </div>
      )}
    </div>
  )
}
