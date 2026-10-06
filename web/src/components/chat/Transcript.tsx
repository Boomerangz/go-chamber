import { Fragment, memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { FilePen, Terminal, Webhook, Workflow, Wrench } from 'lucide-react'
import { icon } from '../icon'
import Markdown from '../markdown/Markdown'
import CopyButton from '../markdown/CopyButton'
import ReasoningView from './ReasoningView'
import { imageUrl, type Item } from '../../lib/api'
import { TURN_FAILED } from '../../lib/events'
import { enter } from '../../lib/motion'
import { usePending } from '../../lib/pending'
import { toolInput, toolLabel, toolSummary } from '../../lib/toolSummary'
import { sameNode, type ItemNode } from '../../lib/tree'
import './Transcript.css'

type StopTask = (sessionId: string, taskId: string) => Promise<unknown> | void

export interface RowProps {
  node: ItemNode
  turn: number | undefined
  unseen: boolean
  reduced: boolean
  // animateIn only matters when the row mounts.
  animateIn: boolean
  onStopTask: StopTask
}

// Row skips rendering unless its items changed: typing in the composer or
// streaming into the last item must not re-render a long transcript. The list
// has no AnimatePresence: its per-render key diffing is quadratic and its
// fresh context re-rendered every memoized row.
export const Row = memo(function Row({ node, turn, unseen, reduced, animateIn, onStopTask }: RowProps) {
  const motionProps = enter(reduced)
  return (
    <Fragment>
      {unseen && (
        <li className="unseen-mark" aria-label="New since your last visit">
          new since you left
        </li>
      )}
      <motion.li
        className={`row row-${node.item.kind}`}
        initial={animateIn ? motionProps.initial : false}
        animate={motionProps.animate}
        transition={motionProps.transition}
      >
        {turn !== undefined && (
          <span className="turn-no" aria-label={`turn ${turn}`}>
            {turn}.
          </span>
        )}
        <ItemView node={node} onStopTask={onStopTask} />
      </motion.li>
    </Fragment>
  )
}, (a, b) => a.turn === b.turn && a.unseen === b.unseen && a.reduced === b.reduced &&
  a.onStopTask === b.onStopTask && sameNode(a.node, b.node))

const live = (item: Item) => item.status === 'streaming' || item.status === 'pending'

function ItemView({ node, onStopTask }: { node: ItemNode; onStopTask: StopTask }) {
  const item = node.item
  const failed = item.status === 'failed'
  switch (item.kind) {
    case 'user_message':
      return <UserMessage item={item} />
    case 'assistant_message':
      return <AssistantMessage item={item} />
    case 'reasoning':
      return <ReasoningView text={item.text ?? ''} streaming={live(item)} />
    case 'plan':
      return (
        <div className="item plan">
          <Markdown text={item.text ?? ''} />
        </div>
      )
    case 'error':
      return <ErrorView item={item} />
    case 'command':
      return (
        <div className={`item command state-${item.status}`}>
          <ItemIcon label="command" item={item}>
            <Terminal {...icon(13)} />
          </ItemIcon>
          <span className="item-line">
            <code>{commandText(item)}</code>
            {item.exitCode !== undefined && (
              <span className={`exit-tag${item.exitCode !== 0 ? ' exit-bad' : ''}`}>exit {item.exitCode}</span>
            )}
          </span>
          {item.text && <Folded label="Output" text={item.text} open={failed} streaming={live(item)} preview />}
        </div>
      )
    case 'file_change':
      return (
        <div className={`item file state-${item.status}`}>
          <ItemIcon label="file change" item={item}>
            <FilePen {...icon(13)} />
          </ItemIcon>
          <code>{item.path || item.name}</code>
          {item.diff && <Folded label="Diff" text={item.diff} open={failed} />}
        </div>
      )
    case 'hook':
      return <HookView item={item} />
    case 'decision':
      return (
        <div className={`item decision decision-${item.decision ?? 'answered'}`}>
          <span className="decision-kw">{item.decision ?? 'answered'}</span>
          <span className="decision-name">{item.name || 'Request'}</span>
          {item.text && <span className="decision-text">{item.text}</span>}
        </div>
      )
    case 'subagent':
      return <SubagentView node={node} onStopTask={onStopTask} />
    default: {
      const summary = toolSummary(item)
      const input = toolInput(item.input)
      return (
        <div className={`item tool state-${item.status}`}>
          <ItemIcon label="tool" item={item}>
            <Wrench {...icon(13)} />
          </ItemIcon>
          <span className="item-line">
            <code title={item.name}>{toolLabel(item.name)}</code>
            {summary && (
              <span className="item-summary" title={summary}>
                {summary}
              </span>
            )}
          </span>
          {input && <Folded label="Input" text={input} />}
          {item.text && <Folded label="Output" text={item.text} open={failed} streaming={live(item)} preview />}
        </div>
      )
    }
  }
}

// ItemIcon pairs a drawn icon with words for a screen reader: what the line
// is and, when it is not simply done, its state.
function ItemIcon({ label, item, children }: { label: string; item: Item; children: ReactNode }) {
  const state = item.status === 'failed' ? 'failed' : live(item) ? 'running' : ''
  const words = [label, state].filter(Boolean).join(', ')
  return (
    <span className="item-icon">
      {children}
      {words && <span className="sr-only">{words}</span>}
    </span>
  )
}

// A user message this long folds behind "show more": a pasted log should not
// push the answer off screen.
const LONG_LINES = 20
const LONG_CHARS = 2000

function UserMessage({ item }: { item: Item }) {
  const text = item.text ?? ''
  const long = text.split('\n').length > LONG_LINES || text.length > LONG_CHARS
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={`item user${long && !expanded ? ' folded' : ''}`}>
      <div className="user-text">{text}</div>
      {long && (
        <button type="button" className="act-link" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'show less' : 'show more'}
        </button>
      )}
      {item.images?.length ? (
        <div className="item-images">
          {item.images.map((id) => (
            <a key={id} href={imageUrl(item.sessionId, id)} target="_blank" rel="noopener noreferrer">
              <img src={imageUrl(item.sessionId, id)} alt="attached image" loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// AssistantMessage ends in a caret while it streams; once done, the raw
// markdown can be copied whole.
function AssistantMessage({ item }: { item: Item }) {
  const streaming = live(item)
  const text = item.text ?? ''
  return (
    <div className={`item assistant${streaming ? ' streaming' : ''}`}>
      <Markdown text={text} />
      {!streaming && text.trim() && <CopyButton text={text} label="Copy message" iconOnly className="msg-copy" />}
    </div>
  )
}

// ErrorView shows what broke, in the open: an error folded away reads as a
// normal finish.
function ErrorView({ item }: { item: Item }) {
  return (
    <div className="item item-error">
      <span className="error-kw">{item.name === TURN_FAILED ? 'turn failed' : 'error'}</span>
      <span className="error-text">{item.text?.trim() || 'Something went wrong.'}</span>
    </div>
  )
}

function SubagentView({ node, onStopTask }: { node: ItemNode; onStopTask: StopTask }) {
  const item = node.item
  const type = inputString(item.input, 'subagent_type')
  const summary = toolSummary(item)
  const about = summary !== type ? summary : undefined
  // Stopping removes the button when the task ends, so it stays busy after
  // the request went through.
  const [stop, stopping] = usePending(async () => onStopTask(item.sessionId, item.agentId!), { holdOnSuccess: true })
  return (
    <div className={`item subagent state-${item.status}`}>
      <div className="subagent-head">
        <ItemIcon label="" item={item}>
          <Workflow {...icon(13)} />
        </ItemIcon>
        <span className="subagent-name">subagent: {type || item.name || 'agent'}</span>
        {about && (
          <span className="item-summary" title={about}>
            {about}
          </span>
        )}
        {item.agentId && item.status !== 'completed' && item.status !== 'failed' && (
          <button
            type="button"
            className="btn btn-ghost btn-xs stop-task"
            aria-busy={stopping}
            onClick={() => void stop()}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
      {item.text && <Folded label="Output" text={item.text} open={item.status === 'failed'} />}
      {node.children.length > 0 && (
        <ol className="subagent-items">
          {node.children.map((child) => (
            <li key={child.item.id}>
              <ItemView node={child} onStopTask={onStopTask} />
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

// Folded keeps tool output out of the way: long command output and diffs
// used to fill the whole chat. The summary says how much is inside and, with
// preview, its last line. Failed output opens by itself; streaming output
// stays scrolled to its end unless the reader scrolled up.
const Folded = memo(function Folded({
  label,
  text,
  open = false,
  streaming = false,
  preview = false,
}: {
  label: string
  text: string
  open?: boolean
  streaming?: boolean
  preview?: boolean
}) {
  const lines = text.replace(/\n$/, '').split('\n')
  const last = preview ? lines.findLast((line) => line.trim())?.trim() : undefined
  const pre = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  const toEnd = () => {
    const el = pre.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }
  useLayoutEffect(() => {
    if (streaming) toEnd()
  }, [text, streaming])
  return (
    <details
      className="item-output"
      open={open || undefined}
      onToggle={(e) => {
        if (streaming && e.currentTarget.open) toEnd()
      }}
    >
      <summary>
        <span className="item-output-label">
          {label} · {lines.length} {lines.length === 1 ? 'line' : 'lines'}
        </span>
        {last && (
          <span className="item-output-preview" title={last}>
            {last}
          </span>
        )}
      </summary>
      <div className="item-output-body">
        <pre
          ref={pre}
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
          }}
        >
          {text}
        </pre>
        <CopyButton text={text} className="item-output-copy" />
      </div>
    </details>
  )
})

const hookBadge: Record<string, string> = { success: 'ok', blocked: 'blocked', error: 'error' }

// HookView shows a user-configured hook the agent ran; a hook that blocked
// the agent explains why the agent continued.
function HookView({ item }: { item: Item }) {
  const outcome = item.outcome ?? (live(item) ? 'running' : 'success')
  const head = (
    <>
      <span className="item-icon">
        <Webhook {...icon(13)} />
      </span>
      <span className="hook-name">{item.name} hook</span>
      <span className={`hook-badge hook-${outcome}`}>{hookBadge[outcome] ?? outcome}</span>
      {item.text && (
        <span className="hook-preview" title={item.text}>
          {item.text}
        </span>
      )}
    </>
  )
  if (!item.text) return <div className={`item hook outcome-${outcome}`}>{head}</div>
  return (
    <details className={`item hook outcome-${outcome}`}>
      <summary>{head}</summary>
      <pre>{item.text}</pre>
    </details>
  )
}

function inputString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function commandText(item: Item): string {
  const input = item.input
  if (input && typeof input === 'object' && 'command' in input) {
    return String((input as { command: unknown }).command)
  }
  return item.name ?? 'command'
}
