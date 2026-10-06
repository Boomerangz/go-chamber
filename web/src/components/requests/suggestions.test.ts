import { expect, it } from 'vitest'
import { describeSuggestions } from './suggestions'

it('names the rules, mode and directories a session grant adds', () => {
  expect(describeSuggestions([
    { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] },
    { type: 'replaceRules', rules: [{ toolName: 'Read' }, { toolName: 'Edit', ruleContent: '' }, { ruleContent: 'x' }, null] },
    { type: 'setMode', mode: 'acceptEdits' },
    { type: 'addDirectories', directories: ['/a'] },
    { type: 'addDirectories', directories: ['/b', '/c', 3] },
  ])).toEqual([
    'adds rule: Bash(npm test:*)',
    'adds rules: Read, Edit',
    'sets mode: acceptEdits',
    'adds directory: /a',
    'adds directories: /b, /c',
  ])
})

it('says nothing about what it cannot read', () => {
  expect(describeSuggestions(undefined)).toEqual([])
  expect(describeSuggestions({ type: 'addRules' })).toEqual([])
  expect(describeSuggestions([
    null, 'x', { type: 'addRules' }, { type: 'addRules', rules: [{}] }, { type: 'setMode' },
    { type: 'addDirectories', directories: [] }, { type: 'other', rules: [{ toolName: 'X' }] },
  ])).toEqual([])
})
