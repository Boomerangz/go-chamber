import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Row, type RowProps } from './Transcript'
import type { Item } from '../../lib/api'
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
    const input = screen.getByText(/^Input/).closest('details')!
    expect(input.querySelector('pre')!.textContent).toContain('"limit": 5')
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
  it('marks a streaming answer so it shows a caret', () => {
    const { container, rerender, props } = show(item({ kind: 'assistant_message', status: 'streaming', text: 'Hel' }))
    expect(container.querySelector('.item.assistant')).toHaveClass('streaming')
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull()
    const done = item({ kind: 'assistant_message', status: 'completed', text: 'Hello **there**' })
    rerender(<ol><Row {...props} node={{ item: done, children: [] }} /></ol>)
    expect(container.querySelector('.item.assistant')).not.toHaveClass('streaming')
  })

  it('copies a whole answer as markdown', async () => {
    show(item({ kind: 'assistant_message', text: 'Hello **there**' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy message' })))
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
    expect(screen.queryByRole('button')).toBeNull()
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
