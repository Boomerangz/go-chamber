import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion, type TargetAndTransition } from 'motion/react'
import { ArrowDown, Copy } from 'lucide-react'
import AgentAvatar from '../AgentAvatar'
import ModelPicker from '../models/ModelPicker'
import PermissionModeSelect from '../models/PermissionModeSelect'
import ComposerInput from '../composer/ComposerInput'
import Attachments from '../composer/Attachments'
import { useAttachments } from '../composer/useAttachments'
import InterruptedBanner from './InterruptedBanner'
import EditableTitle from '../title/EditableTitle'
import RequestCard from '../requests/RequestCard'
import { LoadFailed, Skeleton } from '../ui/Loading'
import { icon } from '../icon'
import { Row } from './Transcript'
import { isMac, matches, useMedia } from './useMedia'
import { beginAgentView, endAgentView, recordAgentCommit } from '../../lib/diagnostics'
import { SessionFiles } from '../../lib/files'
import type { ApprovalReviewer, Session, SessionStatus, TurnResult } from '../../lib/api'
import { forgetCommands } from '../../lib/complete'
import { sessionTitle } from '../../lib/sessions'
import { displayStatus } from '../../lib/format'
import { enter } from '../../lib/motion'
import { useJustFinished } from '../../lib/finished'
import { useNow } from '../../lib/now'
import { usePending } from '../../lib/pending'
import { useUnseen } from '../../lib/seen'
import { isBlank, itemTree } from '../../lib/tree'
import { groupTools, lastItemId } from '../../lib/group'
import { turnNumbers } from '../../lib/turns'
import { loadDraft, saveDraft } from '../../stores/drafts'
import { notify } from '../../stores/notices'
import { useSessionStore } from '../../stores/session'
import './Chat.css'

// An accepted message makes the chat behave as running until the turn shows
// up; if it never does, give up after this long.
const STARTING_MS = 8000

// ApprovalReviewerSelect chooses who reviews Codex approval requests
// (sandbox escapes, network access) for the active session. The choice shows
// at once and reverts if the server refuses it.
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

// A turn mark tells one turn state apart from the next: the status, and the
// result object a finished turn replaces.
interface TurnMark {
  status: SessionStatus
  result?: TurnResult
}

function currentMark(): TurnMark {
  const s = useSessionStore.getState()
  const session = s.sessions.find((x) => x.id === s.activeId)
  return { status: displayStatus(s.chat, session), result: s.chat.result }
}

const sameMark = (a: TurnMark, b: TurnMark) => a.status === b.status && a.result === b.result

