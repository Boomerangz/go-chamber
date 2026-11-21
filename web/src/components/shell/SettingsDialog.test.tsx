import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { resetAppearance, useAppearanceStore } from '../../stores/appearance'
import { resetLayout, useLayoutStore } from '../../stores/layout'
import SettingsDialog from './SettingsDialog'

beforeEach(() => {
  localStorage.clear()
  resetAppearance()
  HTMLDialogElement.prototype.showModal ||= function (this: HTMLDialogElement) { this.setAttribute('open', '') }
})

it('sets the sheet, the scheme, the text size and the width', async () => {
  render(<SettingsDialog onClose={() => {}} />)
  expect(screen.getByRole('radio', { name: 'System' })).toBeChecked()
  expect(screen.getByRole('radio', { name: /Chamber/ })).toBeChecked()
  await userEvent.click(screen.getByRole('radio', { name: 'Dark' }))
  expect(useAppearanceStore.getState().theme).toBe('dark')
  await userEvent.click(screen.getByRole('radio', { name: /Nord/ }))
  expect(useAppearanceStore.getState().scheme).toBe('nord')
  expect(screen.getByRole('radio', { name: /Nord/ })).toBeChecked()
  await userEvent.click(screen.getByRole('radio', { name: 'Large' }))
  await userEvent.click(screen.getByRole('checkbox', { name: 'Wide transcript' }))
  expect(document.documentElement.dataset).toMatchObject({ theme: 'dark', scheme: 'nord', text: 'large', wide: '' })
})

it('chooses which hooks the transcript shows', async () => {
  resetLayout()
  render(<SettingsDialog onClose={() => {}} />)
  expect(screen.getByRole('radio', { name: 'Objected' })).toBeChecked()
  await userEvent.click(screen.getByRole('radio', { name: 'All' }))
  expect(useLayoutStore.getState().hooks).toBe('all')
})

it('closes from its button', async () => {
  const onClose = vi.fn()
  render(<SettingsDialog onClose={onClose} />)
  await userEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(onClose).toHaveBeenCalled()
})

it('remembers the agent icon colour choice', async () => {
  render(<SettingsDialog onClose={() => {}} />)
  await userEvent.click(screen.getByRole('radio', { name: 'Color' }))
  expect(document.documentElement.dataset.agentIcons).toBe('color')
  resetAppearance()
  expect(screen.getByRole('radio', { name: 'Color' })).toBeChecked()
})
