import { useId, useRef, useState } from 'react'
import { Copy, MoreHorizontal } from 'lucide-react'
import AgentAvatar from '../AgentAvatar'
import ModelPicker from '../models/ModelPicker'
import PermissionModeSelect from '../models/PermissionModeSelect'
import EditableTitle from '../title/EditableTitle'
import PathText from '../ui/PathText'
import { icon } from '../icon'
import type { ApprovalReviewer, Session, Worktree } from '../../lib/api'
import { statusWord, type ShownStatus } from '../../lib/status'
import { isDangerousMode } from '../../lib/models'
import { sessionTitle } from '../../lib/sessions'
import { notify } from '../../stores/notices'
import { useHeaderFold } from './useHeaderFold'
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
      <span className="tool-label" aria-hidden="true">
        Approvals
      </span>
      <select
        className="field field-sm"
        aria-label="Approval reviewer"
        title="Who reviews approvals · default: as the Codex config sets it"
        aria-busy={saving !== null || undefined}
        value={saving ?? session.approvalReviewer ?? ''}
        onChange={(e) => {
          if (saving === null) void change(e.target.value as ApprovalReviewer)
        }}
      >
        <option value="" disabled>
          Default approvals
        </option>
        <option value="user">ask me to approve</option>
        <option value="auto_review">auto-review</option>
      </select>
      {saving !== null && <span className="busy-mark" aria-hidden="true" />}
    </label>
  )
}

// SessionUsage shows the session's total when the agent reports one (Codex);
// otherwise all there is is the last turn's result (Claude), and it says so.
function SessionUsage() {
  const usage = useSessionStore((s) => s.chat.usage)
  const result = useSessionStore((s) => s.chat.result)
  const total = usage !== undefined
  const tokens = total ? (usage.totalTokens ?? 0) : (result?.inputTokens ?? 0) + (result?.outputTokens ?? 0)
  const cost = total ? usage.costUsd : result?.costUsd
  if (!tokens && !cost) return null
  const parts = [tokens ? `${tokens.toLocaleString()} tokens` : '', cost ? `$${cost.toFixed(4)}` : '', total ? '' : 'last turn']
  return (
    <span className="usage" aria-label={total ? 'Session usage' : 'Last turn usage'}>
      {parts.filter(Boolean).join(' · ')}
    </span>
  )
}

// ChatPath shows the session folder, whole on hover, with a copy button. A
// session in a worktree reads as its repository with the branch beside it
// (as in the sessions list); the copy is still the folder the agent runs in.
function ChatPath({ cwd, worktree }: { cwd: string; worktree?: Worktree }) {
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
      <PathText path={worktree?.repo ?? cwd} className="chat-path" />
      {worktree && (
        <span className="session-branch" title={`In a worktree on ${worktree.branch} · ${worktree.path}`}>
          {worktree.branch.replace(/^chamber\//, '')}
        </span>
      )}
      <button type="button" className="btn btn-ghost btn-icon chat-path-copy" aria-label="Copy path" title="Copy path" onClick={() => void copy()}>
        <Copy {...icon(12)} />
      </button>
    </span>
  )
}

interface Props {
  session: Session | undefined
  // status is what the header shows (see lib/status).
  status: ShownStatus
  // unsettled: the live socket dropped, so the state shown may be stale.
  unsettled?: boolean
  // loading: the sessions list hasn't arrived, so the title isn't known yet.
  loading: boolean
  notFound: boolean
  forking: boolean
  onFork: () => void
}

// ChatHeader names the open session and holds its settings. On a phone it
// folds to the title and one meta line; the folder, model, mode and fork
// open behind "⋯" so the transcript keeps the screen.
export default function ChatHeader({ session, status, unsettled, loading, notFound, forking, onFork }: Props) {
  const renameSession = useSessionStore((s) => s.renameSession)
  const [open, setOpen] = useState(false)
  const toolsId = useId()
  const unguarded = isDangerousMode(session?.permissionMode)
  const header = useRef<HTMLElement>(null)
  const fold = useHeaderFold(header)
  return (
    <header ref={header} className="chat-header" data-details={open ? 'open' : undefined} data-fold={fold || undefined}>
      {session && <AgentAvatar agent={session.agent} />}
      <div className="chat-heading">
        {session ? (
          <EditableTitle heading value={sessionTitle(session)} label="session" onRename={(title) => renameSession(session.id, title)} />
        ) : loading ? (
          <div className="chat-heading-skeleton" role="status" aria-label="Loading session">
            <span className="skeleton-line" style={{ '--w': '42%' } as React.CSSProperties} />
            <span className="skeleton-line" style={{ '--w': '64%' } as React.CSSProperties} />
          </div>
        ) : (
          <h2>{notFound ? 'Session not found' : 'Session'}</h2>
        )}
        {session && <ChatPath cwd={session.cwd} worktree={session.worktree} />}
      </div>
      {session && (
        <button
          type="button"
          className="btn btn-ghost btn-icon chat-more"
          aria-label="Session details"
          aria-expanded={open}
          aria-controls={toolsId}
          onClick={() => setOpen(!open)}
        >
          <MoreHorizontal {...icon(16)} />
        </button>
      )}
      <div className="chat-meta">
        {session && (
          <span
            className={`status status-${status}${unsettled ? ' unsettled' : ''}`}
            role="status"
            title={unsettled ? 'May be out of date until the connection is back' : undefined}
          >
            {statusWord(status)}
          </span>
        )}
        {unguarded && (
          <span className="no-approvals" title="The agent won't ask before running commands or editing files">
            no approvals
          </span>
        )}
        <SessionUsage />
        {session && (
          <div className="chat-tools" id={toolsId}>
            {/* The word shows only where the settings stack, on a phone. */}
            <span className="tool-row">
              <span className="tool-label" aria-hidden="true">
                Model
              </span>
              <ModelPicker session={session} />
            </span>
            <PermissionModeSelect session={session} />
            <ApprovalReviewerSelect session={session} />
            {session.nativeId && (
              <button type="button" className="btn btn-ghost chat-fork" aria-busy={forking} onClick={onFork}>
                {forking ? 'Forking…' : 'Fork'}
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  )
}
