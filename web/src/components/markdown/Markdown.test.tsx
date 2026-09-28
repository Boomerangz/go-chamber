import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
})
