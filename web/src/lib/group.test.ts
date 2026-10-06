import { describe, expect, it } from 'vitest'
import type { Item } from './api'
import { groupSummary, groupTools, lastItemId } from './group'
import { sameNode, type ItemNode } from './tree'

const node = (id: string, over: Partial<Item> = {}, children: ItemNode[] = []): ItemNode => ({
  item: { id, sessionId: 's1', kind: 'tool_call', status: 'completed', turnId: 't1', name: 'Read', ...over },
  children,
})
const ids = (nodes: ItemNode[]) => nodes.map((n) => (n.group ? `[${n.group.map((m) => m.item.id).join(',')}]` : n.item.id))

describe('groupTools', () => {
  it('folds three or more finished tool lines into one row', () => {
    const nodes = [node('u', { kind: 'user_message' }), node('a'), node('b', { kind: 'command' }), node('c', { kind: 'file_change' }), node('m', { kind: 'assistant_message' })]
    const out = groupTools(nodes)
    expect(ids(out)).toEqual(['u', '[a,b,c]', 'm'])
    expect(out[1]!.item.id).toBe('a')
    expect(out[1]!.children).toEqual([])
  })

  it('leaves runs of two alone', () => {
    expect(ids(groupTools([node('a'), node('b'), node('m', { kind: 'assistant_message' }), node('c')]))).toEqual(['a', 'b', 'm', 'c'])
  })

  it('keeps out what is running, failed, exited non-zero or has children', () => {
    const out = groupTools([
      node('a'), node('b'), node('run', { status: 'streaming' }),
      node('c'), node('d'), node('bad', { status: 'failed' }),
      node('e'), node('f'), node('exit', { kind: 'command', exitCode: 1 }),
      node('g'), node('h'), node('sub', { kind: 'subagent' }),
      node('i'), node('j'), node('kids', {}, [node('x')]),
    ])
    expect(ids(out)).toEqual(['a', 'b', 'run', 'c', 'd', 'bad', 'e', 'f', 'exit', 'g', 'h', 'sub', 'i', 'j', 'kids'])
  })

  it('takes a command that exited zero', () => {
    expect(ids(groupTools([node('a', { kind: 'command', exitCode: 0 }), node('b'), node('c')]))).toEqual(['[a,b,c]'])
  })

  it('does not fold across turns', () => {
    const out = groupTools([node('a'), node('b'), node('c'), node('d', { turnId: 't2' }), node('e', { turnId: 't2' })])
    expect(ids(out)).toEqual(['[a,b,c]', 'd', 'e'])
  })

  it('starts a new run at the split item', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => node(id))
    expect(ids(groupTools(nodes, 'd'))).toEqual(['[a,b,c]', '[d,e,f,g]'])
    expect(ids(groupTools(nodes, 'b'))).toEqual(['a', '[b,c,d,e,f,g]'])
    expect(ids(groupTools(nodes, 'a'))).toEqual(['[a,b,c,d,e,f,g]'])
    expect(ids(groupTools(nodes, null))).toEqual(['[a,b,c,d,e,f,g]'])
  })
})

describe('lastItemId', () => {
  it('names the last member of a group, or the item itself', () => {
    const [group] = groupTools([node('a'), node('b'), node('c')])
    expect(lastItemId(group!)).toBe('c')
    expect(lastItemId(node('z'))).toBe('z')
  })
})

describe('groupSummary', () => {
  it('says what the tools did, in order, counting distinct files', () => {
    const nodes = [
      node('1', { input: { file_path: '/a' } }),
      node('2', { input: { file_path: '/b' } }),
      node('3', { input: { file_path: '/a' } }),
      node('4', { name: 'Grep', input: { pattern: 'x' } }),
      node('5', { name: 'Glob', input: { pattern: 'y' } }),
      node('6', { kind: 'command', name: 'Bash' }),
      node('7', { kind: 'file_change', path: '/a' }),
      node('8', { kind: 'file_change', path: '/a' }),
    ]
    expect(groupSummary(nodes)).toBe('Read 2 files · searched 2 patterns · ran 1 command · edited 1 file')
  })

  it('counts a file by its path field or each call without one', () => {
    expect(groupSummary([node('1', { input: { path: '/p' } }), node('2', { input: { notebook_path: '/p' } }), node('3', { input: 'raw' })])).toBe('Read 2 files')
  })

  it('names web tools and other tools with a count', () => {
    const nodes = [
      node('1', { name: 'WebFetch' }), node('2', { name: 'WebFetch' }),
      node('3', { name: 'WebSearch' }), node('4', { name: 'webSearch' }),
      node('5', { name: 'TodoWrite' }), node('6', { name: 'TodoWrite' }),
      node('7', { name: 'mcp__github__get_issue' }),
      node('8', { name: undefined }),
      node('9', { kind: 'command' }), node('10', { kind: 'command' }),
    ]
    expect(groupSummary(nodes)).toBe('Fetched 2 pages · ran 2 web searches · TodoWrite ×2 · github · get_issue · tool · ran 2 commands')
  })

  it('reads one search and one page in the singular', () => {
    expect(groupSummary([node('1', { name: 'Grep' }), node('2', { name: 'WebFetch' }), node('3', { name: 'WebSearch' })])).toBe('Searched 1 pattern · fetched 1 page · ran 1 web search')
  })
})

describe('sameNode with groups', () => {
  it('tells groups apart by their members', () => {
    const a = node('a')
    const b = node('b')
    const c = node('c')
    const g1: ItemNode = { item: a.item, children: [], group: [a, b, c] }
    expect(sameNode(g1, { item: a.item, children: [], group: [a, b, c] })).toBe(true)
    expect(sameNode(g1, { item: a.item, children: [], group: [a, b] })).toBe(false)
    expect(sameNode(g1, { item: a.item, children: [], group: [a, b, node('c')] })).toBe(false)
    expect(sameNode(g1, a)).toBe(false)
    expect(sameNode(a, { ...a })).toBe(true)
  })
})
