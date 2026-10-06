import { useId, useState } from 'react'
import { Copy, MoreHorizontal } from 'lucide-react'
import AgentAvatar from '../AgentAvatar'
import ModelPicker from '../models/ModelPicker'
import PermissionModeSelect from '../models/PermissionModeSelect'
import EditableTitle from '../title/EditableTitle'
import { icon } from '../icon'
import type { ApprovalReviewer, Session, SessionStatus } from '../../lib/api'
import { isDangerousMode } from '../../lib/models'
import { sessionTitle } from '../../lib/sessions'
import { notify } from '../../stores/notices'
import { useSessionStore } from '../../stores/session'

// ApprovalReviewerSelect chooses who reviews Codex approval requests
// (sandbox escapes, network access) for the active session. The choice shows
// at once with a busy mark and reverts if the server refuses it.
function ApprovalReviewerSelect({ session }: { session: Session }) {
  const setReviewer = useSessionStore((s) => s.setApprovalReviewer)
  const [saving, setSaving] = useState<ApprovalReviewer | null>(null)
  if (session.agent !== 'codex') return null
  const change = async (reviewer: ApprovalReviewer) => {
    setSaving(reviewer)
    try {
      await setReviewer(session.id, reviewer)
    } finally {
      setSaving(null)
    }
  }
  return (
    <label className="reviewer">
      Approvals
      <select
        className="field field-sm"
        aria-label="approval reviewer"
        aria-busy={saving !== null || undefined}
        value={saving ?? session.approvalReviewer ?? ''}
        onChange={(e) => {
          if (saving === null) void change(e.target.value as ApprovalReviewer)
        }}
      >
        <option value="" disabled>
          from Codex config
        </option>
        <option value="user">ask me</option>
        <option value="auto_review">auto-review</option>
      </select>
      {saving !== null && <span className="busy-mark" aria-hidden="true" />}
    </label>
  )
}

function SessionUsage() {
  const usage = useSessionStore((s) => s.chat.usage)
  const result = useSessionStore((s) => s.chat.result)
  const tokens = usage?.totalTokens ?? ((result?.inputTokens ?? 0) + (result?.outputTokens ?? 0))
  const cost = usage?.costUsd ?? result?.costUsd
  if (!tokens && !cost) return null
  return (
    <span className="usage" aria-label="session usage">
      {tokens ? `${tokens.toLocaleString()} tokens` : ''}
      {cost ? ` · $${cost.toFixed(4)}` : ''}
    </span>
  )
}

// ChatPath shows the session folder, whole on hover, with a copy button.
function ChatPath({ cwd }: { cwd: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cwd)
      notify({ kind: 'info', text: 'Path copied', key: 'copy-path' })
    } catch {
      notify({ kind: 'error', title: "Couldn't copy the path", text: 'the browser refused clipboard access', key: 'copy-path' })
    }
  }
  return (
    <span className="chat-path-line">
      <span className="chat-path" title={cwd}>
        {cwd}
      </span>
      <button type="button" className="btn btn-ghost btn-icon chat-path-copy" aria-label="copy path" title="Copy path" onClick={() => void copy()}>
        <Copy {...icon(12)} />
      </button>
    </span>
  )
}

interface Props {
  session: Session | undefined
  // status is the word the header shows: running, idle, done…
  status: SessionStatus | 'done'
  // loading: the sessions list hasn't arrived, so the title isn't known yet.
  loading: boolean
  notFound: boolean
  forking: boolean
  onFork: () => void
}

// ChatHeader names the open session and holds its settings. On a phone it
// folds to the title and one meta line; the folder, model, mode and fork
// open behind "⋯" so the transcript keeps the screen.
export default function ChatHeader({ session, status, loading, notFound, forking, onFork }: Props) {
  const renameSession = useSessionStore((s) => s.renameSession)
  const connection = useSessionStore((s) => s.connection)
  const [open, setOpen] = useState(false)
  const toolsId = useId()
  const unguarded = isDangerousMode(session?.permissionMode)
  return (
    <header className="chat-header" data-details={open ? 'open' : undefined}>
      {session && <AgentAvatar agent={session.agent} />}
      <div className="chat-heading">
        {session ? (
          <EditableTitle heading value={sessionTitle(session)} label="session" onRename={(title) => renameSession(session.id, title)} />
        ) : loading ? (
          <div className="chat-heading-skeleton" role="status" aria-label="loading session">
            <span className="skeleton-line" style={{ '--w': '42%' } as React.CSSProperties} />
            <span className="skeleton-line" style={{ '--w': '64%' } as React.CSSProperties} />
          </div>
        ) : (
          <h2>{notFound ? 'Session not found' : 'Session'}</h2>
        )}
        {session && <ChatPath cwd={session.cwd} />}
      </div>
      {session && (
        <button
          type="button"
          className="btn btn-ghost btn-icon chat-more"
          aria-label="session details"
          aria-expanded={open}
          aria-controls={toolsId}
          onClick={() => setOpen(!open)}
        >
          <MoreHorizontal {...icon(16)} />
        </button>
      )}
      <div className="chat-meta">
        {session && (
          <span className={`status status-${status}`} role="status">
            {status}
          </span>
        )}
        {connection !== 'online' && <span className={`health health-${connection}`}>{connection}</span>}
        {unguarded && (
          <span className="no-approvals" title="The agent won't ask before running commands or editing files">
            no approvals
          </span>
        )}
        <SessionUsage />
        {session && (
          <div className="chat-tools" id={toolsId}>
            <ModelPicker session={session} />
            <PermissionModeSelect session={session} />
            <ApprovalReviewerSelect session={session} />
            {session.nativeId && (
              <button type="button" className="btn btn-ghost" aria-busy={forking} onClick={onFork}>
                {forking ? 'Forking…' : 'Fork'}
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  )
}
