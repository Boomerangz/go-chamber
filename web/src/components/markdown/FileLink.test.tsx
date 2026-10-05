import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Markdown from './Markdown'
import { SessionFiles } from '../../lib/files'

const inSession = (text: string) =>
  render(
    <SessionFiles.Provider value="s1">
      <Markdown text={text} />
    </SessionFiles.Provider>,
  )

afterEach(() => vi.unstubAllGlobals())

describe('file links', () => {
  it('keep web links as they are', () => {
    inSession('[site](https://example.com)')
    const a = screen.getByRole('link', { name: 'site' })
    expect(a).toHaveAttribute('href', 'https://example.com')
    expect(a).toHaveAttribute('target', '_blank')
  })

  it('leave paths alone outside a session', () => {
    render(<Markdown text="[plan](/tmp/plan.md)" />)
    expect(screen.getByRole('link', { name: 'plan' })).toHaveAttribute('href', '/tmp/plan.md')
  })

  it('offer other files as downloads', () => {
    inSession('[report](/work/report.pdf)')
    const a = screen.getByRole('link', { name: 'report' })
    expect(a).toHaveAttribute('href', '/api/sessions/s1/file?path=%2Fwork%2Freport.pdf&download=1')
    expect(a).toHaveAttribute('download')
  })

  it.each([
    ['[report](<docs/report final.pdf>)', 'docs/report final.pdf'],
    ['[report](docs/отчёт.pdf)', 'docs/отчёт.pdf'],
    ['[report](docs/report%23final.pdf#L12)', 'docs/report#final.pdf'],
    ['[report](docs/report%2520final.pdf)', 'docs/report%20final.pdf'],
  ])('opens encoded local paths: %s', (text, path) => {
    inSession(text)
    const href = screen.getByRole('link', { name: 'report' }).getAttribute('href')!
    expect(new URL(href, 'http://localhost').searchParams.get('path')).toBe(path)
  })

  it('opens file scheme links through the session file endpoint', () => {
    inSession('[report](file:///work/report%20final.pdf)')
    const href = screen.getByRole('link', { name: 'report' }).getAttribute('href')!
    expect(new URL(href, 'http://localhost').pathname).toBe('/api/sessions/s1/file')
    expect(new URL(href, 'http://localhost').searchParams.get('path')).toBe('/work/report final.pdf')
  })

  it('open images in a viewer', () => {
    inSession('[shot](/work/shot.png)')
    fireEvent.click(screen.getByRole('link', { name: 'shot' }))
    expect(screen.getByRole('img', { name: '/work/shot.png' })).toHaveAttribute(
      'src',
      '/api/sessions/s1/file?path=%2Fwork%2Fshot.png',
    )
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      '/api/sessions/s1/file?path=%2Fwork%2Fshot.png&download=1',
    )
  })

  it('render markdown files', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('# Title\n\nbody')))
    inSession('[notes](/work/notes.md#L3)')
    fireEvent.click(screen.getByRole('link', { name: 'notes' }))
    expect(await screen.findByRole('heading', { name: 'Title' })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/sessions/s1/file?path=%2Fwork%2Fnotes.md', expect.anything())
  })

  it('show code as a code block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('package main\n```')))
    const { container } = inSession('[main](src/main.go:12)')
    fireEvent.click(screen.getByRole('link', { name: 'main' }))
    await screen.findByText(/package main/)
    expect(container.ownerDocument.querySelector('.file-viewer pre')).toHaveAttribute('data-lang', 'go')
  })

  it('explain files outside the session folder', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 403 })))
    inSession('[secret](/etc/hosts.txt)')
    fireEvent.click(screen.getByRole('link', { name: 'secret' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('outside the session folder')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
