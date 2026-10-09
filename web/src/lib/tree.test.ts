import { describe, expect, it } from 'vitest'
import { isBlank, itemTree, sameNode, shownFrom, withoutAnsweredQuestions } from './tree'
import type { Item } from './api'

const item = (id: string, parentItemId?: string): Item => ({
  id, sessionId: 's1', kind: 'tool_call', status: 'completed', parentItemId,
})

describe('itemTree', () => {
  it('nests children under their parent preserving order', () => {
    const items = {
      a: item('a'),
      b: item('b', 'a'),
      c: item('c'),
      d: item('d', 'a'),
    }
    const tree = itemTree(['a', 'b', 'c', 'd'], items)
    expect(tree.map((n) => n.item.id)).toEqual(['a', 'c'])
    expect(tree[0]!.children.map((n) => n.item.id)).toEqual(['b', 'd'])
  })

  it('treats orphans and unknown parents as roots', () => {
    const items = { a: item('a', 'missing'), b: item('b') }
    const tree = itemTree(['a', 'b'], items)
    expect(tree.map((n) => n.item.id)).toEqual(['a', 'b'])
  })

  it('skips ids without items', () => {
    const tree = itemTree(['ghost', 'a'], { a: item('a') })
    expect(tree.map((n) => n.item.id)).toEqual(['a'])
  })

  it('handles deep nesting', () => {
    const items = { a: item('a'), b: item('b', 'a'), c: item('c', 'b') }
    const tree = itemTree(['a', 'b', 'c'], items)
    expect(tree[0]!.children[0]!.children[0]!.item.id).toBe('c')
  })
})

import { sessionTree } from './tree'
import type { Session } from './api'

const session = (id: string, parentId?: string): Session => ({
  id, agent: 'codex', cwd: '/p', status: 'idle', parentId,
})

describe('sessionTree', () => {
  it('nests child sessions under their parent', () => {
    const tree = sessionTree([session('a'), session('b', 'a'), session('c')])
    expect(tree.map((n) => n.session.id)).toEqual(['a', 'c'])
    expect(tree[0]!.children.map((n) => n.session.id)).toEqual(['b'])
  })

  it('treats unknown parents as roots', () => {
    const tree = sessionTree([session('a', 'ghost')])
    expect(tree.map((n) => n.session.id)).toEqual(['a'])
  })
})

describe('sameNode', () => {
  it('matches rebuilt trees over the same items and spots any changed item', () => {
    const items = { a: item('a'), b: item('b', 'a') }
    const [before] = itemTree(['a', 'b'], items)
    expect(sameNode(before!, itemTree(['a', 'b'], { ...items })[0]!)).toBe(true)
    expect(sameNode(before!, itemTree(['a', 'b'], { ...items, b: item('b', 'a') })[0]!)).toBe(false)
    expect(sameNode(before!, itemTree(['a', 'b'], { ...items, a: item('a') })[0]!)).toBe(false)
    expect(sameNode(before!, itemTree(['a', 'b', 'c'], { ...items, c: item('c', 'a') })[0]!)).toBe(false)
  })
})

describe('withoutAnsweredQuestions', () => {
  const node = (over: Partial<Item>): { item: Item; children: [] } => ({
    item: { id: over.id ?? 'x', sessionId: 's1', kind: 'tool_call', status: 'completed', ...over },
    children: [],
  })
  const ids = (nodes: { item: Item }[]) => nodes.map((n) => n.item.id)

  it('drops a question tool line its decision record already tells', () => {
    const nodes = [
      node({ id: 'u', kind: 'user_message' }),
      node({ id: 'q', name: 'AskUserQuestion' }),
      node({ id: 'd', kind: 'decision', decision: 'answered' }),
      node({ id: 'a', kind: 'assistant_message' }),
    ]
    expect(ids(withoutAnsweredQuestions(nodes))).toEqual(['u', 'd', 'a'])
  })

  it('keeps a question with no record after it in its turn, and other tools', () => {
    const nodes = [
      node({ id: 'q1', name: 'AskUserQuestion' }),
      node({ id: 'u', kind: 'user_message' }),
      node({ id: 'd', kind: 'decision' }),
      node({ id: 'r', name: 'Read' }),
      node({ id: 'q2', name: 'AskUserQuestion', status: 'pending' }),
    ]
    expect(ids(withoutAnsweredQuestions(nodes))).toEqual(['q1', 'u', 'd', 'r', 'q2'])
  })

  it('hides only question tool lines before the record, not what ran beside them', () => {
    const nodes = [
      node({ id: 'q', name: 'AskUserQuestion' }),
      node({ id: 'r', name: 'Read' }),
      node({ id: 'c', kind: 'command', name: 'AskUserQuestion' }),
      node({ id: 'n', name: undefined }),
      node({ id: 'd', kind: 'decision' }),
    ]
    expect(ids(withoutAnsweredQuestions(nodes))).toEqual(['r', 'c', 'n', 'd'])
  })

  it('returns the same list when nothing is hidden', () => {
    const nodes = [node({ id: 'a', kind: 'assistant_message' })]
    expect(withoutAnsweredQuestions(nodes)).toBe(nodes)
  })
})

describe('isBlank', () => {
  const hook = (over: Partial<Item>): Item => ({ id: 'h', sessionId: 's1', kind: 'hook', name: 'PreToolUse', status: 'completed', outcome: 'success', ...over })

  it('hides a finished assistant message without text', () => {
    expect(isBlank({ id: 'm', sessionId: 's1', kind: 'assistant_message', status: 'completed', text: ' ' })).toBe(true)
    expect(isBlank({ id: 'm', sessionId: 's1', kind: 'assistant_message', status: 'streaming' })).toBe(false)
    expect(isBlank({ id: 'm', sessionId: 's1', kind: 'assistant_message', status: 'completed', text: 'hi' })).toBe(false)
  })

  it('hides a hook that had nothing to say, running or done', () => {
    expect(isBlank(hook({}))).toBe(true)
    expect(isBlank(hook({ text: '\n' }))).toBe(true)
    expect(isBlank(hook({ status: 'streaming', outcome: undefined }))).toBe(true)
    expect(isBlank(hook({ status: 'stopped', outcome: undefined }))).toBe(true)
  })

  it('keeps a hook that said something, blocked the agent or failed', () => {
    expect(isBlank(hook({ text: 'context added' }))).toBe(false)
    expect(isBlank(hook({ outcome: 'blocked' }))).toBe(false)
    expect(isBlank(hook({ outcome: 'error', status: 'failed' }))).toBe(false)
    expect(isBlank(hook({ outcome: undefined, status: 'failed' }))).toBe(false)
  })
})

describe('shownFrom', () => {
  const rows = ['a', 'c', 'e'].map((id) => ({ item: item(id), children: [] }))
  const order = ['a', 'b', 'c', 'd', 'e']

  it('keeps an id the transcript shows', () => {
    expect(shownFrom(order, rows, 'c')).toBe('c')
  })

  it('moves a hidden id on to the next row shown', () => {
    expect(shownFrom(order, rows, 'b')).toBe('c')
    expect(shownFrom(order, rows, 'd')).toBe('e')
  })

  it('has nothing when no row follows or there is no id', () => {
    expect(shownFrom([...order, 'f'], rows, 'f')).toBeNull()
    expect(shownFrom(order, rows, 'zz')).toBeNull()
    expect(shownFrom(order, rows, null)).toBeNull()
  })
})
