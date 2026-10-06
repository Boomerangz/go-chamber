import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Row, type RowProps } from './Transcript'
import type { Item } from '../../lib/api'
import type { ItemNode } from '../../lib/tree'
import { TURN_FAILED } from '../../lib/events'

const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

const item = (over: Partial<Item>): Item => ({ id: 'i1', sessionId: 's1', kind: 'tool_call', status: 'completed', ...over })

function show(it: Item, over: Partial<RowProps> = {}, children: Item[] = []) {
  const props: RowProps = {
    node: { item: it, children: children.map((c) => ({ item: c, children: [] })) },
    turn: undefined,
    unseen: false,
    reduced: true,
    animateIn: false,
    onStopTask: vi.fn(),
    ...over,
  }
  const view = render(
    <ol>
      <Row {...props} />
    </ol>,
  )
  return { ...view, props }
}

describe('errors', () => {
  it('shows an agent error in the open, not folded', () => {
    const { container } = show(item({ kind: 'error', status: 'failed', text: 'stream disconnected' }))
    expect(container.querySelector('.item-error .error-kw')).toHaveTextContent('error')
    expect(screen.getByText('stream disconnected')).toBeVisible()
    expect(container.querySelector('details')).toBeNull()
  })

  it('names a failed turn', () => {
    const { container } = show(item({ kind: 'error', status: 'failed', name: TURN_FAILED, text: 'API Error: overloaded' }))
    expect(container.querySelector('.error-kw')).toHaveTextContent('turn failed')
    expect(screen.getByText('API Error: overloaded')).toBeInTheDocument()
  })
})

describe('tool calls', () => {
  it('says what a tool works on after its name, with the full input folded', () => {
    const { container } = show(item({ name: 'Read', input: { file_path: '/src/app.go', limit: 5 } }))
    const summary = container.querySelector('.item-summary')!
    expect(summary).toHaveTextContent('/src/app.go')
    expect(summary).toHaveAttribute('title', '/src/app.go')
    // One line: the input folds behind the tool line itself, not a row of its own.
    expect(screen.queryByText(/^Input/)).toBeNull()
    const line = container.querySelector('details.tool-line') as HTMLDetailsElement
    expect(line.open).toBe(false)
    expect(line.querySelector('summary')).toHaveTextContent('Read/src/app.go')
    expect(line.querySelector('pre')!.textContent).toContain('"limit": 5')
  })

  it('draws a tool without input as a plain line', () => {
    const { container } = show(item({ name: 'TodoWrite' }))
    expect(container.querySelector('details.tool-line')).toBeNull()
    expect(container.querySelector('.item-line')).toHaveTextContent('TodoWrite')
  })

  it('names MCP tools by server and tool', () => {
    show(item({ name: 'mcp__github__create_issue', input: {} }))
    expect(screen.getByText('github · create_issue')).toBeInTheDocument()
    expect(screen.queryByText(/^Input/)).toBeNull()
  })

  it('tells a screen reader what kind of item an icon stands for', () => {
    show(item({ kind: 'command', status: 'failed', input: { command: 'make' } }))
    expect(screen.getByText('command, failed')).toHaveClass('sr-only')
  })
})

