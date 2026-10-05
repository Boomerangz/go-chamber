import { describe, expect, it } from 'vitest'
import { itemTree, sameNode } from './tree'
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
