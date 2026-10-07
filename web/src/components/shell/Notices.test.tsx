import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { notify, resetNotices } from '../../stores/notices'
import Notices from './Notices'

vi.mock('./noticePlace', () => ({ useNoticePlace: () => null }))
afterEach(() => { resetNotices(); vi.useRealTimers() })

it('keeps Undo available while either the pointer or keyboard is in the notice', () => {
  vi.useFakeTimers()
  resetNotices()
  const undo = vi.fn()
  notify({ kind: 'info', text: 'Archived', action: { label: 'Undo', run: undo } })
  render(<Notices />)
  const notice = screen.getByRole('status')
  const button = screen.getByRole('button', { name: 'Undo' })
  fireEvent.mouseEnter(notice)
  fireEvent.focus(button)
  act(() => vi.advanceTimersByTime(10000))
  expect(button).toBeInTheDocument()
  fireEvent.mouseLeave(notice)
  act(() => vi.advanceTimersByTime(10000))
  expect(button).toBeInTheDocument()
  fireEvent.click(button)
  expect(undo).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('status')).toBeNull()
})
