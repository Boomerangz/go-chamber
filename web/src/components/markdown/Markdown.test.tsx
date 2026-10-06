import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Markdown from './Markdown'
import { resetCodeWrap } from './wrap'

describe('Markdown', () => {
  it('renders lists, emphasis and tables', () => {
    const { container } = render(<Markdown text={'**bold**\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |'} />)
    expect(container.querySelector('strong')).toHaveTextContent('bold')
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('table')).not.toBeNull()
  })

  it('keeps inline code inline', () => {
    const { container } = render(<Markdown text={'run `ls -la` now'} />)
    expect(container.querySelector('code')).toHaveTextContent('ls -la')
    expect(container.querySelector('pre')).toBeNull()
  })

  it('highlights a fenced code block with a known language', async () => {
    const { container } = render(<Markdown text={'```go\nfunc main() {}\n```'} />)
    expect(container.querySelector('pre')).toHaveTextContent('func main() {}')
    await waitFor(() => expect(container.querySelector('pre [style*="--shiki-light"]')).not.toBeNull(), { timeout: 5000 })
  })

  it('shows streamed code at once instead of stale highlighting', async () => {
    const { container, rerender } = render(<Markdown text={'```go\nfunc a() {}\n```'} />)
    await waitFor(() => expect(container.querySelector('pre [style*="--shiki-light"]')).not.toBeNull(), { timeout: 5000 })
    rerender(<Markdown text={'```go\nfunc a() {}\nfunc b() {}\n```'} />)
    expect(container.querySelector('pre')).toHaveTextContent('func a() {} func b() {}')
  })

  it('shows an unknown language as plain code', () => {
    const { container } = render(<Markdown text={'```nosuchlang\nx = 1\n```'} />)
    expect(container.querySelector('pre')).toHaveTextContent('x = 1')
  })

  it('does not render raw html', () => {
    const { container } = render(<Markdown text={'<script>alert(1)</script><img src=x onerror=alert(1)>'} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })

  it('opens links in a new tab and drops javascript urls', () => {
    render(<Markdown text={'[site](https://example.com) [bad](javascript:alert(1))'} />)
    const link = screen.getByRole('link', { name: 'site' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByText('bad').getAttribute('href') ?? '').not.toContain('javascript')
  })

  it('heads a code block with its language and a copy button', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { container } = render(<Markdown text={'```go\nfunc main() {}\n```'} />)
    expect(container.querySelector('.md-code-lang')).toHaveTextContent('go')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy' })))
    expect(writeText).toHaveBeenCalledWith('func main() {}')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('labels a code block without a language as plain text', () => {
    const { container } = render(<Markdown text={'```\na\nb\n```'} />)
    expect(container.querySelector('.md-code-lang')).toHaveTextContent('text')
  })
})

describe('code block controls', () => {
  beforeEach(() => {
    localStorage.clear()
    resetCodeWrap()
  })

  it('wraps long lines in every block on request and remembers it', () => {
    const { container } = render(<Markdown text={'```\na\n```\n\n```\nb\n```'} />)
    const toggles = screen.getAllByRole('button', { name: 'Wrap' })
    expect(toggles[0]).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggles[0]!)
    expect(container.querySelectorAll('pre.md-code-wrap')).toHaveLength(2)
    expect(toggles[1]).toHaveAttribute('aria-pressed', 'true')
    expect(localStorage.getItem('gc.code-wrap')).toBe('1')
    resetCodeWrap()
    expect(container.querySelectorAll('pre.md-code-wrap')).toHaveLength(2)
    fireEvent.click(toggles[1]!)
    expect(container.querySelector('pre.md-code-wrap')).toBeNull()
    expect(localStorage.getItem('gc.code-wrap')).toBeNull()
  })

  it('keeps the choice for the page when storage is blocked', () => {
    const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    const get = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const { container } = render(<Markdown text={'```\na\n```'} />)
    fireEvent.click(screen.getByRole('button', { name: 'Wrap' }))
    expect(container.querySelector('pre.md-code-wrap')).not.toBeNull()
    act(() => resetCodeWrap())
    expect(container.querySelector('pre.md-code-wrap')).toBeNull()
    set.mockRestore()
    get.mockRestore()
  })

  it('offers to show all of a clipped block', () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900)
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(420)
    const code = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const { container } = render(<Markdown text={'```\n' + code + '\n```'} />)
    fireEvent.click(screen.getByRole('button', { name: 'show all 40 lines' }))
    expect(container.querySelector('pre.md-code')).toHaveClass('full')
    scroll.mockRestore()
    client.mockRestore()
  })
})
