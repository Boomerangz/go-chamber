import { beforeEach, describe, expect, it } from 'vitest'
import { changesViewOf, keepOpenFiles, keepChangesScroll, resetChangesViews } from './changesView'

beforeEach(resetChangesViews)

describe('changes view', () => {
  it('starts a session with nothing open, at the top', () => {
    expect(changesViewOf('s1')).toEqual({ open: [], scroll: 0 })
  })

  it('keeps each session’s open files and scroll apart', () => {
    keepOpenFiles('s1', ['a.go', 'b.go'])
    keepChangesScroll('s1', 120)
    keepOpenFiles('s2', ['c.go'])
    expect(changesViewOf('s1')).toEqual({ open: ['a.go', 'b.go'], scroll: 120 })
    expect(changesViewOf('s2')).toEqual({ open: ['c.go'], scroll: 0 })
  })

  it('keeps open files and scroll independently of each other', () => {
    keepChangesScroll('s1', 40)
    keepOpenFiles('s1', ['a.go'])
    keepChangesScroll('s1', 80)
    expect(changesViewOf('s1')).toEqual({ open: ['a.go'], scroll: 80 })
  })

  it('forgets everything on reset, as a reload would', () => {
    keepOpenFiles('s1', ['a.go'])
    keepChangesScroll('s1', 40)
    resetChangesViews()
    expect(changesViewOf('s1')).toEqual({ open: [], scroll: 0 })
  })
})
