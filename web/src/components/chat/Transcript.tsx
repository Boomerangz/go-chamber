import { Fragment, memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { FilePen, ListTree, Terminal, Webhook, Workflow, Wrench } from 'lucide-react'
import { icon } from '../icon'
import Markdown from '../markdown/Markdown'
import CopyButton from '../markdown/CopyButton'
import ShowAll from '../markdown/ShowAll'
import { useClip } from '../markdown/useClip'
import InlineDiff from './InlineDiff'
import ReasoningView from './ReasoningView'
import { imageUrl, type Item, type TurnResult } from '../../lib/api'
import { diffStat, diffText, editDiff, formatStat, parseUnified, type DiffLine } from '../../lib/diff'
import { TURN_FAILED } from '../../lib/events'
import { groupSummary } from '../../lib/group'
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
  // onRetry sends the failed turn's message again; given only to the error
  // that ends the transcript.
  onRetry?: () => Promise<unknown> | void
  // onEdit puts a message of the owner's back into the composer.
  onEdit?: (text: string) => void
  // result is the turn result when this row ends a finished turn.
  result?: TurnResult
}

// Row skips rendering unless its items changed: typing in the composer or
// streaming into the last item must not re-render a long transcript. The list
// has no AnimatePresence: its per-render key diffing is quadratic and its
// fresh context re-rendered every memoized row.
export const Row = memo(function Row({ node, turn, unseen, reduced, animateIn, onStopTask, onRetry, onEdit, result }: RowProps) {
  const motionProps = enter(reduced)
  return (
    <Fragment>
      {unseen && (
        <li className="unseen-mark" aria-label="New since your last visit">
          new since you left
        </li>
      )}
      <motion.li
        className={`row row-${node.group ? 'tool_group' : node.item.kind}`}
        initial={animateIn ? motionProps.initial : false}
        animate={motionProps.animate}
        transition={motionProps.transition}
      >
        {turn !== undefined && (
          <span className="turn-no" aria-label={`turn ${turn}`}>
            {turn}.
          </span>
        )}
        {node.group ? (
          <GroupView nodes={node.group} onStopTask={onStopTask} />
        ) : (
          <ItemView node={node} onStopTask={onStopTask} onRetry={onRetry} onEdit={onEdit} />
        )}
      </motion.li>
      {result && <TurnFoot result={result} />}
    </Fragment>
  )
}, (a, b) => a.turn === b.turn && a.unseen === b.unseen && a.reduced === b.reduced &&
  a.onStopTask === b.onStopTask && a.onRetry === b.onRetry && a.onEdit === b.onEdit && a.result === b.result &&
  sameNode(a.node, b.node))

const live = (item: Item) => item.status === 'streaming' || item.status === 'pending'

// Tools whose input is an edit to a file, drawn as a diff.
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

interface ItemViewProps {
  node: ItemNode
  onStopTask: StopTask
  onRetry?: () => Promise<unknown> | void
  onEdit?: (text: string) => void
}

