import { act, fireEvent, render, screen } from '@testing-library/react'
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

  it('marks the line a link points at', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('one\ntwo\nthree')))
    inSession('[notes](logs/run.txt:2)')
    fireEvent.click(screen.getByRole('link', { name: 'notes' }))
    await screen.findByText('two')
    const marked = document.querySelector('.file-viewer .md-line-mark')
    expect(marked).toHaveTextContent('two')
    expect(document.querySelectorAll('.file-viewer .md-line-mark')).toHaveLength(1)
  })

  it('previews a Makefile instead of downloading it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('all:\n\tgo build')))
    inSession('[make](build/Makefile)')
    fireEvent.click(screen.getByRole('link', { name: 'make' }))
    expect(await screen.findByText(/go build/)).toBeInTheDocument()
  })

  it('says a file is binary and offers the download', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 0, 2]))))
    inSession('[tool](bin/tool)')
    fireEvent.click(screen.getByRole('link', { name: 'tool' }))
    expect(await screen.findByText(/This file is binary/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download it' })).toHaveAttribute('href', '/api/sessions/s1/file?path=bin%2Ftool&download=1')
  })

  it('shows the head of a large file with a way to get all of it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('a'.repeat(600 * 1024))))
    inSession('[log](run.log)')
    fireEvent.click(screen.getByRole('link', { name: 'log' }))
    expect(await screen.findByText(/Showing the first 512 KB of 600 KB/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download full file' })).toHaveAttribute('download')
  })

  it('says when an image is loading and when it fails', () => {
    inSession('[shot](/work/shot.png)')
    fireEvent.click(screen.getByRole('link', { name: 'shot' }))
    expect(screen.getByText('loading image…')).toBeInTheDocument()
    fireEvent.error(screen.getByRole('img'))
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load the image')
  })

  it('stops saying loading once the image arrives', () => {
    inSession('[shot](/work/shot.png)')
    fireEvent.click(screen.getByRole('link', { name: 'shot' }))
    fireEvent.load(screen.getByRole('img'))
    expect(screen.queryByText('loading image…')).toBeNull()
  })

  it('closes on a click on the backdrop, not inside', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('hello there')))
    inSession('[notes](notes.txt)')
    fireEvent.click(screen.getByRole('link', { name: 'notes' }))
    await screen.findByText('hello there')
    fireEvent.mouseDown(screen.getByText('hello there'))
    expect(document.querySelector('.file-viewer')).not.toBeNull()
    fireEvent.mouseDown(document.querySelector('.file-viewer')!)
    expect(document.querySelector('.file-viewer')).toBeNull()
  })

  it('wraps long lines on request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('text')))
    inSession('[notes](notes.txt)')
    fireEvent.click(screen.getByRole('link', { name: 'notes' }))
    const wrap = screen.getByRole('button', { name: 'Wrap long lines' })
    expect(wrap).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(wrap)
    expect(wrap).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelector('.file-viewer')).toHaveAttribute('data-wrap', 'true')
    fireEvent.click(wrap)
  })

  it('copies the path from the viewer', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    inSession('[shot](/work/shot.png)')
    fireEvent.click(screen.getByRole('link', { name: 'shot' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy path' })))
    expect(writeText).toHaveBeenCalledWith('/work/shot.png')
  })
})
