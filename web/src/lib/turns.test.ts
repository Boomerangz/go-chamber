import { describe, expect, it } from 'vitest'
import type { Item } from './api'
import type { ItemNode } from './tree'
import { turnNumbers, turnOutline } from './turns'

function node(id: string, kind: Item['kind'], text?: string): ItemNode {
  return { item: { id, kind, status: 'completed', text } as Item, children: [] }
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

describe('turnOutline', () => {
  it('lists each user turn with its number and first line, flattened', () => {
    const nodes = [
      node('u1', 'user_message', '  Объясни  архитектуру\nслоёв '),
      node('a1', 'assistant_message', 'answer'),
      node('u2', 'user_message', 'run   the tests'),
    ]
    expect(turnOutline(nodes)).toEqual([
      { id: 'u1', n: 1, text: 'Объясни архитектуру' },
      { id: 'u2', n: 2, text: 'run the tests' },
    ])
  })

  it('names a turn with no words by its attachment', () => {
    expect(turnOutline([node('u1', 'user_message', '\n  ')])).toEqual([{ id: 'u1', n: 1, text: 'attachment' }])
    expect(turnOutline([node('u1', 'user_message')])).toEqual([{ id: 'u1', n: 1, text: 'attachment' }])
  })

  it('is empty without user turns', () => {
    expect(turnOutline([node('a1', 'assistant_message', 'hi')])).toEqual([])
  })
})