function ItemView({ node, onStopTask, onRetry, onEdit }: ItemViewProps) {
  const item = node.item
  const failed = item.status === 'failed'
  switch (item.kind) {
    case 'user_message':
      return <UserMessage item={item} onEdit={onEdit} />
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
      return <ErrorView item={item} onRetry={onRetry} />
    case 'command':
      return (
        <div className={`item command state-${item.status}`}>
          <ItemIcon label="command" item={item}>
            <Terminal {...icon(13)} />
          </ItemIcon>
          <span className="item-line">
            <code>{commandText(item)}</code>
            {item.exitCode !== undefined ? (
              <span className={`exit-tag${item.exitCode !== 0 ? ' exit-bad' : ''}`}>exit {item.exitCode}</span>
            ) : (
              // Finished without an exit code: refused before it ran.
              item.status === 'completed' && <span className="exit-tag">not run</span>
            )}
          </span>
          {item.text && <Folded label="Output" text={item.text} open={failed} streaming={live(item)} preview />}
        </div>
      )
    case 'file_change': {
      const lines = item.diff ? parseUnified(item.diff) : editDiff(item.input)
      return (
        <div className={`item file state-${item.status}`}>
          <ItemIcon label="file change" item={item}>
            <FilePen {...icon(13)} />
          </ItemIcon>
          <code>{item.path || item.name}</code>
          {lines && lines.length > 0 ? (
            <DiffFold lines={lines} raw={item.diff} open={failed} />
          ) : (
            <InputFold input={item.input} />
          )}
        </div>
      )
    }
    case 'hook':
      return <HookView item={item} />
    case 'decision':
      return <DecisionView item={item} />
    case 'subagent':
      return <SubagentView node={node} onStopTask={onStopTask} />
    default: {
      const summary = toolSummary(item)
      const edit = item.name && EDIT_TOOLS.has(item.name) ? editDiff(item.input) : null
      const diffed = !!edit && edit.length > 0
      const head = (
        <>
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
        </>
      )
      // The diff shows what an edit's input says; other input folds behind
      // the line itself rather than a row of its own.
      const input = diffed ? undefined : toolInput(item.input)
      return (
        <div className={`item tool state-${item.status}`}>
          {input ? (
            <details className="tool-line">
              <summary title="Show input">{head}</summary>
              <div className="item-output-body">
                <pre>{input}</pre>
                <CopyButton text={input} className="item-output-copy" />
              </div>
            </details>
          ) : (
            head
          )}
          {diffed && <DiffFold lines={edit} />}
          {item.text && <Folded label="Output" text={item.text} open={failed} streaming={live(item)} preview />}
        </div>
      )
    }
  }
}

function InputFold({ input }: { input: unknown }) {
  const text = toolInput(input)
  return text ? <Folded label="Input" text={text} /> : null
}

