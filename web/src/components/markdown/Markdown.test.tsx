import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import Markdown from './Markdown'

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
