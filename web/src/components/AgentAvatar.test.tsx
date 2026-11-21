import { render } from '@testing-library/react'
import { expect, it } from 'vitest'
import AgentAvatar from './AgentAvatar'

it.each(['claude', 'codex', 'opencode', 'native'] as const)('shows a distinct graphic for %s', (agent) => {
  const { container } = render(<AgentAvatar agent={agent} />)
  expect(container.querySelector(`.avatar-${agent} svg`)).toBeInTheDocument()
  expect(container.textContent).toBe('')
})
