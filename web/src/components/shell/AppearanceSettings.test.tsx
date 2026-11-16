import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it } from 'vitest'
import { resetAppearance, useAppearanceStore } from '../../stores/appearance'
import { resetLayout, useLayoutStore } from '../../stores/layout'
import AppearanceSettings from './AppearanceSettings'

beforeEach(() => {
  localStorage.clear()
  resetAppearance()
})

it('folds under Appearance and sets the sheet, the text size and the width', async () => {
  render(<AppearanceSettings />)
  await userEvent.click(screen.getByText('Appearance'))
  const theme = screen.getByRole('radiogroup', { name: 'Theme' })
  expect(screen.getByRole('radio', { name: 'System' })).toBeChecked()
  await userEvent.click(screen.getByRole('radio', { name: 'Dark' }))
  expect(useAppearanceStore.getState().theme).toBe('dark')
  expect(theme.querySelector('[aria-checked="true"]')).toHaveTextContent('Dark')
  await userEvent.click(screen.getByRole('radio', { name: 'Large' }))
  expect(useAppearanceStore.getState().text).toBe('large')
  await userEvent.click(screen.getByRole('checkbox', { name: 'Wide transcript' }))
  expect(useAppearanceStore.getState().wide).toBe(true)
  expect(document.documentElement.dataset).toMatchObject({ theme: 'dark', text: 'large', wide: '' })
})

it('chooses which hooks the transcript shows', async () => {
  resetLayout()
  render(<AppearanceSettings />)
  await userEvent.click(screen.getByText('Appearance'))
  expect(screen.getByRole('radio', { name: 'Objected' })).toBeChecked()
  await userEvent.click(screen.getByRole('radio', { name: 'All' }))
  expect(useLayoutStore.getState().hooks).toBe('all')
  await userEvent.click(screen.getByRole('radio', { name: 'None' }))
  expect(useLayoutStore.getState().hooks).toBe('off')
})
