import { Fragment, memo } from 'react'
import { motion } from 'motion/react'
import { FilePen, Terminal, Webhook, Workflow, Wrench } from 'lucide-react'
import { icon } from '../icon'
import Markdown from '../markdown/Markdown'
import ReasoningView from './ReasoningView'
import { imageUrl, type Item } from '../../lib/api'
import { enter } from '../../lib/motion'
import { sameNode, type ItemNode } from '../../lib/tree'

export interface RowProps {
  node: ItemNode
  turn: number | undefined
  unseen: boolean
  reduced: boolean
  // animateIn only matters when the row mounts.
  animateIn: boolean
  onStopTask: (sessionId: string, taskId: string) => void
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

function ItemView({
  node,
  onStopTask,
}: {
  node: ItemNode
  onStopTask: (sessionId: string, taskId: string) => void
}) {
  const item = node.item
  switch (item.kind) {
    case 'user_message':
      return (
        <div className="item user">
          {item.text}
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
    case 'assistant_message':
      return (
        <div className="item assistant">
          <Markdown text={item.text ?? ''} />
        </div>
      )
    case 'reasoning':
      return <ReasoningView text={item.text ?? ''} />
    case 'plan':
      return (
        <div className="item plan">
          <Markdown text={item.text ?? ''} />
        </div>
      )
    case 'command':
      return (
        <div className={`item command state-${item.status}`}>
          <span className="item-icon">
            <Terminal {...icon(13)} />
          </span>
          <code>{commandText(item)}</code>
          {item.text && <Folded label="Output" text={item.text} />}
        </div>
      )
    case 'file_change':
      return (
        <div className={`item file state-${item.status}`}>
          <span className="item-icon">
            <FilePen {...icon(13)} />
          </span>
          <code>{item.path || item.name}</code>
          {item.diff && <Folded label="Diff" text={item.diff} />}
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
      return (
        <div className={`item subagent state-${item.status}`}>
          <div className="subagent-head">
            <span className="item-icon">
              <Workflow {...icon(13)} />
            </span>
            <span>subagent: {item.name}</span>
            {item.agentId && item.status !== 'completed' && item.status !== 'failed' && (
              <button className="btn btn-ghost btn-xs stop-task" onClick={() => onStopTask(item.sessionId, item.agentId!)}>
                Stop
              </button>
            )}
          </div>
          {item.text && <Folded label="Output" text={item.text} />}
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
    default:
      return (
        <div className={`item tool state-${item.status}`}>
          <span className="item-icon">
            <Wrench {...icon(13)} />
          </span>
          <code>{item.name}</code>
          {item.text && <Folded label="Output" text={item.text} />}
        </div>
      )
  }
}

// Folded keeps tool output out of the way: long command output and diffs
// used to fill the whole chat. The summary says how much is inside.
const Folded = memo(function Folded({ label, text }: { label: string; text: string }) {
  const lines = text.replace(/\n$/, '').split('\n').length
  return (
    <details className="item-output">
      <summary>
        {label} · {lines} {lines === 1 ? 'line' : 'lines'}
      </summary>
      <pre>{text}</pre>
    </details>
  )
})

const hookBadge: Record<string, string> = { success: 'ok', blocked: 'blocked', error: 'error' }

// HookView shows a user-configured hook the agent ran; a hook that blocked
// the agent explains why the agent continued.
function HookView({ item }: { item: Item }) {
  const outcome = item.outcome ?? (item.status === 'streaming' || item.status === 'pending' ? 'running' : 'success')
  const head = (
    <>
      <span className="item-icon">
        <Webhook {...icon(13)} />
      </span>
      <span className="hook-name">{item.name} hook</span>
      <span className={`hook-badge hook-${outcome}`}>{hookBadge[outcome] ?? outcome}</span>
      {item.text && <span className="hook-preview">{item.text}</span>}
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

function commandText(item: Item): string {
  const input = item.input
  if (input && typeof input === 'object' && 'command' in input) {
    return String((input as { command: unknown }).command)
  }
  return item.name ?? 'command'
}
