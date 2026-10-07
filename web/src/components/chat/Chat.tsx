import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion, type TargetAndTransition } from 'motion/react'
import { ArrowDown } from 'lucide-react'
import ComposerInput from '../composer/ComposerInput'
import Attachments from '../composer/Attachments'
import { useAttachments } from '../composer/useAttachments'
import InterruptedBanner from './InterruptedBanner'
import FolderGone from './FolderGone'
import CLIMissing from './CLIMissing'
import WorktreeGone from './WorktreeGone'
import ChatHeader from './ChatHeader'
import LiveStrip from './LiveStrip'
import UnmergedNote from './UnmergedNote'
import RequestCard from '../requests/RequestCard'
import { lastInput } from '../requests/modality'
import Keys from '../ui/Keys'
import { LoadFailed, Skeleton } from '../ui/Loading'
import { icon } from '../icon'
import { Row } from './Transcript'
import { isMac, matches, useMedia } from './useMedia'
import { useAnnouncement } from './useAnnouncement'
import { useStickToBottom } from './useStickToBottom'
import { useReadingPlace } from './useReadingPlace'
import { useTypingMark } from './useTypingMark'
import { SENT_HOLD_MS, untilBack, useLiveDropped } from './useLiveDropped'
import { beginAgentView, endAgentView, recordAgentCommit } from '../../lib/diagnostics'
import { SessionFiles, SessionFolder } from '../../lib/files'
import type { RequestAnswerInput, Session, SessionRequest, SessionStatus, TurnResult } from '../../lib/api'
import { browsedTo } from '../../lib/browse'
import { forgetCommands } from '../../lib/complete'
import { basename, displayStatus } from '../../lib/format'
import { enter } from '../../lib/motion'
import { useJustFinished } from '../../lib/finished'
import { useNow } from '../../lib/now'
import { owesAnswer, shownStatus } from '../../lib/status'
import { usePending } from '../../lib/pending'
import { useCLIs } from '../../lib/clis'
import { useUnseen } from '../../lib/seen'
import { isBlank, itemTree, withoutAnsweredQuestions } from '../../lib/tree'
import { groupTools, lastItemId } from '../../lib/group'
import { turnNumbers, turnOutline } from '../../lib/turns'
import TurnOutline from './TurnOutline'
import { loadDraft, saveDraft } from '../../stores/drafts'
import { useSessionStore } from '../../stores/session'
import { useNotices } from '../../stores/notices'
import { failedTo } from '../../lib/failed'
import './Chat.css'

// An accepted message makes the chat behave as running until the turn shows
// up; if it never does, give up after this long.
const STARTING_MS = 8000
// A sent message waits for the agent to record it; past this, stop showing
// it as on its way (the turn's own events tell what happened).
const ECHO_MS = 30_000
// Past this many lines the composer says how long the message is.
const LONG_DRAFT_LINES = 20

// PendingSend is a message accepted (or on its way) that the transcript
// doesn't show yet.
interface PendingSend {
  key: number
  text: string
  state: 'queued' | 'sending' | 'sent'
}

