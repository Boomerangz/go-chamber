import { describe, expect, it } from 'vitest'
import type { SessionRequest } from '../../lib/api'
import { requestGist } from './gist'

const req = (extra: Partial<SessionRequest>): SessionRequest => ({ id: 'r', sessionId: 's', kind: 'permission', state: 'pending', ...extra })

describe('requestGist', () => {
  it('reads a permission by its command, not by "Run command"', () => {
    expect(requestGist(req({ title: 'Run command', payload: { toolName: 'Bash', input: { command: '  rm -rf build\n && make ' } } }))).toBe('rm -rf build && make')
  })

  it('reads a file edit by its tool and file', () => {
    expect(requestGist(req({ title: 'Edit file', payload: { toolName: 'Edit', input: { file_path: '/a/b/main.go' } } }))).toBe('Edit main.go')
  })

  it('reads a question by what it asks, and counts the others', () => {
    const questions = [{ question: 'Which option?' }, { question: 'And then?' }]
    expect(requestGist(req({ kind: 'question', title: 'Question', payload: { input: { questions: questions.slice(0, 1) } } }))).toBe('Which option?')
    expect(requestGist(req({ kind: 'question', title: 'Question', payload: { input: { questions } } }))).toBe('Which option? (+1 more)')
  })

  it('falls back to the prompt, the title, then the tool', () => {
    expect(requestGist(req({ prompt: 'Fill the form', title: 'Input' }))).toBe('Fill the form')
    expect(requestGist(req({ title: 'Pick one' }))).toBe('Pick one')
    expect(requestGist(req({ payload: { toolName: 'WebFetch' } }))).toBe('WebFetch')
    expect(requestGist(req({}))).toBe('Request')
  })
})
