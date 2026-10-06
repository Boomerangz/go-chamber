import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  const { container } = render(<RequestCard request={request} onRespond={onRespond} />)
  return { onRespond, container }
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
    await userEvent.type(screen.getByLabelText('Deny reason'), 'not now')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }))
    expect(onRespond).toHaveBeenCalledWith('s1', 'r1', { behavior: 'deny', message: 'not now' })
  })
})

describe('RequestCard prompt', () => {
  it('drops a prompt that only repeats the command shown below it', () => {
    const { container } = setup({ ...permission, prompt: 'Claude wants to run:  rm -rf build\n&& ls', payload: { toolName: 'Bash', input: { command: 'rm -rf build && ls' } } })
    expect(container.querySelector('.request-prompt')).toBeNull()
    expect(container.querySelector('.request-cmd, pre')).toHaveTextContent('rm -rf build && ls')
  })

  it('keeps a prompt that says more than the command', () => {
    const { container } = setup({ ...permission, prompt: 'Claude wants to delete the build folder', payload: { toolName: 'Bash', input: { command: 'rm -rf build' } } })
    expect(container.querySelector('.request-prompt')).toHaveTextContent('delete the build folder')
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
    await userEvent.type(screen.getByLabelText('Other Pick?'), 'Gamma')
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
    await userEvent.type(screen.getByLabelText('Other Pick?'), 'Gamma')
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
    const reason = screen.getByLabelText('Deny reason')
    expect(reason).toHaveFocus()
    // typing in the reason is text, not shortcuts
    await userEvent.keyboard('a')
    expect(onRespond).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByLabelText('Deny reason')).toBeNull()
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
    await userEvent.type(screen.getByLabelText('Other Name?'), 'Ann{Enter}')
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
    await userEvent.type(screen.getByLabelText('Other Pick?'), 'G')
    expect(alpha).not.toBeChecked()
    await userEvent.click(alpha)
    expect(screen.getByLabelText('Other Pick?')).toHaveValue('')
  })
})

describe('RequestCard arrival', () => {
  afterEach(() => vi.useRealTimers())

  const withField = (value: string) => {
    const field = document.createElement('textarea')
    field.value = value
    document.body.appendChild(field)
    field.focus()
    return field
  }

  it('takes focus when nothing is being written, so A answers at once', () => {
    const { onRespond } = setup(permission)
    expect(document.activeElement).toHaveClass('request')
    fireEvent.keyDown(document.activeElement!, { key: 'a' })
    expect(onRespond).toHaveBeenCalledWith('s1', 'r1', { behavior: 'allow' })
  })

  it('leaves focus in a field that holds text', () => {
    const field = withField('half a sentence')
    setup(permission)
    expect(document.activeElement).toBe(field)
    field.remove()
  })

  it('leaves focus in another card', () => {
    setup(permission)
    const first = document.activeElement
    render(<RequestCard request={{ ...permission, id: 'r2' }} onRespond={vi.fn()} />)
    expect(document.activeElement).toBe(first)
  })

  it('ignores the keys typed right after it took focus from an empty field', () => {
    vi.useFakeTimers({ now: 1000, toFake: ['Date'] })
    const field = withField('')
    const { onRespond } = setup(permission)
    expect(document.activeElement).toHaveClass('request')
    fireEvent.keyDown(document.activeElement!, { key: 'a' })
    expect(onRespond).not.toHaveBeenCalled()
    vi.setSystemTime(1600)
    fireEvent.keyDown(document.activeElement!, { key: 'a' })
    expect(onRespond).toHaveBeenCalledTimes(1)
    field.remove()
  })

  it('focuses the first option of a question; number keys pick options', async () => {
    const { onRespond } = setup(question)
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Alpha/ }))
    fireEvent.keyDown(document.activeElement!, { key: '2' })
    const beta = screen.getByRole('radio', { name: /Beta/ })
    expect(beta).toBeChecked()
    expect(beta).toHaveFocus()
    fireEvent.keyDown(beta, { key: '7' })
    fireEvent.keyDown(beta, { key: '1', ctrlKey: true })
    fireEvent.keyDown(beta, { key: 'x' })
    expect(beta).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onRespond).toHaveBeenCalledWith('s1', 'q1', { behavior: 'allow', answers: { 'Pick?': ['Beta'] } })
  })

  it('picks within the question that has focus, and not while typing Other', () => {
    setup({
      ...question,
      payload: {
        input: {
          questions: [
            { question: 'One?', options: [{ label: 'A1' }, { label: 'A2' }] },
            { question: 'Two?', multiSelect: true, options: [{ label: 'B1' }, { label: 'B2' }] },
          ],
        },
      },
    })
    const b1 = screen.getByRole('checkbox', { name: /B1/ })
    fireEvent.keyDown(b1, { key: '2' })
    expect(screen.getByRole('checkbox', { name: /B2/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /A2/ })).not.toBeChecked()
    fireEvent.keyDown(screen.getByLabelText('Other One?'), { key: '1' })
    expect(screen.getByRole('radio', { name: /A1/ })).not.toBeChecked()
  })
})