describe('output', () => {
  it('opens failed output with its exit code and last line', () => {
    const { container } = show(item({ kind: 'command', status: 'failed', exitCode: 2, input: { command: 'make' }, text: 'building\nerror: boom\n' }))
    const output = container.querySelector('details.item-output') as HTMLDetailsElement
    expect(output.open).toBe(true)
    const tag = screen.getByText('exit 2')
    expect(tag).toHaveClass('exit-tag', 'exit-bad')
    expect(container.querySelector('.item-output-preview')).toHaveTextContent('error: boom')
  })

  it('says a denied command never ran, without an exit code or a failure', () => {
    const { container } = show(item({ kind: 'command', input: { command: 'rm x' }, text: 'not now' }))
    expect(screen.getByText('not run')).toHaveClass('exit-tag')
    expect(screen.getByText('not run')).not.toHaveClass('exit-bad')
    expect(container.querySelector('.item.command')).not.toHaveClass('state-failed')
  })

  it('keeps a running command free of tags', () => {
    show(item({ kind: 'command', status: 'streaming', input: { command: 'make' } }))
    expect(screen.queryByText('not run')).toBeNull()
  })

  it('keeps successful output folded and its exit code quiet', () => {
    const { container } = show(item({ kind: 'command', exitCode: 0, input: { command: 'ls' }, text: 'a\nb' }))
    expect((container.querySelector('details.item-output') as HTMLDetailsElement).open).toBe(false)
    expect(screen.getByText('exit 0')).not.toHaveClass('exit-bad')
  })

  it('copies output', async () => {
    show(item({ kind: 'command', input: { command: 'ls' }, text: 'a\nb' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy' })))
    expect(writeText).toHaveBeenCalledWith('a\nb')
  })

  it('keeps streaming output scrolled to its end', () => {
    const it0 = item({ kind: 'command', status: 'failed', input: { command: 'tail' }, text: 'a' })
    const { container, rerender, props } = show(it0)
    const pre = container.querySelector('.item-output pre') as HTMLPreElement
    let top = 0
    Object.defineProperty(pre, 'scrollHeight', { configurable: true, get: () => 500 })
    Object.defineProperty(pre, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v } })
    const next = { ...it0, status: 'streaming' as const, text: 'a\nb' }
    rerender(<ol><Row {...props} node={{ item: next, children: [] }} /></ol>)
    expect(top).toBe(500)
  })
})

describe('messages', () => {
  it("shows a message's actions on a tap of the message, for a touch screen", () => {
    const { container } = show(item({ kind: 'user_message', text: 'hello' }), { onEdit: vi.fn() })
    const msg = container.querySelector('.item.user')!
    expect(msg).not.toHaveClass('actions-shown')
    fireEvent.click(screen.getByText('hello'))
    expect(msg).toHaveClass('actions-shown')
    // A tap on an action does its job and leaves the row as it is.
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(msg).toHaveClass('actions-shown')
    fireEvent.click(screen.getByText('hello'))
    expect(msg).not.toHaveClass('actions-shown')
  })

  it("shows an answer's copy button on a tap of the answer", () => {
    const { container } = show(item({ kind: 'assistant_message', text: 'done here' }))
    fireEvent.click(screen.getByText('done here'))
    expect(container.querySelector('.item.assistant')).toHaveClass('actions-shown')
  })

  it('marks a streaming answer so it shows a caret', () => {
    const { container, rerender, props } = show(item({ kind: 'assistant_message', status: 'streaming', text: 'Hel' }))
    expect(container.querySelector('.item.assistant')).toHaveClass('streaming')
    expect(screen.queryByRole('button', { name: 'Copy reply' })).toBeNull()
    const done = item({ kind: 'assistant_message', status: 'completed', text: 'Hello **there**' })
    rerender(<ol><Row {...props} node={{ item: done, children: [] }} /></ol>)
    expect(container.querySelector('.item.assistant')).not.toHaveClass('streaming')
  })

  it('copies a whole answer as markdown', async () => {
    show(item({ kind: 'assistant_message', text: 'Hello **there**' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy reply' })))
    expect(writeText).toHaveBeenCalledWith('Hello **there**')
  })

  it('folds a long user message', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const { container } = show(item({ kind: 'user_message', text }))
    expect(container.querySelector('.item.user')).toHaveClass('folded')
    fireEvent.click(screen.getByRole('button', { name: 'show more' }))
    expect(container.querySelector('.item.user')).not.toHaveClass('folded')
    expect(screen.getByRole('button', { name: 'show less' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('leaves a short user message alone', () => {
    show(item({ kind: 'user_message', text: 'hi' }))
    expect(screen.queryByRole('button', { name: /show/ })).toBeNull()
  })

  it('copies a message of the owner and takes it back into the composer', async () => {
    const onEdit = vi.fn()
    show(item({ kind: 'user_message', text: 'fix the bug' }), { onEdit })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy' })))
    expect(writeText).toHaveBeenCalledWith('fix the bug')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(onEdit).toHaveBeenCalledWith('fix the bug')
  })

  it('offers no edit without a composer and no actions for an empty message', () => {
    const { container, rerender, props } = show(item({ kind: 'user_message', text: 'hi' }))
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    rerender(<ol><Row {...props} onEdit={vi.fn()} node={{ item: item({ kind: 'user_message', text: '  ', images: ['img1'] }), children: [] }} /></ol>)
    expect(container.querySelector('.msg-actions')).toBeNull()
  })

  it('says it is thinking while reasoning streams', () => {
    show(item({ kind: 'reasoning', status: 'streaming', text: 'hmm' }))
    expect(screen.getByText('Thinking…')).toBeInTheDocument()
  })
})

describe('subagents', () => {
  it('names a subagent by its type and says what it does', () => {
    const { container } = show(item({ kind: 'subagent', name: 'Task', status: 'streaming', input: { subagent_type: 'Explore', description: 'find usages' } }))
    expect(screen.getByText('subagent: Explore')).toBeInTheDocument()
    expect(container.querySelector('.subagent-head .item-summary')).toHaveTextContent('find usages')
  })

  it('stops a subagent once, however often Stop is pressed', async () => {
    let finish: (ok: boolean) => void = () => {}
    const onStopTask = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
    show(item({ kind: 'subagent', name: 'Task', status: 'streaming', agentId: 'task-1' }), { onStopTask })
    const stop = screen.getByRole('button', { name: 'Stop' })
    fireEvent.click(stop)
    fireEvent.click(stop)
    expect(onStopTask).toHaveBeenCalledTimes(1)
    expect(onStopTask).toHaveBeenCalledWith('s1', 'task-1')
    expect(stop).toHaveAttribute('aria-busy', 'true')
    expect(stop).toHaveTextContent('Stopping…')
    await act(async () => finish(false))
    expect(stop).toHaveTextContent('Stop')
    expect(stop).not.toHaveAttribute('aria-busy', 'true')
  })

  it('renders nested items', () => {
    const { container } = show(item({ id: 'p', kind: 'subagent', name: 'Task', status: 'completed' }), {}, [
      item({ id: 'c', parentItemId: 'p', name: 'Grep', input: { pattern: 'TODO' } }),
    ])
    expect(within(container.querySelector('.subagent-items')!).getByText('TODO')).toBeInTheDocument()
  })
})

describe('hooks', () => {
  it('lets a truncated hook preview be read in full', () => {
    const { container } = show(item({ kind: 'hook', name: 'Stop', outcome: 'blocked', text: 'Check your work first.' }))
    expect(container.querySelector('.hook-preview')).toHaveAttribute('title', 'Check your work first.')
  })
})

describe('retry', () => {
  it('sends a failed turn again once, saying so while it goes', async () => {
    let finish: () => void = () => {}
    const onRetry = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    show(item({ kind: 'error', status: 'failed', name: TURN_FAILED, text: 'overloaded' }), { onRetry })
    const retry = screen.getByRole('button', { name: 'Retry' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(retry).toHaveTextContent('Retrying…')
    expect(retry).toHaveAttribute('aria-busy', 'true')
    await act(async () => finish())
    expect(retry).toHaveTextContent('Retry')
  })

  it('offers no retry on an error that does not end the transcript', () => {
    show(item({ kind: 'error', status: 'failed', text: 'old' }))
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})

describe('diffs', () => {
  it('draws a file change diff with its +/− count', () => {
    const diff = '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n+more\n'
    const { container } = show(item({ kind: 'file_change', path: 'x', diff }))
    expect(screen.getByText('x')).toBeInTheDocument()
    const fold = screen.getByText(/^Diff/).closest('details')!
    expect(fold.querySelector('.diff-stat')).toHaveTextContent('+2 −1')
    expect(fold.querySelector('.idiff-add')).toHaveTextContent('new')
    expect(fold.querySelector('.idiff-del')).toHaveTextContent('old')
    expect(fold.querySelector('.idiff-hunk')).toHaveTextContent('@@ -1,2 +1,2 @@')
    expect(screen.getAllByText('added:')).toHaveLength(2)
    // A unified diff from the agent is the whole story: no raw input fold.
    expect(container.querySelector('pre')).toBeNull()
  })

  it('copies the diff as the agent sent it', async () => {
    const diff = '@@ -1 +1 @@\n-a\n+b\n'
    show(item({ kind: 'file_change', path: 'x', diff }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy' })))
    expect(writeText).toHaveBeenCalledWith(diff)
  })

  it('draws an Edit from its old and new text and keeps the raw input folded', async () => {
    show(item({ kind: 'file_change', name: 'Edit', path: '/a.go', input: { file_path: '/a.go', old_string: 'x := 1', new_string: 'x := 2' } }))
    const fold = screen.getByText(/^Diff/).closest('details')!
    expect(fold.querySelector('.diff-stat')).toHaveTextContent('+1 −1')
    expect(fold.querySelector('.idiff-del')).toHaveTextContent('x := 1')
    expect(fold.querySelector('.idiff-add')).toHaveTextContent('x := 2')
    await act(async () => fireEvent.click(within(fold).getByRole('button', { name: 'Copy' })))
    expect(writeText).toHaveBeenCalledWith('-x := 1\n+x := 2')
    // The diff says what the input says; no second fold repeats it.
    expect(screen.queryByText(/^Input/)).toBeNull()
  })

  it("folds an edit tool call's input behind its diff only", () => {
    const { container } = show(item({ name: 'Edit', input: { file_path: '/a.go', old_string: 'a', new_string: 'b' } }))
    expect(screen.getByText(/^Diff/)).toBeInTheDocument()
    expect(container.querySelector('details.tool-line')).toBeNull()
  })

  it('draws a Write tool call as added lines', () => {
    show(item({ name: 'Write', input: { file_path: '/n.txt', content: 'one\ntwo' } }))
    expect(screen.getByText(/^Diff/).closest('details')!.querySelector('.diff-stat')).toHaveTextContent('+2 −0')
  })

  it('leaves a tool that only looks like an edit alone', () => {
    show(item({ name: 'mcp__notes__save', input: { content: 'hello' } }))
    expect(screen.queryByText(/^Diff/)).toBeNull()
  })

  it('shows plain text from the agent without a count', () => {
    const { container } = show(item({ kind: 'file_change', path: 'new.txt', diff: 'hello\nworld' }))
    expect(container.querySelector('.diff-stat')).toBeNull()
    expect(screen.getByText(/^Diff/)).toHaveTextContent('Diff · 2 lines')
  })

  it('opens the diff of a failed change', () => {
    show(item({ kind: 'file_change', status: 'failed', path: 'x', diff: '@@ -1 +1 @@\n-a\n+b' }))
    expect((screen.getByText(/^Diff/).closest('details') as HTMLDetailsElement).open).toBe(true)
  })
})

describe('long output', () => {
  const clipped = (height: number) => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(height)
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(280)
    return () => { scroll.mockRestore(); client.mockRestore() }
  }

  it('offers to show all of a clipped output, then less', () => {
    const restore = clipped(900)
    const text = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    const { container } = show(item({ kind: 'command', status: 'failed', input: { command: 'make' }, text }))
    const all = screen.getByRole('button', { name: 'show all 60 lines' })
    fireEvent.click(all)
    expect(container.querySelector('.item-output pre')).toHaveClass('full')
    fireEvent.click(screen.getByRole('button', { name: 'show less' }))
    expect(container.querySelector('.item-output pre')).not.toHaveClass('full')
    restore()
  })

  it('says nothing when the output fits', () => {
    const restore = clipped(100)
    show(item({ kind: 'command', status: 'failed', input: { command: 'make' }, text: 'ok' }))
    expect(screen.queryByRole('button', { name: /show all/ })).toBeNull()
    restore()
  })
})

describe('finished subagents', () => {
  const steps = [
    item({ id: 'c1', parentItemId: 'p', name: 'Grep', input: { pattern: 'TODO' } }),
    item({ id: 'c2', parentItemId: 'p', kind: 'assistant_message', text: 'Found two.\nDetails follow' }),
  ]

  it('folds the steps of a finished subagent behind a count and the last step', () => {
    const { container } = show(item({ id: 'p', kind: 'subagent', name: 'Task', status: 'completed' }), {}, steps)
    const fold = container.querySelector('details.subagent-steps') as HTMLDetailsElement
    expect(fold.open).toBe(false)
    expect(fold.querySelector('summary')).toHaveTextContent('2 steps')
    expect(fold.querySelector('.item-output-preview')).toHaveTextContent('last: Found two.')
  })

  it('says a subagent its turn left unfinished was stopped, and offers no Stop', () => {
    const { container } = show(item({ id: 'p', kind: 'subagent', name: 'Task', status: 'stopped', agentId: 'task-1' }), {}, [
      item({ id: 'c', kind: 'command', status: 'stopped', parentItemId: 'p', input: { command: 'sleep 9' } }),
    ])
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(container.querySelector('.subagent-head .stop-tag')).toHaveTextContent('stopped')
    expect(container.querySelector('details.subagent-steps')).not.toBeNull()
    expect(container.querySelector('.item.command .stop-tag')).toHaveTextContent('stopped')
  })

  it('keeps the steps of a running subagent open', () => {
    const { container } = show(item({ id: 'p', kind: 'subagent', name: 'Task', status: 'streaming' }), {}, steps)
    expect(container.querySelector('details.subagent-steps')).toBeNull()
    expect(container.querySelector('.subagent-items')).toBeVisible()
  })

  it.each([
    [item({ id: 'c', parentItemId: 'p', kind: 'command', input: { command: 'go test' } }), 'last: go test'],
    [item({ id: 'c', parentItemId: 'p', kind: 'file_change', path: '/a.go' }), 'last: edit /a.go'],
    [item({ id: 'c', parentItemId: 'p', name: 'Read', input: { file_path: '/b' } }), 'last: Read /b'],
    [item({ id: 'c', parentItemId: 'p', name: 'TodoWrite' }), 'last: TodoWrite'],
    [item({ id: 'c', parentItemId: 'p', kind: 'reasoning', text: '' }), 'last: reasoning'],
  ])('says what the last step was', (child, last) => {
    const { container } = show(item({ id: 'p', kind: 'subagent', name: 'Task', status: 'failed' }), {}, [child])
    expect(container.querySelector('.subagent-steps summary')).toHaveTextContent('1 step')
    expect(container.querySelector('.subagent-steps .item-output-preview')).toHaveTextContent(last)
  })
})

describe('tool groups', () => {
  const group = (): ItemNode => {
    const members = [
      item({ id: 'a', name: 'Read', input: { file_path: '/a' } }),
      item({ id: 'b', name: 'Read', input: { file_path: '/b' } }),
      item({ id: 'c', name: 'Grep', input: { pattern: 'x' } }),
    ].map((m) => ({ item: m, children: [] }))
    return { item: members[0]!.item, children: [], group: members }
  }

  it('says in one line what a run of tools did and lists them when opened', () => {
    const { container } = render(<ol><Row node={group()} turn={undefined} unseen={false} reduced animateIn={false} onStopTask={vi.fn()} /></ol>)
    expect(container.querySelector('.row')).toHaveClass('row-tool_group')
    expect(container.querySelector('.tool-group-label')).toHaveTextContent('Read 2 files · searched 1 pattern')
    expect(screen.getByText('3 tool calls')).toHaveClass('sr-only')
    expect(container.querySelector('.tool-group-items')).toBeNull()
    const details = container.querySelector('details.tool-group') as HTMLDetailsElement
    details.open = true
    fireEvent(details, new Event('toggle'))
    expect(container.querySelectorAll('.tool-group-items > li')).toHaveLength(3)
    expect(screen.getByText('/b')).toBeInTheDocument()
  })
})

describe('decision records', () => {
  it('records a skipped question as skipped, in ink', () => {
    const { container } = show(item({ kind: 'decision', decision: 'denied', name: 'Question' }))
    expect(container.querySelector('.decision-kw')).toHaveTextContent('skipped')
    expect(container.querySelector('.decision')).toHaveClass('decision-skipped')
    expect(container.querySelector('.decision')).not.toHaveClass('decision-denied')
    expect(container.querySelector('.decision-name')).toBeNull()
  })

  it('strikes a named request after its outcome', () => {
    const { container } = show(item({ kind: 'decision', decision: 'denied', name: 'Run command', text: 'not now' }))
    expect(container.querySelector('.decision-kw')).toHaveTextContent('denied')
    expect(container.querySelector('.decision-name')).toHaveTextContent('Run command')
    expect(container.querySelector('.decision-text')).toHaveTextContent('not now')
  })

  it('records an answered question by its answer, nothing struck', () => {
    const { container } = show(item({ kind: 'decision', decision: 'answered', name: 'Question', text: 'Pick? Alpha' }))
    expect(container.querySelector('.decision')).toHaveClass('decision-answer')
    expect(container.querySelector('.decision-name')).toBeNull()
    expect(container.querySelector('.decision-text')).toHaveTextContent('Pick? Alpha')
  })

  it('names a request without a title', () => {
    const { container } = show(item({ kind: 'decision', decision: 'approved' }))
    expect(container.querySelector('.decision-name')).toHaveTextContent('Request')
    expect(container.querySelector('.decision-text')).toBeNull()
  })

  it('reads a decision without its outcome as answered', () => {
    const { container } = show(item({ kind: 'decision', name: 'Pick a model' }))
    expect(container.querySelector('.decision-kw')).toHaveTextContent('answered')
    expect(container.querySelector('.decision-name')).toHaveTextContent('Pick a model')
  })
})

describe('turn footer', () => {
  it('closes a finished turn with its tokens and cost', () => {
    const { container } = show(item({ kind: 'assistant_message', text: 'done' }), {
      result: { inputTokens: 12345, outputTokens: 678, costUsd: 0.01234 },
    })
    expect(container.querySelector('.turn-foot')).toHaveTextContent('12,345 in · 678 out · $0.0123')
  })

  it('prints only what the result carries', () => {
    const { container, rerender, props } = show(item({ kind: 'assistant_message', text: 'done' }), { result: { outputTokens: 5 } })
    expect(container.querySelector('.turn-foot')).toHaveTextContent(/^5 out$/)
    rerender(<ol><Row {...props} result={{ text: 'done' }} /></ol>)
    expect(container.querySelector('.turn-foot')).toBeNull()
  })
})
