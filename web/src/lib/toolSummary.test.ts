import { describe, expect, it } from 'vitest'
import type { Item } from './api'
import { toolInput, toolLabel, toolPath, toolSummary } from './toolSummary'

const tool = (input: unknown, name = 'Read'): Item => ({
  id: 't1', sessionId: 's1', kind: 'tool_call', status: 'completed', name, input,
})

describe('toolSummary', () => {
  it('picks the field that says what the tool works on', () => {
    expect(toolSummary(tool({ file_path: '/src/app.go', limit: 20 }))).toBe('/src/app.go')
    expect(toolSummary(tool({ notebook_path: 'a.ipynb' }))).toBe('a.ipynb')
    expect(toolSummary(tool({ glob: '*.go', pattern: 'func main' }, 'Grep'))).toBe('func main')
    expect(toolSummary(tool({ url: 'https://x.dev', prompt: 'summarise' }, 'WebFetch'))).toBe('https://x.dev')
    expect(toolSummary(tool({ query: 'vitest 4' }, 'WebSearch'))).toBe('vitest 4')
    expect(toolSummary(tool({ command: 'ls -la', description: 'list' }, 'Bash'))).toBe('ls -la')
    expect(toolSummary(tool({ description: 'find usages', prompt: 'long prompt' }, 'Task'))).toBe('find usages')
    expect(toolSummary(tool({ prompt: 'only a prompt' }, 'Task'))).toBe('only a prompt')
  })

  it('prefers path over later fields and skips blanks', () => {
    expect(toolSummary(tool({ pattern: 'x', path: 'src' }))).toBe('src')
    expect(toolSummary(tool({ file_path: '  ', pattern: 'p' }))).toBe('p')
  })

  it('falls back to the first short string field', () => {
    expect(toolSummary(tool({ count: 3, server: 'github', repo: 'a/b' }, 'mcp__gh__list'))).toBe('github')
    expect(toolSummary(tool({ body: 'x'.repeat(500), title: 'Fix it' }))).toBe('Fix it')
  })

  it('keeps the summary on one line', () => {
    expect(toolSummary(tool({ command: 'echo a\n  && echo b' }, 'Bash'))).toBe('echo a && echo b')
  })

  it('does not flatten text of several lines into a summary; a plan is just a plan', () => {
    expect(toolSummary(tool({ body: '## Notes\n1. one\n2. two' }))).toBeUndefined()
    expect(toolSummary(tool({ plan: '## Plan\n1. Read the code\n2. **Fix** the bug' }, 'ExitPlanMode'))).toBe('plan')
  })

  it('says nothing without a usable input', () => {
    expect(toolSummary(tool(undefined))).toBeUndefined()
    expect(toolSummary(tool('raw'))).toBeUndefined()
    expect(toolSummary(tool([1, 2]))).toBeUndefined()
    expect(toolSummary(tool({ n: 1, flag: true }))).toBeUndefined()
    expect(toolSummary(tool({ body: 'x'.repeat(500) }))).toBeUndefined()
  })
})

describe('toolPath', () => {
  it('is the path the summary shows, when it shows one', () => {
    expect(toolPath(tool({ file_path: '/a/b.go', limit: 5 }))).toBe('/a/b.go')
    expect(toolPath(tool({ path: '/a', pattern: '*.go' }, 'Glob'))).toBe('/a')
    expect(toolPath(tool({ notebook_path: '/n.ipynb' }, 'NotebookEdit'))).toBe('/n.ipynb')
  })

  it('is nothing for a pattern, a command, a plan or odd input', () => {
    expect(toolPath(tool({ pattern: '/a/*.go' }, 'Grep'))).toBeUndefined()
    expect(toolPath(tool({ command: 'ls /a' }, 'Bash'))).toBeUndefined()
    expect(toolPath(tool({ file_path: '/plan.md' }, 'ExitPlanMode'))).toBeUndefined()
    expect(toolPath(tool(['x']))).toBeUndefined()
    expect(toolPath(tool(undefined))).toBeUndefined()
  })
})

describe('toolLabel', () => {
  it('names MCP tools by server and tool', () => {
    expect(toolLabel('mcp__github__create_issue')).toBe('github · create_issue')
    expect(toolLabel('mcp__my_server__a__b')).toBe('my_server · a__b')
  })

  it('leaves other names alone', () => {
    expect(toolLabel('Read')).toBe('Read')
    expect(toolLabel('mcp__only')).toBe('mcp__only')
    expect(toolLabel(undefined)).toBe('tool')
  })
})

describe('toolInput', () => {
  it('prints a non-empty input as indented JSON', () => {
    expect(toolInput({ a: 1 })).toBe('{\n  "a": 1\n}')
    expect(toolInput('raw')).toBe('"raw"')
  })

  it('omits empty input', () => {
    expect(toolInput(undefined)).toBeUndefined()
    expect(toolInput(null)).toBeUndefined()
    expect(toolInput({})).toBeUndefined()
  })
})