export default function Chat() {
  const chat = useSessionStore((s) => s.chat)
  const history = useSessionStore((s) => s.history)
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId))
  const renameSession = useSessionStore((s) => s.renameSession)
  const connection = useSessionStore((s) => s.connection)
  const send = useSessionStore((s) => s.send)
  const steer = useSessionStore((s) => s.steer)
  const interrupt = useSessionStore((s) => s.interrupt)
  const respond = useSessionStore((s) => s.respond)
  const stopTask = useSessionStore((s) => s.stopTask)
  const continueSession = useSessionStore((s) => s.continueSession)
  const setAutoContinue = useSessionStore((s) => s.setAutoContinue)
  const forkSession = useSessionStore((s) => s.forkSession)
  const sessionId = session?.id
  const [text, setTextState] = useState(() => (sessionId ? loadDraft(sessionId) : ''))
  const setText = useCallback(
    (next: string) => {
      setTextState(next)
      if (sessionId) saveDraft(sessionId, next)
    },
    [sessionId],
  )
  const textRef = useRef(text)
  useEffect(() => {
    textRef.current = text
  }, [text])
  const attachments = useAttachments(sessionId)
  const status = displayStatus(chat, session)
  const finished = useJustFinished(status)
  // The transcript owner marks a failed turn; a failure doesn't flash "done".
  const shownStatus = finished && !chat.lastTurnFailed ? 'done' : status
  const running = status === 'running'
  const reduced = useReducedMotion() ?? false
  const narrow = useMedia('(max-width: 720px)')
  const nodes = useMemo(() => itemTree(chat.order, chat.items).filter((node) => !isBlank(node.item)), [chat.order, chat.items])
  const turns = useMemo(() => turnNumbers(nodes), [nodes])
  const [scrollRef, stick] = useStickToBottom(chat, chat.order.length)
  const unseen = useUnseen({
    sessionId, order: chat.order, items: chat.items, ready: history === 'ready', pinned: stick.pinned, isPinned: stick.isPinned,
  })
  const lastItem = chat.order.length ? chat.items[chat.order[chat.order.length - 1]!] : undefined
  const streaming = lastItem?.status === 'streaming'
  const lastUserText = useMemo(() => {
    for (let i = chat.order.length - 1; i >= 0; i--) {
      const item = chat.items[chat.order[i]!]
      if (item?.kind === 'user_message' && !item.parentItemId && item.text) return item.text
    }
    return undefined
  }, [chat.order, chat.items])

  // Between an accepted message and the turn showing up the chat already
  // behaves as running, so a quick second message steers.
  const [starting, setStarting] = useState<TurnMark | null>(null)
  const mark: TurnMark = { status, result: chat.result }
  if (starting && !sameMark(starting, mark)) setStarting(null)
  useEffect(() => {
    if (!starting) return
    const timer = setTimeout(() => setStarting(null), STARTING_MS)
    return () => clearTimeout(timer)
  }, [starting])
  const busy = running || starting !== null
  // When this turn started, for the working clock; unknown before this view.
  const [turnStart, setTurnStart] = useState<number | null>(null)
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => setTurnStart(busy ? Date.now() : null), [busy])

  // Commands and skills may have changed during the turn; ask again next time.
  useEffect(() => {
    if (sessionId && status === 'idle') forgetCommands(sessionId)
  }, [sessionId, status])

  // Rows of the loaded history appear at once; later ones animate in.
  const [listedFor, setListedFor] = useState<string>()
  // After the commit on purpose: rows mounted with the history must not animate.
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => { if (history === 'ready') setListedFor(sessionId) }, [sessionId, history])
  useLayoutEffect(() => {
    if (!sessionId) return
    beginAgentView(sessionId)
    return () => endAgentView(sessionId)
  }, [sessionId])
  useLayoutEffect(() => { recordAgentCommit(sessionId) }, [chat, sessionId])

  // Opening a session with news lands on the "new since you left" mark.
  const landed = useRef(false)
  useLayoutEffect(() => {
    if (landed.current || history !== 'ready' || chat.order.length === 0) return
    landed.current = true
    if (!unseen) return
    const markEl = scrollRef.current?.querySelector('.unseen-mark')
    if (!markEl) return
    stick.unpin()
    markEl.scrollIntoView?.({ block: 'start' })
  }, [history, chat.order.length, unseen, stick, scrollRef])

  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    // A request card that took focus on arrival keeps it, so its keys answer.
    if (matches('(pointer: fine)') && !document.activeElement?.closest('.request')) input.current?.focus()
  }, [])

  // Transcript hook-ups: runs of tool lines fold, a failed turn's message can
  // be sent again, a message of the owner's can be taken back to the composer.
  const rows = useMemo(() => groupTools(nodes, unseen), [nodes, unseen])
  const lastUser = useMemo(() => {
    for (let i = chat.order.length - 1; i >= 0; i--) {
      const item = chat.items[chat.order[i]!]
      if (item?.kind === 'user_message' && !item.parentItemId) return item
    }
    return undefined
  }, [chat.order, chat.items])
  const stickToEnd = stick.stick
  const retry = useCallback(async () => {
    const ok = lastUser ? await send(lastUser.text ?? '', lastUser.images ?? []) : false
    if (ok) stickToEnd()
    return ok
  }, [lastUser, send, stickToEnd])
  const editMessage = useCallback((message: string) => {
    setText(textRef.current.trim() ? `${textRef.current}\n\n${message}` : message)
    input.current?.focus()
  }, [setText])

  const doSubmit = async (): Promise<boolean> => {
    const value = text.trim()
    const images = attachments.ids
    const steerIt = busy
    // A message sent mid-upload would go without the images still on their way.
    if (!steerIt && attachments.uploading) return false
    if (!value && (steerIt || images.length === 0)) return false
    const before = currentMark()
    const accepted = steerIt ? await steer(value) : await send(value, images)
    if (!accepted) return false
    if (!steerIt) {
      images.forEach(attachments.remove)
      const after = currentMark()
      // The turn may already have started (or even ended) meanwhile.
      if (sameMark(before, after) && after.status !== 'running') setStarting(after)
    }
    if (useSessionStore.getState().activeId === sessionId) {
      if (textRef.current === text) setText('')
      stick.stick()
      if (!document.activeElement?.closest('.request')) input.current?.focus()
    }
    return true
  }
  const [submit, submitting] = usePending(doSubmit)

  // Stop stays "Stopping…" from an accepted interrupt until the turn changes.
  const [stopHeld, setStopHeld] = useState<TurnMark | null>(null)
  if (stopHeld && !sameMark(stopHeld, mark)) setStopHeld(null)
  const [stop, stopPending] = usePending(async () => {
    const before = currentMark()
    const ok = await interrupt()
    if (ok && sameMark(before, currentMark())) setStopHeld(before)
    return ok
  })
  const stopping = stopPending || stopHeld !== null
  const stopRef = useRef<() => void>(() => {})
  useEffect(() => {
    stopRef.current = () => {
      if (busy && !stopping) void stop()
      // Nothing to stop: Escape leaves the composer, so single-key
      // shortcuts (j/k, ?, r) answer again.
      else if (!busy) (document.activeElement as HTMLElement | null)?.blur()
    }
  })
  // ⌘. / Ctrl+. stops the turn from anywhere but a terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '.' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.target instanceof Element && e.target.closest('.xterm')) return
      e.preventDefault()
      stopRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const [fork, forking] = usePending(() => forkSession(sessionId!), { holdOnSuccess: true })

  const empty = !text.trim() && (busy || attachments.ids.length === 0)
  const sendLabel = attachments.uploading && !busy ? 'Uploading…' : submitting ? (busy ? 'Steering…' : 'Sending…') : busy ? 'Steer' : 'Send'
  const sendBusy = submitting || (attachments.uploading && !busy)
  const mod = isMac() ? '⌘' : 'Ctrl+'
  const placeholder = busy ? 'Steer the running turn…' : narrow ? 'Message the agent…' : `Message the agent…  ${mod}↵ to send`

  return (
    <section className="chat panel">
      <header className="chat-header">
        {session && <AgentAvatar agent={session.agent} />}
        <div className="chat-heading">
          {session ? (
            <EditableTitle heading value={sessionTitle(session)} label="session" onRename={(title) => renameSession(session.id, title)} />
          ) : (
            <h2>Session</h2>
          )}
          {session && <ChatPath cwd={session.cwd} />}
        </div>
        <div className="chat-meta">
          <span className={`status status-${shownStatus}`} role="status">
            {shownStatus}
          </span>
          {connection !== 'online' && <span className={`health health-${connection}`}>{connection}</span>}
          <SessionUsage />
          {session && <ModelPicker session={session} />}
          {session && <PermissionModeSelect session={session} />}
          {session && <ApprovalReviewerSelect session={session} />}
          {session?.nativeId && (
            <button type="button" className="btn btn-ghost" aria-busy={forking} onClick={() => void fork()}>
              {forking ? 'Forking…' : 'Fork'}
            </button>
          )}
        </div>
      </header>
      <div className="scroll" ref={scrollRef}>
        {history === 'loading' && chat.order.length === 0 ? (
          <div className="chat-loading">
            <Skeleton rows={4} label="loading transcript" />
          </div>
        ) : (
          <SessionFiles.Provider value={sessionId}>
            <ol className="items" role="log" aria-live="polite" aria-relevant="additions" aria-busy={streaming}>
              {rows.map((node, i) => (
                <Row
                  key={node.item.id}
                  node={node}
                  turn={turns.get(node.item.id)}
                  unseen={node.item.id === unseen}
                  reduced={reduced}
                  animateIn={listedFor === sessionId}
                  onStopTask={stopTask}
                  onRetry={i === rows.length - 1 && node.item.kind === 'error' && !busy ? retry : undefined}
                  onEdit={editMessage}
                  result={chat.turnResults?.[lastItemId(node)]}
                />
              ))}
            </ol>
          </SessionFiles.Provider>
        )}
        {history === 'error' && (
          <div className="chat-loading">
            <LoadFailed onRetry={() => sessionId && void useSessionStore.getState().selectSession(sessionId)}>
              Couldn't load the transcript
            </LoadFailed>
          </div>
        )}
        {history === 'ready' && chat.order.length === 0 && status !== 'interrupted' && !busy && (
          <p className="chat-hint">Send a message to start. The agent runs in {session?.cwd ?? 'the session folder'}.</p>
        )}
        {busy && !streaming && <WorkingTail since={turnStart} waiting={Object.keys(chat.requests).length > 0} />}
        <AnimatePresence initial={false}>
          {Object.values(chat.requests).map((request, i, all) => (
            <motion.div
              key={request.id}
              className="request-slot"
              {...enter(reduced, 'margin')}
              exit={reduced ? { opacity: 0 } : resolve}
              ref={scrollOnMount}
            >
              <RequestCard request={request} agent={session?.agent} onRespond={respond} position={{ index: i + 1, count: all.length }} />
            </motion.div>
          ))}
        </AnimatePresence>
        {stick.unread > 0 && (
          <div className="jump-latest">
            <button type="button" className="btn btn-xs" onClick={stick.stick}>
              latest <ArrowDown {...icon(12)} /> {stick.unread}
            </button>
          </div>
        )}
      </div>
      {status === 'interrupted' && session && (
        <InterruptedBanner
          session={session}
          onContinue={continueSession}
          onAutoContinue={(on) => setAutoContinue(session.id, on)}
        />
      )}
      <form
        className={attachments.dragging ? 'composer dragging' : 'composer'}
        {...attachments.dropProps}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <ComposerInput
          inputRef={input}
          sessionId={sessionId}
          agent={session?.agent}
          value={text}
          onChange={setText}
          onSubmit={() => void submit()}
          onEscape={() => {
            if (!text) stopRef.current()
          }}
          recall={busy ? undefined : lastUserText}
          placeholder={placeholder}
        />
        <div className="composer-actions">
          <Attachments state={attachments} locked={busy} />
          {busy && (
            <button
              type="button"
              className="btn btn-danger stop"
              aria-busy={stopping}
              title={`Stop (Esc, ${mod}.)`}
              onClick={() => stopRef.current()}
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          )}
          <button type="submit" className="btn btn-primary" aria-busy={sendBusy} disabled={empty && !sendBusy}>
            {sendLabel}
          </button>
        </div>
      </form>
    </section>
  )
}

