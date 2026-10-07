import type { ReactNode } from 'react'
import PathText from './PathText'
import './GoneNote.css'

// GoneNote says that something a session needs went away: the label, the
// path on a line of its own in mono (cut from its start when long, the last
// folder kept), then why it matters. Each part takes its own line, so no
// separator is ever left hanging where a long path wrapped.
export default function GoneNote({ label, path, children }: { label: string; path?: string; children: ReactNode }) {
  return (
    <p className="gone-note">
      <span className="worktree-gone-kw">{label}</span>{' '}
      {path && (
        <>
          <PathText className="gone-path" path={path} />{' '}
        </>
      )}
      <span className="gone-why">{children}</span>
    </p>
  )
}
