import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion, type TargetAndTransition } from 'motion/react'
import AgentAvatar from '../AgentAvatar'
import ModelPicker from '../models/ModelPicker'
import PermissionModeSelect from '../models/PermissionModeSelect'
import ComposerInput from '../composer/ComposerInput'
import Attachments from '../composer/Attachments'
import { useAttachments } from '../composer/useAttachments'
import InterruptedBanner from './InterruptedBanner'
import EditableTitle from '../title/EditableTitle'
import RequestCard from '../requests/RequestCard'
import { Row } from './Transcript'
import { beginAgentView, endAgentView, recordAgentCommit } from '../../lib/diagnostics'
import { SessionFiles } from '../../lib/files'
import type { ApprovalReviewer, Session } from '../../lib/api'
import { sessionTitle } from '../../lib/sessions'
import { displayStatus } from '../../lib/format'
import { enter } from '../../lib/motion'
import { useJustFinished } from '../../lib/finished'
import { firstUnseen, loadSeen, saveSeen } from '../../lib/seen'
import { isBlank, itemTree } from '../../lib/tree'
import { turnNumbers } from '../../lib/turns'
import { useSessionStore } from '../../stores/session'

// ApprovalReviewerSelect chooses who reviews Codex approval requests
// (sandbox escapes, network access) for the active session.
function ApprovalReviewerSelect({ session }: { session: Session }) {
  const setReviewer = useSessionStore((s) => s.setApprovalReviewer)
  if (session.agent !== 'codex') return null
  return (
    <label className="reviewer">
      Approvals
      <select
        className="field field-sm"
        aria-label="approval reviewer"
        value={session.approvalReviewer ?? ''}
        onChange={(e) => void setReviewer(session.id, e.target.value as ApprovalReviewer)}
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

export default function Chat() {
  const chat = useSessionStore((s) => s.chat)
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
  const [text, setText] = useState('')
  const attachments = useAttachments(session?.id)
  const status = displayStatus(chat, session)
  const finished = useJustFinished(status)
  const running = status === 'running'
  const reduced = useReducedMotion() ?? false
  const nodes = useMemo(() => itemTree(chat.order, chat.items).filter((node) => !isBlank(node.item)), [chat.order, chat.items])
  const turns = useMemo(() => turnNumbers(nodes), [nodes])
  const unseen = useUnseen(session?.id, chat.order)
  const scrollRef = useStickToBottom(chat)
  // Rows of the loaded history appear at once; later ones animate in. The
  // chat starts empty and fills from history, so wait for its first events.
  const [listedFor, setListedFor] = useState<string>()
  // After the commit on purpose: rows mounted with the history must not animate.
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => { if (chat.lastSeq > 0) setListedFor(session?.id) }, [session?.id, chat.lastSeq])
  useLayoutEffect(() => {
    if (!session?.id) return
    beginAgentView(session.id)
    return () => endAgentView(session.id)
  }, [session?.id])
  useLayoutEffect(() => { recordAgentCommit(session?.id) }, [chat, session?.id])

  const sending = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const submit = async () => {
    if (sending.current) return
    const value = text.trim()
    const images = attachments.ids
    const id = session?.id
    if (!value && (running || images.length === 0)) return
    sending.current = true
    setSubmitting(true)
    try {
      const accepted = running ? await steer(value) : await send(value, images)
      if (!accepted) return
      if (!running) images.forEach(attachments.remove)
      if (useSessionStore.getState().activeId === id) {
        setText((current) => current === text ? '' : current)
      }
    } finally {
      sending.current = false
      setSubmitting(false)
    }
  }

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
          {session && <span className="chat-path">{session.cwd}</span>}
        </div>
        <div className="chat-meta">
          <span className={`status status-${finished ? 'done' : status}`}>{finished ? 'done' : status}</span>
          {connection !== 'online' && <span className={`health health-${connection}`}>{connection}</span>}
          <SessionUsage />
          {session && <ModelPicker session={session} />}
          {session && <PermissionModeSelect session={session} />}
          {session && <ApprovalReviewerSelect session={session} />}
          {session?.nativeId && (
            <button type="button" className="btn btn-ghost" onClick={() => void forkSession(session.id)}>
              Fork
            </button>
          )}
        </div>
      </header>
      <div className="scroll" ref={scrollRef}>
        <SessionFiles.Provider value={session?.id}>
          <ol className="items">
            {nodes.map((node) => (
              <Row
                key={node.item.id}
                node={node}
                turn={turns.get(node.item.id)}
                unseen={node.item.id === unseen}
                reduced={reduced}
                animateIn={listedFor === session?.id}
                onStopTask={stopTask}
              />
            ))}
          </ol>
        </SessionFiles.Provider>
        {chat.order.length === 0 && status !== 'interrupted' && (
          <p className="chat-hint">Send a message to start. The agent runs in {session?.cwd ?? 'the session folder'}.</p>
        )}
        <AnimatePresence initial={false}>
          {Object.values(chat.requests).map((request) => (
            <motion.div
              key={request.id}
              className="request-slot"
              {...enter(reduced, 'margin')}
              exit={reduced ? { opacity: 0 } : resolve}
              ref={scrollOnMount}
            >
              <RequestCard request={request} agent={session?.agent} onRespond={respond} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      {status === 'interrupted' && session && (
        <InterruptedBanner
          session={session}
          onContinue={() => void continueSession()}
          onAutoContinue={(on) => void setAutoContinue(session.id, on)}
        />
      )}
      <form
        className="composer"
        {...attachments.dropProps}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <ComposerInput
          sessionId={session?.id}
          agent={session?.agent}
          value={text}
          onChange={setText}
          onSubmit={submit}
          placeholder={running ? 'Steer the running turn…' : 'Message the agent…  ⌘↵ to send'}
        />
        <div className="composer-actions">
          <Attachments state={attachments} />
          {running && (
            <button type="button" className="btn btn-danger stop" onClick={() => void interrupt()}>
              Stop
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {running ? 'Steer' : 'Send'}
          </button>
        </div>
      </form>
    </section>
  )
}

// useUnseen remembers where the user stopped reading this session and returns
// the first item that arrived since, for the "new since you left" mark.
function useUnseen(sessionId: string | undefined, order: string[]): string | null {
  // Read once: the mark stays where the user left, while new items stream in.
  const [seen] = useState(() => (sessionId ? loadSeen(sessionId) : null))
  const last = order[order.length - 1]
  useEffect(() => {
    if (sessionId && last) saveSeen(sessionId, last)
  }, [sessionId, last])
  return firstUnseen(order, seen)
}

// resolve strikes the answered request through, then folds it away.
const resolve: TargetAndTransition = {
  '--strike': [0, 1, 1],
  opacity: [1, 1, 0],
  height: [null, null, 0],
  transition: { duration: 0.45, times: [0, 0.45, 1], ease: 'easeOut' },
}

// useStickToBottom keeps the chat scrolled to the end while new output
// streams in, unless the user scrolled up to read.
function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}

// A pending request is the one thing the user must act on: bring all of it
// into view when it arrives or when the session opens.
function scrollOnMount(el: HTMLDivElement | null) {
  el?.scrollIntoView({ block: 'nearest' })
}
