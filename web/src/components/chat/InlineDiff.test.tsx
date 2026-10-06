import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import InlineDiff from './InlineDiff'
import type { DiffLine } from '../../lib/diff'

it('signs each line and tells a screen reader what changed', () => {
  const lines: DiffLine[] = [
    { kind: 'hunk', text: '@@ -1 +1 @@' },
    { kind: 'ctx', text: 'same' },
    { kind: 'del', text: 'old' },
    { kind: 'add', text: 'new' },
  ]
  const { container } = render(<InlineDiff lines={lines} label="diff of a.go" />)
  expect(screen.getByRole('group', { name: 'diff of a.go' })).toBeInTheDocument()
  const rows = [...container.querySelectorAll('.idiff')].map((row) => row.textContent)
  expect(rows).toEqual(['@@ -1 +1 @@', ' same', 'removed: -old', 'added: +new'])
})

it('renders a long diff from its head until asked for the rest', () => {
  const lines: DiffLine[] = Array.from({ length: 450 }, (_, i) => ({ kind: 'add', text: `l${i}` }))
  const { container } = render(<InlineDiff lines={lines} />)
  expect(container.querySelectorAll('.idiff')).toHaveLength(400)
  fireEvent.click(screen.getByRole('button', { name: 'show all 450 lines' }))
  expect(container.querySelectorAll('.idiff')).toHaveLength(450)
  expect(container.querySelector('.inline-diff')).toHaveClass('full')
})

it('offers to uncap a diff its box clips', () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600)
  const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(280)
  const { container } = render(<InlineDiff lines={[{ kind: 'add', text: 'a' }, { kind: 'del', text: 'b' }]} />)
  fireEvent.click(screen.getByRole('button', { name: 'show all 2 lines' }))
  expect(container.querySelector('.inline-diff')).toHaveClass('full')
  expect(screen.getByRole('button', { name: 'show less' })).toHaveAttribute('aria-expanded', 'true')
  scroll.mockRestore()
  client.mockRestore()
})
