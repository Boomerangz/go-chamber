import { describe, expect, it } from 'vitest'
import type { Item } from './api'
import type { ItemNode } from './tree'
import { turnNumbers } from './turns'

function node(id: string, kind: Item['kind']): ItemNode {
  return { item: { id, kind, status: 'completed' } as Item, children: [] }
}

describe('turnNumbers', () => {
  it('numbers user messages in order', () => {
    const nodes = [node('u1', 'user_message'), node('a1', 'assistant_message'), node('u2', 'user_message')]
    const turns = turnNumbers(nodes)
    expect(turns.get('u1')).toBe(1)
    expect(turns.get('u2')).toBe(2)
  })

  it('leaves other items unnumbered', () => {
    const turns = turnNumbers([node('a0', 'assistant_message'), node('u1', 'user_message'), node('c1', 'command')])
    expect(turns.has('a0')).toBe(false)
    expect(turns.has('c1')).toBe(false)
    expect(turns.get('u1')).toBe(1)
    expect(turns.size).toBe(1)
  })

  it('returns an empty map for an empty transcript', () => {
    expect(turnNumbers([]).size).toBe(0)
  })
})
