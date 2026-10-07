import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/home', () => ({ useHome: () => '/Users/me' }))
import GoneNote from './GoneNote'

describe('GoneNote', () => {
  it('reads as a label, the path on a line of its own, then why: no separator to hang', () => {
    const { container } = render(
      <GoneNote label="Folder gone" path="/Users/me/Develop/app">
        This folder no longer exists.
      </GoneNote>,
    )
    const note = container.querySelector('.gone-note')!
    const parts = [...note.children]
    expect(parts.map((p) => p.className)).toEqual(['worktree-gone-kw', 'path-text gone-path', 'gone-why'])
    expect(parts[0]).toHaveTextContent('Folder gone')
    expect(parts[1]).toHaveAttribute('title', '/Users/me/Develop/app')
    expect(parts[1]).toHaveTextContent('~/Develop/app')
    expect(parts[2]).toHaveTextContent('This folder no longer exists.')
    expect(note.textContent).not.toContain('·')
    // read aloud, the parts stay words apart
    expect(note).toHaveTextContent('Folder gone ~/Develop/app This folder no longer exists.')
  })

  it('leaves the path line out when there is no path', () => {
    const { container } = render(<GoneNote label="Codex CLI missing">Not found on go-chamber’s PATH.</GoneNote>)
    expect(container.querySelector('.gone-path')).toBeNull()
    expect(container.querySelector('.gone-note')).toHaveTextContent('Codex CLI missing Not found on go-chamber’s PATH.')
  })
})
