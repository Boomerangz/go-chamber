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

describe('RequestCard audit fixes', () => {
  it('offers allow-for-session for codex permissions without suggestions', async () => {
    const onRespond = vi.fn()
    render(<RequestCard request={{ ...permission, payload: { toolName: 'command', input: {} } }} agent="codex" onRespond={onRespond} />)
    await userEvent.click(screen.getByRole('button', { name: 'Allow for session' }))
    expect(onRespond).toHaveBeenCalledWith('s1', 'r1', { behavior: 'allow', allowForSession: true })
  })

  it('sends one answer for a single-choice question when other is typed', async () => {
    const { onRespond } = setup(question)
    await userEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
    await userEvent.type(screen.getByLabelText('other Pick?'), 'Gamma')
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onRespond).toHaveBeenCalledWith('s1', 'q1', { behavior: 'allow', answers: { 'Pick?': ['Gamma'] } })
  })

  it('keeps radio groups of two cards with the same question apart', async () => {
    render(
      <>
        <RequestCard request={question} onRespond={vi.fn()} />
        <RequestCard request={{ ...question, id: 'q2' }} onRespond={vi.fn()} />
      </>,
    )
    const radios = screen.getAllByRole('radio', { name: /Alpha/ })
    await userEvent.click(radios[0]!)
    await userEvent.click(radios[1]!)
    expect(radios[0]).toBeChecked()
    expect(radios[1]).toBeChecked()
  })

  it('renders an elicitation form and accepts with content', async () => {
    const elicitation: SessionRequest = {
      id: 'e1', sessionId: 's1', kind: 'elicitation', state: 'pending', title: 'Need details',
      payload: {
        message: 'Fill in',
        requestedSchema: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', title: 'Name' },
            count: { type: 'integer', title: 'Count' },
            ok: { type: 'boolean', title: 'OK' },
            color: { type: 'string', title: 'Color', enum: ['red', 'blue'] },
          },
        },
      } as never,
    }
    const { onRespond } = setup(elicitation)
    await userEvent.type(screen.getByLabelText('Name'), 'Ann')
    await userEvent.type(screen.getByLabelText('Count'), '3')
    await userEvent.click(screen.getByLabelText('OK'))
    await userEvent.selectOptions(screen.getByLabelText('Color'), 'blue')
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(onRespond).toHaveBeenCalledWith('s1', 'e1', {
      behavior: 'allow', content: { name: 'Ann', count: 3, ok: true, color: 'blue' },
    })
  })

  it('accepts a required boolean left unchecked as false', async () => {
    const { onRespond } = setup({
      id: 'e2', sessionId: 's1', kind: 'elicitation', state: 'pending',
      payload: { requestedSchema: { required: ['agree'], properties: { agree: { type: 'boolean', title: 'Agree' } } } } as never,
    })
    expect(screen.getByLabelText('Agree')).not.toBeRequired()
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(onRespond).toHaveBeenCalledWith('s1', 'e2', { behavior: 'allow', content: { agree: false } })
  })

  it('shows the plan of an ExitPlanMode request as markdown', () => {
    setup({
      id: 'p1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Ready to code?',
      payload: { toolName: 'ExitPlanMode', input: { plan: '## Plan\n\n1. **Fix** it' } } as never,
    })
    expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument()
    expect(screen.getByText('Fix').tagName).toBe('STRONG')
    expect(screen.queryByText(/"plan"/)).not.toBeInTheDocument()
  })

  it('declines an elicitation', async () => {
    const { onRespond } = setup({ id: 'e1', sessionId: 's1', kind: 'elicitation', state: 'pending' })
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(onRespond).toHaveBeenCalledWith('s1', 'e1', { behavior: 'deny' })
  })

  it('disables the buttons while an answer is in flight', async () => {
    let release: () => void = () => {}
    const onRespond = vi.fn(() => new Promise<void>((r) => (release = r)))
    render(<RequestCard request={permission} onRespond={onRespond} />)
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(onRespond).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled())
  })
})