// Outgoing is a submitted message waiting for its turn to go out.
interface Outgoing {
  key: number
  value: string
  raw: string
  images: string[]
}
let nextSendKey = 0

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
  const historyReason = useSessionStore((s) => s.historyError?.reason)
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId))
  const pane = useSessionStore((s) => s.pane)
  const sessionsStatus = useSessionStore((s) => s.sessionsStatus)
  const dropped = useLiveDropped()
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
  const status = displayStatus(chat, session)
  const failedTurn = !!chat.lastTurnFailed && (status === 'idle' || status === 'detached')
  const finished = useJustFinished(status, failedTurn)
  // The header shows what the sessions list shows: a waiting request first;
  // a failed turn doesn't flash "done", it says it failed until the next turn.
  const shown = shownStatus({
    status, started: !!session?.nativeId, waiting: Object.keys(chat.requests).length, failed: failedTurn, finished,
    owed: !!session && owesAnswer({ status, interruption: session.interruption }),
  })
  const running = status === 'running'
  const reduced = useReducedMotion() ?? false
  const narrow = useMedia('(max-width: 720px)')
  // On a touch screen Enter is the keyboard's newline; Send is a tap away.
  const touch = useMedia('(pointer: coarse)')
  const nodes = useMemo(
    () => withoutAnsweredQuestions(itemTree(chat.order, chat.items).filter((node) => !isBlank(node.item))),
    [chat.order, chat.items],
  )
  const turns = useMemo(() => turnNumbers(nodes), [nodes])
  const outline = useMemo(() => turnOutline(nodes), [nodes])
  // What the "latest" button counts: replies and requests, not tool lines.
  const news = useMemo(() => {
    const keys = chat.order.filter((id) => {
      const item = chat.items[id]
      return item?.kind === 'assistant_message' && !item.parentItemId
    })
    for (const id of Object.keys(chat.requests)) keys.push(`request:${id}`)
    return keys
  }, [chat.order, chat.items, chat.requests])
  const [scrollRef, stick] = useStickToBottom(chat, news)
  // A phone shows one pane at a time: the chat is looked at only in front.
  const inFront = !narrow || pane === 'chat'
  const unseen = useUnseen({
    sessionId, session, shown: inFront, order: chat.order, items: chat.items, ready: history === 'ready', pinned: stick.pinned, isPinned: stick.isPinned,
  })
  const lastItem = chat.order.length ? chat.items[chat.order[chat.order.length - 1]!] : undefined
  const streaming = lastItem?.status === 'streaming'
  // Words on their way speak for themselves; a running tool or subagent
  // shows none, so the tail still says the turn is working.
  const wording = streaming && lastItem?.kind === 'assistant_message'
  // The owner's messages, oldest first: ArrowUp walks back through them.
  const sent = useMemo(() => {
    const texts: string[] = []
    for (const id of chat.order) {
      const item = chat.items[id]
      if (item?.kind === 'user_message' && !item.parentItemId) texts.push(item.text ?? '')
    }
    return texts
  }, [chat.order, chat.items])

  // A message shows as on its way from submit until the agent records it.
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([])
  const [recorded, setRecorded] = useState(sent.length)
  if (recorded !== sent.length) {
    setRecorded(sent.length)
    if (sent.length > recorded && pendingSends.length) setPendingSends(pendingSends.slice(sent.length - recorded))
  }
  const dropSend = useCallback((key: number) => setPendingSends((list) => list.filter((p) => p.key !== key)), [])

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
  // A running turn takes text only; images wait for the next message.
  const attachments = useAttachments(sessionId, busy)
  // When this turn started, for the working clock: now for a turn sent from
  // here, else when the session last started one (a turn already running
  // when the page opened keeps its clock across a reload).
  const [turnStart, setTurnStart] = useState<number | null>(null)
  // A turn this view sent starts now, whatever the session list says yet.
  const sentHere = useRef(false)
  const activeAt = session?.activeAt
  useEffect(() => {
    const now = Date.now()
    const at = activeAt ? Date.parse(activeAt) : NaN
    const start = starting === null && !sentHere.current && at <= now ? at : now
    // eslint-disable-next-line react/set-state-in-effect
    setTurnStart(busy ? start : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read when the turn shows up
  }, [busy])

  // Commands and skills may have changed during the turn; ask again next time.
  useEffect(() => {
    if (sessionId && status === 'idle') forgetCommands(sessionId)
  }, [sessionId, status])

  // Rows of the loaded history appear at once; later ones animate in.
  const [listed, setListed] = useState<{ id?: string; at: number }>()
  const listedFor = listed?.id
  // After the commit on purpose: rows mounted with the history must not animate.
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => { if (history === 'ready') setListed({ id: sessionId, at: Date.now() }) }, [sessionId, history])
  // A request arrives when it opened after the session was listed here; the
  // inbox may load an older one a moment after the history.
  // (Before the route names the session, sessionId and listedFor are both
  // undefined: that is not "listed".)
  const arrivedNow = (r: SessionRequest) =>
    !!listed && listed.id === sessionId && !!sessionId && (!r.openedAt || Date.parse(r.openedAt) >= listed.at)
  useLayoutEffect(() => {
    if (!sessionId) return
    beginAgentView(sessionId)
    return () => endAgentView(sessionId)
  }, [sessionId])
  useLayoutEffect(() => { recordAgentCommit(sessionId) }, [chat, sessionId])

  // Back in a session read halfway, the owner is where they left it.
  const restored = useReadingPlace(sessionId, scrollRef, stick, chat.order.length > 0, history === 'ready')
  // Opening a session with news lands on the "new since you left" mark.
  const landed = useRef(false)
  useLayoutEffect(() => {
    if (landed.current || history !== 'ready' || chat.order.length === 0) return
    landed.current = true
    if (!unseen || restored.current) return
    const markEl = scrollRef.current?.querySelector('.unseen-mark')
    if (!markEl) return
    stick.unpin()
    markEl.scrollIntoView?.({ block: 'start' })
    // A chat too short to scroll is all in view: read, and nothing below.
    stick.recheck()
  }, [history, chat.order.length, unseen, stick, scrollRef, restored])

  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    // Stepping through the list with j/k only looks: the next j must step on.
    if (browsedTo(useSessionStore.getState().activeId ?? '')) return
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

  // restoreDraft puts a message that didn't go back, ahead of anything typed
  // since; if the owner moved to another session it waits in its draft.
  const restoreDraft = (message: string) => {
    if (!sessionId) return
    if (useSessionStore.getState().activeId !== sessionId) {
      const draft = loadDraft(sessionId)
      saveDraft(sessionId, draft.trim() ? `${message}\n\n${draft}` : message)
      return
    }
    const now = textRef.current
    setText(now.trim() ? `${message}\n\n${now}` : message)
  }

  // Messages go out one at a time, in the order they were sent; one sent
  // while another is on its way waits its turn (never merged, never lost).
  const queue = useRef<Outgoing[]>([])
  const pumping = useRef(false)
  // Whether the next message steers: the turn runs, or one just sent starts it.
  const live = useRef(busy)
  useLayoutEffect(() => {
    live.current = busy
  })
  const [inFlight, setInFlight] = useState<'send' | 'steer' | null>(null)

  const dispatch = async (out: Outgoing): Promise<boolean> => {
    // The owner moved on: what waits stays in this session's draft.
    if (useSessionStore.getState().activeId !== sessionId) return false
    const steerIt = live.current
    setInFlight(steerIt ? 'steer' : 'send')
    setPendingSends((list) => list.map((p) => (p.key === out.key ? { ...p, state: 'sending' } : p)))
    const before = currentMark()
    const accepted = steerIt ? await steer(out.value) : await send(out.value, out.images)
    if (!accepted) return false
    setPendingSends((list) => list.map((p) => (p.key === out.key ? { ...p, state: 'sent' } : p)))
    setTimeout(() => dropSend(out.key), ECHO_MS)
    if (!steerIt) {
      out.images.forEach(attachments.remove)
      live.current = true
      const after = currentMark()
      // The turn may already have started (or even ended) meanwhile.
      if (sameMark(before, after) && after.status !== 'running') setStarting(after)
    }
    if (useSessionStore.getState().activeId === sessionId) {
      stick.stick()
      // On a touch screen the keyboard goes, so the reply has the screen.
      if (!matches('(pointer: coarse)') && !document.activeElement?.closest('.request')) input.current?.focus()
    }
    return true
  }

  const pump = async () => {
    if (pumping.current) return
    pumping.current = true
    try {
      while (queue.current.length) {
        const out = queue.current[0]!
        // With go-chamber out of reach the message would only fail: it waits,
        // shown as on its way, and goes once the connection is back.
        await untilBack()
        const ok = await dispatch(out)
        queue.current.shift()
        if (ok) continue
        // What didn't go, and what waited behind it, goes back to the box.
        const back = [out, ...queue.current.splice(0)]
        const keys = new Set(back.map((o) => o.key))
        setPendingSends((list) => list.filter((p) => !keys.has(p.key)))
        const texts = back.map((o) => o.raw).filter((t) => t.trim())
        if (texts.length) restoreDraft(texts.join('\n\n'))
      }
    } finally {
      pumping.current = false
      setInFlight(null)
    }
  }

  const submit = () => {
    const value = text.trim()
    // Behind a message on its way, this one may well steer: text only.
    const textOnly = busy || queue.current.length > 0
    const images = textOnly ? [] : attachments.ids
    // A message sent mid-upload would go without the images still on their way.
    if (!textOnly && attachments.uploading) return
    if (!value && images.length === 0) return
    const key = ++nextSendKey
    const shown = value || (images.length === 1 ? '[1 image]' : `[${images.length} images]`)
    setPendingSends((list) => [...list, { key, text: shown, state: 'queued' }])
    // The message shows once: on its way in the transcript, not also here.
    if (value) setText('')
    sentHere.current = true
    queue.current.push({ key, value, raw: text, images })
    // The owner's own message is in view at once, even one that waits.
    stick.stick()
    void pump()
  }
  const submitting = inFlight !== null

  // Stop stays "Stopping…" from an accepted interrupt until the turn changes,
  // but not forever: with the agent quiet or the live socket down it lets go
  // and says the stop was sent.
  const [stopHeld, setStopHeld] = useState<TurnMark | null>(null)
  const [stopSent, setStopSent] = useState<TurnMark | null>(null)
  if (stopHeld && !sameMark(stopHeld, mark)) setStopHeld(null)
  if (stopSent && !sameMark(stopSent, mark)) setStopSent(null)
  if (stopHeld && sameMark(stopHeld, mark) && dropped) {
    setStopSent(stopHeld)
    setStopHeld(null)
  }
  useEffect(() => {
    if (!stopHeld) return
    const timer = setTimeout(() => {
      setStopSent(stopHeld)
      setStopHeld(null)
    }, SENT_HOLD_MS)
    return () => clearTimeout(timer)
  }, [stopHeld])
  const [stop, stopPending] = usePending(async () => {
    const before = currentMark()
    const ok = await interrupt()
    if (ok && sameMark(before, currentMark())) setStopHeld(before)
    return ok
  })
  const stopping = stopPending || stopHeld !== null
  const stopRef = useRef<(escape?: boolean) => void>(() => {})
  useEffect(() => {
    stopRef.current = (escape = false) => {
      if (busy && !stopping) void stop()
      // Nothing (more) to stop: Escape leaves the composer, so single-key
      // shortcuts (j/k, ?, r) answer again. A stop already on its way
      // counts as nothing more to stop.
      else if (!busy || escape) (document.activeElement as HTMLElement | null)?.blur()
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

  // Back in touch: a "not sent" from the outage is stale, what waited goes.
  const wasDropped = useRef(dropped)
  useEffect(() => {
    if (wasDropped.current && !dropped) useNotices.getState().dismissKey('send')
    wasDropped.current = dropped
  }, [dropped])

  const [fork, forking] = usePending(() => forkSession(sessionId!), { holdOnSuccess: true })
  // A session whose worktree folder is gone takes no more turns.
  const gone = session?.worktree?.removed ? session.worktree : undefined
  // Nor does one whose folder isn't there any more.
  const folderGone = !gone && Boolean(session?.folderGone)
  // Nor one whose agent CLI the server can't find (GET /api/agents).
  const noCLI = useCLIs((s) => s.clis.find((c) => c.agent === session?.agent && !c.found))
  const cliMissing = !gone && !folderGone ? noCLI : undefined

  // An answer that went through moves focus on: to the next request waiting,
  // or back to the composer, instead of dropping it on the page. One given
  // from the keyboard stays off the composer, so the next keys stay shortcuts.
  const answer = useCallback(
    async (sid: string, requestId: string, reply: RequestAnswerInput) => {
      const via = lastInput()
      const ok = await respond(sid, requestId, reply)
      if (ok) focusAfterAnswer(scrollRef.current, requestId, via === 'keyboard' ? scrollRef.current : input.current)
      return ok
    },
    [respond, scrollRef],
  )

  // The sessions list has every session (subagents too); one it lacks once
  // loaded, with nothing in its transcript, doesn't exist (the server answers
  // an unknown session's events with an empty list).
  const notFound = !session && sessionsStatus === 'ready' && history !== 'loading' && chat.order.length === 0
  const announcement = useAnnouncement(chat, history, status)

  const empty = !text.trim() && (busy || attachments.ids.length === 0)
  const sendLabel = attachments.uploading && !busy ? 'Uploading…' : inFlight === 'steer' ? 'Steering…' : inFlight === 'send' ? 'Sending…' : busy ? 'Steer' : 'Send'
  const sendBusy = submitting || (attachments.uploading && !busy)
  const mod = isMac() ? '⌘' : 'Ctrl+'
  const placeholder = busy ? 'Steer the running turn…' : 'Message the agent…'
  // A long message says how long it is; the box itself stops growing.
  const lines = text ? text.split('\n').length : 0
  const multiline = useMultiline(input, text)
  const section = useRef<HTMLElement>(null)
  useTypingMark(section)

  return (
    <main className="chat panel" aria-label="Chat" ref={section}>
      <ChatHeader
        session={session}
        status={shown}
        unsettled={dropped}
        loading={!session && sessionsStatus === 'loading'}
        notFound={notFound}
        forking={forking}
        onFork={() => void fork()}
      />
      <div className="sr-only chat-announce" role="status" aria-live="polite">
        <span key={announcement.n}>{announcement.text}</span>
      </div>
      {/* Focusable: a keyboard answer leaves focus here, where arrows scroll. */}
      <div className="scroll" ref={scrollRef} tabIndex={-1}>
        {!notFound && <TurnOutline entries={outline} scrollRef={scrollRef} reduced={reduced} />}
        {notFound ? null : history === 'loading' && chat.order.length === 0 ? (
          <div className="chat-loading">
            <Skeleton rows={4} label="Loading transcript" />
          </div>
        ) : (
          <SessionFiles.Provider value={sessionId}>
            <SessionFolder.Provider value={session?.cwd}>
              <ol className="items" aria-label="Transcript" aria-busy={streaming}>
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
                {pendingSends.map((p) => (
                  <li key={p.key} className="row row-user_message row-pending">
                    <div className="item user pending">
                      <div className="user-text">{p.text}</div>
                      <span className="pending-label">
                        {p.state === 'sending' ? 'sending…' : p.state === 'queued' && dropped ? 'queued · waits for go-chamber' : p.state}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            </SessionFolder.Provider>
          </SessionFiles.Provider>
        )}
        {notFound ? (
          <div className="chat-loading chat-missing">
            <p>No session lives at this address; it may have been removed.</p>
            <button type="button" className="btn" onClick={backToSessions}>
              Back to sessions
            </button>
          </div>
        ) : history === 'error' && (
          <div className="chat-loading">
            <LoadFailed onRetry={() => sessionId && void useSessionStore.getState().selectSession(sessionId)}>
              {failedTo('load the transcript', historyReason)}
            </LoadFailed>
          </div>
        )}
        {!notFound && !gone && !folderGone && history === 'ready' && chat.order.length === 0 && pendingSends.length === 0 && status !== 'interrupted' && !busy && (
          <div className="chat-hint">
            <p className="chat-hint-where">
              Send a message to start. The agent runs in <HintWhere session={session} />.
            </p>
            <p className="chat-hint-keys">
              <Keys keys="@" label="file" /> · <Keys keys="/" label="commands" /> · paste or {touch ? 'attach' : 'drop'} images
            </p>
          </div>
        )}
        {busy && (
          <WorkingTail
            since={turnStart}
            waiting={Object.keys(chat.requests).length > 0}
            streaming={wording}
            live={!dropped}
          />
        )}
        <AnimatePresence initial={false}>
          {Object.values(chat.requests).map((request, i, all) => (
            <RequestSlot key={request.id} id={request.id} arriving={arrivedNow(request)} reduced={reduced}>
              <RequestCard request={request} agent={session?.agent} onRespond={answer} position={{ index: i + 1, count: all.length }} />
            </RequestSlot>
          ))}
        </AnimatePresence>
        {!stick.pinned && (
          <div className="jump-latest">
            <button type="button" className="btn btn-xs" onClick={stick.stick}>
              latest <ArrowDown {...icon(12)} />
              {stick.unread > 0 && ` ${stick.unread}`}
            </button>
          </div>
        )}
      </div>
      {status === 'interrupted' && session && !gone && !folderGone && (
        <InterruptedBanner
          session={session}
          blocked={cliMissing ? 'The agent’s CLI is not installed' : undefined}
          onContinue={continueSession}
          onAutoContinue={(on) => setAutoContinue(session.id, on)}
        />
      )}
      <LiveStrip note={stopSent ? 'stop sent · waiting for the agent' : undefined} />
      {!notFound && session && !gone && <UnmergedNote session={session} />}
      {!notFound && session && gone && <WorktreeGone session={session} worktree={gone} />}
      {!notFound && session && folderGone && <FolderGone session={session} />}
      {!notFound && session && cliMissing && <CLIMissing cli={cliMissing} />}
      {!notFound && !gone && !folderGone && !cliMissing && (
      <form
        className={['composer', attachments.dragging && 'dragging', multiline && 'multiline'].filter(Boolean).join(' ')}
        {...attachments.dropProps}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <ComposerInput
          inputRef={input}
          sessionId={sessionId}
          agent={session?.agent}
          value={text}
          onChange={setText}
          onSubmit={() => submit()}
          onEscape={() => {
            if (!text) stopRef.current(true)
          }}
          history={sent}
          enterSends={!touch}
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
          {lines > LONG_DRAFT_LINES && <span className="composer-note composer-lines">{lines} lines</span>}
          {!narrow && !touch && (
            <span className="composer-keys" aria-hidden="true">
              <Keys keys="↵" label={busy ? 'steer' : 'send'} /> · <Keys keys="⇧↵" label="newline" />
            </span>
          )}
          <button
            type="submit"
            className="btn btn-primary"
            aria-busy={sendBusy}
            disabled={empty && !sendBusy}
            title={`${busy ? 'Steer' : 'Send'} (${touch ? `${mod}↵` : '↵'})`}
            aria-keyshortcuts={touch ? (isMac() ? 'Meta+Enter' : 'Control+Enter') : 'Enter'}
          >
            {sendLabel}
          </button>
        </div>
      </form>
      )}
    </main>
  )
}

// HintWhere names the session folder in the first-message hint: a worktree
// as the header names it, its repository and branch, the folder on hover.
function HintWhere({ session }: { session: Session | undefined }) {
  const wt = session?.worktree
  if (!wt) return <>{session?.cwd ?? 'the session folder'}</>
  return (
    <span title={wt.path}>
      {basename(wt.repo)} ⎇ {wt.branch.replace(/^chamber\//, '')}
    </span>
  )
}

// WorkingTail ends a running turn's transcript: the running mark and how
// long the turn has taken, or that it waits for the owner. While text streams
// the words speak for themselves and only the clock stays. Without the live
// socket the page can't know the turn still runs, so the clock stops.
function WorkingTail({ since, waiting, streaming, live }: { since: number | null; waiting: boolean; streaming: boolean; live: boolean }) {
  const [mounted] = useState(() => Date.now())
  const now = useNow(live && !waiting ? 1000 : null)
  const start = since ?? mounted
  const clock = elapsed(Math.max(0, now - start))
  // Live updates paused (the strip above the composer says so): the clock
  // stops rather than run on for a turn the page can't see.
  const text = waiting ? 'waiting for you' : !live ? 'working · paused' : streaming ? clock : `working · ${clock}`
  const cls = ['working-tail', waiting && 'waiting', !live && !waiting && 'stale', streaming && !waiting && live && 'streaming']
  return (
    <div className={cls.filter(Boolean).join(' ')} aria-hidden={waiting ? undefined : true}>
      {text}
    </div>
  )
}

// useMultiline tells a draft that takes more than one line, by a newline or
// by wrapping: it then gets the composer's whole width, the actions beneath.
// A wrapped draft stays multiline until it is shorter than where it wrapped,
// so the wider box doesn't flip it back and forth.
function useMultiline(input: React.RefObject<HTMLTextAreaElement | null>, text: string): boolean {
  const [wrapAt, setWrapAt] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (wrapAt !== null) {
      // eslint-disable-next-line react/set-state-in-effect -- measured layout
      if (text.length < wrapAt) setWrapAt(null)
      return
    }
    const el = input.current
    if (!el || !text || text.includes('\n')) return
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20
    if (el.scrollHeight > line * 1.6 + 10) setWrapAt(text.length)
  }, [input, text, wrapAt])
  return text.includes('\n') || (wrapAt !== null && text.length >= wrapAt)
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

// focusAfterAnswer moves focus on from an answered request: to the next
// request still waiting, else to `then` (the composer after a click, the
// transcript after a key; with a mouse only: on a phone the composer would
// pop the keyboard). A touch screen brings the next request into view
// without focusing it. Focus the owner already moved elsewhere stays.
function focusAfterAnswer(root: HTMLElement | null, answered: string, then: HTMLElement | null) {
  const active = document.activeElement
  const card = active instanceof Element ? active.closest('[data-request-id]') : null
  const lost = !active || active === document.body || card?.getAttribute('data-request-id') === answered
  if (!lost || !root) return
  const waiting = useSessionStore.getState().chat.requests
  const next = Array.from(root.querySelectorAll<HTMLElement>('.request-slot[data-request-id]')).find((el) => {
    const id = el.dataset.requestId
    return id && id !== answered && waiting[id]
  })
  if (next && matches('(pointer: coarse)')) next.scrollIntoView?.({ block: 'nearest' })
  else if (next) next.focus()
  else if (matches('(pointer: fine)')) then?.focus()
}

// backToSessions leaves a session that doesn't exist for the sessions list.
function backToSessions() {
  window.history.pushState(null, '', '/' + window.location.search)
  useSessionStore.setState({ activeId: null, pane: 'sessions' })
}

// A pending request is the one thing the user must act on: bring all of it
// into view when it arrives or when the session opens.
function scrollOnMount(el: HTMLDivElement | null) {
  el?.scrollIntoView?.({ block: 'nearest' })
}

// RequestSlot holds a request above the composer. One that arrives while the
// session is open is marked arriving for good (its rule draws across, once);
// one already open when the session was opened just is there.
function RequestSlot({ id, arriving, reduced, children }: { id: string; arriving: boolean; reduced: boolean; children: ReactNode }) {
  const [arrived] = useState(arriving)
  return (
    <motion.div
      className="request-slot"
      {...enter(reduced, 'margin')}
      exit={reduced ? { opacity: 0 } : resolve}
      ref={scrollOnMount}
      data-request-id={id}
      data-arriving={arrived || undefined}
      tabIndex={-1}
    >
      {children}
    </motion.div>
  )
}