// WorkingTail ends a running turn's transcript while nothing streams: the
// running mark and how long the turn has taken, or that it waits for the owner.
function WorkingTail({ since, waiting }: { since: number | null; waiting: boolean }) {
  const [mounted] = useState(() => Date.now())
  const now = useNow(1000)
  const start = since ?? mounted
  return (
    <div className={waiting ? 'working-tail waiting' : 'working-tail'} aria-hidden={waiting ? undefined : true}>
      {waiting ? 'waiting for you' : `working · ${elapsed(Math.max(0, now - start))}`}
    </div>
  )
}

// elapsed reads a duration as m:ss, or h:mm:ss past an hour.
function elapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

// resolve strikes the answered request through, then folds it away.
const resolve: TargetAndTransition = {
  '--strike': [0, 1, 1],
  opacity: [1, 1, 0],
  height: [null, null, 0],
  transition: { duration: 0.45, times: [0, 0.45, 1], ease: 'easeOut' },
}

// useStickToBottom keeps the chat scrolled to the end while new output
// streams in, unless the user scrolled up to read; then it counts the items
// that arrived meanwhile for the "latest" button.
function useStickToBottom(dep: unknown, count: number) {
  const ref = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const countRef = useRef(count)
  const [pinned, setPinned] = useState(true)
  const [base, setBase] = useState(count)
  useEffect(() => {
    countRef.current = count
  }, [count])
  const setPinnedTo = useCallback((next: boolean) => {
    if (pinnedRef.current === next) return
    pinnedRef.current = next
    setPinned(next)
    if (!next) setBase(countRef.current)
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => setPinnedTo(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
    // Images load after layout and push the end down; follow them.
    const onLoad = () => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('load', onLoad, true)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('load', onLoad, true)
    }
  }, [setPinnedTo])
  useLayoutEffect(() => {
    const el = ref.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [dep])
  const stick = useCallback(() => {
    setPinnedTo(true)
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [setPinnedTo])
  const unpin = useCallback(() => setPinnedTo(false), [setPinnedTo])
  const isPinned = useCallback(() => pinnedRef.current, [])
  const state = useMemo(
    () => ({ pinned, unread: pinned ? 0 : Math.max(0, count - base), stick, unpin, isPinned }),
    [pinned, count, base, stick, unpin, isPinned],
  )
  return [ref, state] as const
}

// A pending request is the one thing the user must act on: bring all of it
// into view when it arrives or when the session opens.
function scrollOnMount(el: HTMLDivElement | null) {
  el?.scrollIntoView?.({ block: 'nearest' })
}
