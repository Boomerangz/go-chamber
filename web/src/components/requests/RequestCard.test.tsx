import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, resetNotices } from '../../stores/notices'
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

  it('keeps the card busy after a successful answer until it leaves', async () => {
    let release: (ok: boolean) => void = () => {}
    const onRespond = vi.fn(() => new Promise<boolean>((r) => (release = r)))
    render(<RequestCard request={permission} onRespond={onRespond} />)
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
    const allowing = screen.getByRole('button', { name: 'Allowing…' })
    expect(allowing).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Allow for session' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
    await userEvent.click(allowing)
    expect(onRespond).toHaveBeenCalledTimes(1)
    release(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByRole('button', { name: 'Allowing…' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
  })
})

describe('RequestCard pending and failure', () => {
  beforeEach(() => resetNotices())

  it('sends once on a same-tick double click', () => {
    const onRespond = vi.fn(() => new Promise<boolean>(() => {}))
    render(<RequestCard request={permission} onRespond={onRespond} />)
    const allow = screen.getByRole('button', { name: 'Allow' })
    fireEvent.click(allow)
    fireEvent.click(allow)
    expect(onRespond).toHaveBeenCalledTimes(1)
  })

  it('names the failure under the actions and lets the owner try again', async () => {
    const onRespond = vi.fn(async () => {
      fail('Answer not sent', new Error('agent gone'))
      return false
    })
    render(<RequestCard request={permission} onRespond={onRespond} />)
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(await screen.findByText('Not sent: agent gone')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(onRespond).toHaveBeenCalledTimes(2)
  })

  it('reports a thrown failure too', async () => {
    const onRespond = vi.fn(async () => {
      throw new Error('boom')
    })
    render(<RequestCard request={question} onRespond={onRespond} />)
    await userEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(await screen.findByText('Not sent: boom')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled()
  })

  it('labels the sending answer of a question and an elicitation', async () => {
    const onRespond = vi.fn(() => new Promise<boolean>(() => {}))
    const { unmount } = render(<RequestCard request={question} onRespond={onRespond} />)
    await userEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(screen.getByRole('button', { name: 'Sending…' })).toHaveAttribute('aria-busy', 'true')
    unmount()
    render(<RequestCard request={{ id: 'e1', sessionId: 's1', kind: 'elicitation', state: 'pending' }} onRespond={onRespond} />)
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(screen.getByRole('button', { name: 'Declining…' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled()
  })
})

describe('RequestCard keyboard', () => {
  it('answers with A and S while focus is in the card and shows the keys', async () => {
    const { onRespond } = setup(permission)
    expect(screen.getByRole('button', { name: 'Allow' })).toHaveAttribute('aria-keyshortcuts', 'A')
    expect(screen.getByRole('button', { name: 'Allow for session' })).toHaveAttribute('aria-keyshortcuts', 'S')
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveAttribute('aria-keyshortcuts', 'D')
    screen.getByRole('button', { name: 'Deny' }).focus()
    await userEvent.keyboard('s')
    expect(onRespond).toHaveBeenCalledWith('s1', 'r1', { behavior: 'allow', allowForSession: true })
  })

  it('answers allow with A', async () => {
    const { onRespond } = setup(permission)
    screen.getByRole('button', { name: 'Deny' }).focus()
    await userEvent.keyboard('{Meta>}a{/Meta}')
    expect(onRespond).not.toHaveBeenCalled()
    await userEvent.keyboard('a')
    expect(onRespond).toHaveBeenCalledWith('s1', 'r1', { behavior: 'allow' })
  })

  it('ignores S without a per-session option', async () => {
    const { onRespond } = setup({ ...permission, payload: { toolName: 'Bash', input: {} } })
    screen.getByRole('button', { name: 'Allow' }).focus()
    await userEvent.keyboard('s')
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('opens the reason with D; Escape cancels, Enter confirms', async () => {
    const { onRespond } = setup(permission)
    screen.getByRole('button', { name: 'Allow' }).focus()
    await userEvent.keyboard('d')
    const reason = screen.getByLabelText('deny reason')
    expect(reason).toHaveFocus()
    // typing in the reason is text, not shortcuts
    await userEvent.keyboard('a')
    expect(onRespond).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByLabelText('deny reason')).toBeNull()
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus()
    await userEvent.keyboard('d')
    await userEvent.keyboard('nope{Enter}')
    expect(onRespond).toHaveBeenCalledWith('s1', 'r1', { behavior: 'deny', message: 'nope' })
  })
})

describe('RequestCard question form', () => {
  const two: SessionRequest = {
    ...question,
    payload: {
      input: {
        questions: [
          { question: 'Pick?', header: 'Approach', options: [{ label: 'Alpha', description: 'first', preview: 'alpha()' }, { label: 'Beta' }] },
          { question: 'Name?', options: [] },
        ],
      },
    },
  }

  it('waits for every answer before Submit and counts them', async () => {
    const { onRespond } = setup(two)
    const submit = screen.getByRole('button', { name: 'Submit' })
    expect(submit).toBeDisabled()
    expect(screen.getByText('0 of 2 answered')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
    expect(screen.getByText('1 of 2 answered')).toBeInTheDocument()
    expect(submit).toBeDisabled()
    await userEvent.type(screen.getByLabelText('other Name?'), 'Ann{Enter}')
    expect(onRespond).toHaveBeenCalledWith('s1', 'q1', { behavior: 'allow', answers: { 'Pick?': ['Alpha'], 'Name?': ['Ann'] } })
    expect(screen.queryByText(/answered$/)).toBeNull()
  })

  it('shows the header, option descriptions and previews', () => {
    setup(two)
    expect(screen.getByText('Approach')).toHaveClass('question-header')
    expect(screen.getByText('first')).toBeInTheDocument()
    expect(screen.getByText('alpha()')).toHaveClass('option-preview')
  })

  it('clears the radio when Other is typed for a single choice', async () => {
    setup(question)
    const alpha = screen.getByRole('radio', { name: /Alpha/ })
    await userEvent.click(alpha)
    await userEvent.type(screen.getByLabelText('other Pick?'), 'G')
    expect(alpha).not.toBeChecked()
    await userEvent.click(alpha)
    expect(screen.getByLabelText('other Pick?')).toHaveValue('')
  })
})