describe('RequestCard details', () => {
  it('skips a question, answering it with a refusal', async () => {
    const { onRespond } = setup(question)
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(onRespond).toHaveBeenCalledWith('s1', 'q1', { behavior: 'deny' })
  })

  it('says which of several requests this is', () => {
    render(<RequestCard request={permission} position={{ index: 2, count: 3 }} onRespond={vi.fn()} />)
    expect(screen.getByText('· 2 of 3')).toHaveClass('request-pos')
  })

  it('says nothing of position for a single request', () => {
    const { container } = render(<RequestCard request={question} position={{ index: 1, count: 1 }} onRespond={vi.fn()} />)
    expect(container.querySelector('.request-pos')).toBeNull()
  })

  it('says what allowing for the session adds', () => {
    setup({
      ...permission,
      payload: { ...permission.payload, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] }] },
    })
    const grants = screen.getByText('for session: adds rule: Bash(npm test:*)')
    expect(screen.getByRole('button', { name: 'Allow for session' })).toHaveAttribute('aria-describedby', grants.id)
  })

  it('shows a command as code with its description, the raw input folded', () => {
    const { container } = setup({ ...permission, payload: { toolName: 'Bash', input: { command: 'npm test', description: 'Run the tests' } } })
    expect(container.querySelector('.request-command')).toHaveTextContent('npm test')
    expect(screen.getByText('Run the tests')).toHaveClass('request-desc')
    const raw = screen.getByText('Raw input').closest('details')!
    expect(raw.querySelector('.request-input')!.textContent).toContain('"description": "Run the tests"')
  })

  it('shows an edit as a diff of its file', () => {
    const { container } = setup({
      ...permission,
      payload: { toolName: 'Edit', input: { file_path: '/a.go', old_string: 'a', new_string: 'b' } },
    })
    expect(screen.getByRole('group', { name: 'diff of /a.go' })).toBeInTheDocument()
    expect(container.querySelector('.idiff-del')).toHaveTextContent('a')
    expect(container.querySelector('.idiff-add')).toHaveTextContent('b')
    expect(screen.getByText('Raw input')).toBeInTheDocument()
  })

  it('names a diff without a path', () => {
    setup({ ...permission, payload: { toolName: 'MultiEdit', input: { edits: [{ old_string: 'a', new_string: 'b' }] } } })
    expect(screen.getByRole('group', { name: 'diff' })).toBeInTheDocument()
  })

  it('keeps other input as it came', () => {
    const { container } = setup({ ...permission, payload: { toolName: 'WebFetch', input: { url: 'https://x' } } })
    expect(container.querySelector('.request-input')!.textContent).toContain('"url": "https://x"')
    expect(screen.queryByText('Raw input')).toBeNull()
  })
})