// DiffFold folds a diff behind its +/− count; the copy is the diff as text.
function DiffFold({ lines, raw, open = false }: { lines: DiffLine[]; raw?: string; open?: boolean }) {
  const isDiff = lines.some((line) => line.kind !== 'ctx')
  return (
    <Folded label="Diff" text={raw ?? diffText(lines)} stat={isDiff ? formatStat(diffStat(lines)) : undefined} open={open}>
      <InlineDiff lines={lines} />
    </Folded>
  )
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

// useTapActions shows a message's actions after a tap on the message: a
// touch screen has no hover, and a row of buttons under every message would
// double the transcript. A tap on a link, a button or a selection of text
// leaves them as they are; the stylesheet uses the class only on touch.
function useTapActions(): [boolean, (e: React.MouseEvent) => void] {
  const [shown, setShown] = useState(false)
  const onClick = (e: React.MouseEvent) => {
    if ((e.target as Element).closest('a, button, summary, input, textarea, select')) return
    if (window.getSelection()?.toString()) return
    setShown((v) => !v)
  }
  return [shown, onClick]
}

// A user message this long folds behind "show more": a pasted log should not
// push the answer off screen.
const LONG_LINES = 20
const LONG_CHARS = 2000

// UserMessage is a turn's opening words, which can be copied or taken back
// into the composer to send again.
function UserMessage({ item, onEdit }: { item: Item; onEdit?: (text: string) => void }) {
  const text = item.text ?? ''
  const long = text.split('\n').length > LONG_LINES || text.length > LONG_CHARS
  const [expanded, setExpanded] = useState(false)
  const [actions, tap] = useTapActions()
  return (
    <div className={`item user${long && !expanded ? ' folded' : ''}${actions ? ' actions-shown' : ''}`} onClick={tap}>
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
      {text.trim() && (
        <div className="msg-actions">
          <CopyButton text={text} label="Copy" className="msg-action" />
          {onEdit && (
            <button type="button" className="btn btn-ghost btn-xs msg-action" onClick={() => onEdit(text)}>
              Edit
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// AssistantMessage ends in a caret while it streams; once done, the raw
// markdown can be copied whole.
function AssistantMessage({ item }: { item: Item }) {
  const streaming = live(item)
  const text = item.text ?? ''
  const [actions, tap] = useTapActions()
  return (
    <div className={`item assistant${streaming ? ' streaming' : ''}${actions ? ' actions-shown' : ''}`} onClick={tap}>
      <Markdown text={text} />
      {!streaming && text.trim() && <CopyButton text={text} label="Copy reply" iconOnly className="msg-copy" />}
    </div>
  )
}

// ErrorView shows what broke, in the open: an error folded away reads as a
// normal finish. The error that ends the transcript offers to try again.
function ErrorView({ item, onRetry }: { item: Item; onRetry?: () => Promise<unknown> | void }) {
  const [retry, retrying] = usePending(async () => onRetry?.())
  return (
    <div className="item item-error">
      <span className="error-kw">{item.name === TURN_FAILED ? 'turn failed' : 'error'}</span>
      <span className="error-text">{item.text?.trim() || 'Something went wrong.'}</span>
      {onRetry && (
        <button type="button" className="act-link error-retry" aria-busy={retrying} onClick={() => void retry()}>
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  )
}

// A request without a name of its own; its record says what was decided.
const GENERIC_REQUESTS = new Set(['', 'Question', 'Request', 'AskUserQuestion'])
// Questions: declining one skips it, which is no refusal of anything.
const QUESTIONS = new Set(['Question', 'AskUserQuestion'])

// DecisionView is the one-line record an answered request leaves: the
// outcome keyword and the request struck through, its detail beneath. A
// question has no name worth striking; its record is the answer, read plainly.
function DecisionView({ item }: { item: Item }) {
  const name = item.name?.trim() ?? ''
  const skipped = item.decision === 'denied' && QUESTIONS.has(name)
  const decision = skipped ? 'skipped' : (item.decision ?? 'answered')
  const named = !GENERIC_REQUESTS.has(name)
  const answer = !named && decision === 'answered'
  return (
    <div className={`item decision decision-${decision}${answer ? ' decision-answer' : ''}`}>
      <span className="decision-kw">{decision}</span>
      {!answer && !skipped && <span className="decision-name">{item.name || 'Request'}</span>}
      {item.text && <span className="decision-text">{item.text}</span>}
    </div>
  )
}

// stepLine says in one line what a subagent's step was.
function stepLine(item: Item): string {
  switch (item.kind) {
    case 'assistant_message':
    case 'plan':
    case 'reasoning':
    case 'error':
      return item.text?.trim().split('\n')[0]?.trim() || item.kind
    case 'command':
      return commandText(item)
    case 'file_change':
      return `edit ${item.path || item.name || ''}`.trim()
    default: {
      const summary = toolSummary(item)
      return summary ? `${toolLabel(item.name)} ${summary}` : toolLabel(item.name)
    }
  }
}

function SubagentView({ node, onStopTask }: { node: ItemNode; onStopTask: StopTask }) {
  const item = node.item
  const type = inputString(item.input, 'subagent_type')
  const summary = toolSummary(item)
  const about = summary !== type ? summary : undefined
  const finished = item.status === 'completed' || item.status === 'failed'
  // Stopping removes the button when the task ends, so it stays busy after
  // the request went through.
  const [stop, stopping] = usePending(async () => onStopTask(item.sessionId, item.agentId!), { holdOnSuccess: true })
  const steps = node.children.length > 0 && (
    <ol className="subagent-items">
      {node.children.map((child) => (
        <li key={child.item.id}>
          <ItemView node={child} onStopTask={onStopTask} />
        </li>
      ))}
    </ol>
  )
  const last = node.children.length > 0 ? stepLine(node.children[node.children.length - 1]!.item) : ''
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
        {item.agentId && !finished && (
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
      {/* A finished subagent folds its steps away; a running one shows them. */}
      {steps && finished ? (
        <details className="item-output subagent-steps">
          <summary>
            <span className="item-output-label">
              {node.children.length} {node.children.length === 1 ? 'step' : 'steps'}
            </span>
            <span className="item-output-preview" title={last}>
              last: {last}
            </span>
          </summary>
          {steps}
        </details>
      ) : (
        steps
      )}
    </div>
  )
}

// GroupView is a run of finished tool lines folded into one line saying what
// they did; opened, it lists them as they were.
function GroupView({ nodes, onStopTask }: { nodes: ItemNode[]; onStopTask: StopTask }) {
  const [open, setOpen] = useState(false)
  const summary = groupSummary(nodes)
  return (
    <details className="item tool-group" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="item-icon">
          <ListTree {...icon(13)} />
          <span className="sr-only">{nodes.length} tool calls</span>
        </span>
        <span className="tool-group-label" title={summary}>
          {summary}
        </span>
      </summary>
      {open && (
        <ol className="tool-group-items">
          {nodes.map((member) => (
            <li key={member.item.id}>
              <ItemView node={member} onStopTask={onStopTask} />
            </li>
          ))}
        </ol>
      )}
    </details>
  )
}

const numberFormat = new Intl.NumberFormat('en-US')

// TurnFoot closes a finished turn with what its result says it cost.
function TurnFoot({ result }: { result: TurnResult }) {
  const parts: string[] = []
  if (result.inputTokens) parts.push(`${numberFormat.format(result.inputTokens)} in`)
  if (result.outputTokens) parts.push(`${numberFormat.format(result.outputTokens)} out`)
  if (result.costUsd) parts.push(`$${result.costUsd.toFixed(4)}`)
  if (parts.length === 0) return null
  return (
    <li className="turn-foot" aria-label="turn usage">
      {parts.join(' · ')}
    </li>
  )
}

// Folded keeps tool output out of the way: long command output and diffs
// used to fill the whole chat. The summary says how much is inside (or, with
// stat, the +/− count of a diff) and, with preview, its last line. Failed
// output opens by itself; streaming output stays scrolled to its end unless
// the reader scrolled up. children replace the plain text body.
const Folded = memo(function Folded({
  label,
  text,
  open = false,
  streaming = false,
  preview = false,
  stat,
  children,
}: {
  label: string
  text: string
  open?: boolean
  streaming?: boolean
  preview?: boolean
  stat?: string
  children?: ReactNode
}) {
  const lines = text.replace(/\n$/, '').split('\n')
  const last = preview ? lines.findLast((line) => line.trim())?.trim() : undefined
  const [shown, setShown] = useState(open)
  const [pre, clip] = useClip<HTMLPreElement>([text, shown])
  const stick = useRef(true)
  const toEnd = () => {
    const el = pre.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }
  useLayoutEffect(() => {
    if (streaming) toEnd()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toEnd reads refs only
  }, [text, streaming])
  return (
    <details
      className="item-output"
      open={open || undefined}
      onToggle={(e) => {
        setShown(e.currentTarget.open)
        if (streaming && e.currentTarget.open) toEnd()
      }}
    >
      <summary>
        <span className="item-output-label">
          {label} ·{' '}
          {stat ? <span className="diff-stat">{stat}</span> : `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`}
        </span>
        {last && (
          <span className="item-output-preview" title={last}>
            {last}
          </span>
        )}
      </summary>
      <div className="item-output-body">
        {children ?? (
          <pre
            ref={pre}
            className={clip.full ? 'full' : undefined}
            onScroll={(e) => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
            }}
          >
            {text}
          </pre>
        )}
        <CopyButton text={text} className="item-output-copy" />
      </div>
      {!children && <ShowAll clip={clip} lines={lines.length} />}
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
