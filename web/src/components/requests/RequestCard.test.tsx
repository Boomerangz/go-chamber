import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import RequestCard from './RequestCard'
import type { RequestAnswerInput, SessionRequest } from '../../lib/api'

const permission: SessionRequest = {
  id: 'r1',
  sessionId: 's1',
  kind: 'permission',
  state: 'pending',
  title: 'Run command',
  prompt: 'Claude wants to run',
  payload: {
    toolName: 'Bash',
    input: { command: 'ls' },
    suggestions: [{ type: 'addRules' }],
  },
}

const question: SessionRequest = {
  id: 'q1',
  sessionId: 's1',
  kind: 'question',
  state: 'pending',
  payload: {
    input: {
      questions: [
        {
          question: 'Pick?',
          header: 'H',
          multiSelect: false,
          options: [{ label: 'Alpha', description: 'first' }, { label: 'Beta' }],
        },
      ],
    },
  },
}

function setup(request: SessionRequest) {
  const onRespond = vi.fn<(sessionId: string, requestId: string, answer: RequestAnswerInput) => void>()
  render(<RequestCard request={request} onRespond={onRespond} />)
  return { onRespond }
}

describe('RequestCard permission', () => {
  it('renders the prompt and responds to allow', async () => {
    const { onRespond } = setup(permission)
    expect(screen.getByText('Run command')).toBeInTheDocument()
    expect(screen.getByText('Claude wants to run')).toBeInTheDocument()
    expect(screen.getByText('Bash')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(onRespond).toHaveBeenCalledWith('s1', 'r1', { behavior: 'allow' })
  })

  it('offers allow-for-session when the agent suggested rules', async () => {
    const { onRespond } = setup(permission)
    await userEvent.click(screen.getByRole('button', { name: 'Allow for session' }))
    expect(onRespond).toHaveBeenCalledWith('s1', 'r1', { behavior: 'allow', allowForSession: true })
  })

  it('hides allow-for-session without suggestions', () => {
    setup({ ...permission, payload: { toolName: 'Bash', input: {} } })
    expect(screen.queryByRole('button', { name: 'Allow for session' })).toBeNull()
  })

  it('denies with an optional reason', async () => {
    const { onRespond } = setup(permission)
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await userEvent.type(screen.getByLabelText('deny reason'), 'not now')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }))
    expect(onRespond).toHaveBeenCalledWith('s1', 'r1', { behavior: 'deny', message: 'not now' })
  })
})

describe('RequestCard question', () => {
  it('submits a single-choice answer', async () => {
    const { onRespond } = setup(question)
    expect(screen.getByText('Pick?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onRespond).toHaveBeenCalledWith('s1', 'q1', { behavior: 'allow', answers: { 'Pick?': ['Alpha'] } })
  })

  it('submits free-form other answers', async () => {
    const { onRespond } = setup(question)
    await userEvent.type(screen.getByLabelText('other Pick?'), 'Gamma')
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onRespond).toHaveBeenCalledWith('s1', 'q1', { behavior: 'allow', answers: { 'Pick?': ['Gamma'] } })
  })

  it('collects multiple selections', async () => {
    const multi: SessionRequest = {
      ...question,
      payload: {
        input: {
          questions: [
            {
              question: 'Pick many?',
              multiSelect: true,
              options: [{ label: 'Alpha' }, { label: 'Beta' }],
            },
          ],
        },
      },
    }
    const { onRespond } = setup(multi)
    await userEvent.click(screen.getByRole('checkbox', { name: /Alpha/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Beta/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onRespond).toHaveBeenCalledWith('s1', 'q1', {
      behavior: 'allow',
      answers: { 'Pick many?': ['Alpha', 'Beta'] },
    })
  })
})
