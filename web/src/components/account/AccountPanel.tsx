import { Check, Copy } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { getAccount, startLogin, type AccountInfo, type AgentKind, type LoginChallenge } from '../../lib/api'
import { usePending } from '../../lib/pending'
import { describeError, fail } from '../../stores/notices'
import { useSessionStore } from '../../stores/session'
import { icon } from '../icon'
import { LoadFailed, LoadingLine } from '../ui/Loading'
import { useAccountChecks } from './checks'
import './AccountPanel.css'

const POLL_MS = 3000
// Device codes are short-lived; stop asking well after one could be used.
const CODE_TTL_MS = 15 * 60_000
const COPIED_MS = 1500

const agentName: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' }

const agents: AgentKind[] = ['claude', 'codex']

const installHint: Record<AgentKind, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
}

// Accounts shows each agent's login on its own line, whichever agent the
// new-session switch has chosen. Checks that failed are said once, with
// the quotas when they failed too, and one Retry asks again for all.
export function Accounts() {
  const failed = useAccountChecks((s) => s.failed)
  const retryAll = useAccountChecks((s) => s.retryAll)
  const quotasDown = useSessionStore((s) => s.quotasStatus === 'error' && s.quotas.length === 0)
  const loadQuotas = useSessionStore((s) => s.loadQuotas)
  const down = agents.filter((a) => failed[a] !== undefined)
  let line: string | null = null
  if (down.length === agents.length) line = quotasDown ? "Couldn't reach the accounts or quotas" : "Couldn't reach the accounts"
  else if (down.length === 1) line = `Couldn't check the ${agentName[down[0]!]} account: ${failed[down[0]!]}${quotasDown ? ' (and the quotas)' : ''}`
  return (
    <div className="accounts">
      {line && (
        <LoadFailed
          onRetry={() => {
            retryAll()
            if (quotasDown) void loadQuotas()
          }}
        >
          {line}
        </LoadFailed>
      )}
      <AccountPanel agent="claude" quietFailure />
      <AccountPanel agent="codex" quietFailure />
    </div>
  )
}

// AccountPanel shows an agent's login state and, for Codex, the device-code
// flow. A failed check is its own line with a Retry, unless quietFailure
// leaves it to Accounts.
export default function AccountPanel({ agent, quietFailure = false }: { agent: AgentKind; quietFailure?: boolean }) {
  const setFailed = useAccountChecks((s) => s.setFailed)
  const retry = useAccountChecks((s) => s.retry)
  const [account, setAccount] = useState<AccountInfo | null>(null)
  const [checked, setChecked] = useState(false)
  // checkFailed is why the first look at the account failed.
  const [checkFailed, setCheckFailed] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [login, setLogin] = useState<LoginChallenge | null>(null)
  const [expired, setExpired] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getAccount(agent)
      .then((a) => {
        if (!alive) return
        setAccount(a)
        setCheckFailed(null)
        setFailed(agent, null)
      })
      .catch((e) => {
        if (!alive) return
        setCheckFailed(describeError(e))
        setFailed(agent, describeError(e))
      })
      .finally(() => alive && setChecked(true))
    return () => {
      alive = false
    }
  }, [agent, attempt, retry, setFailed])

  // Codex finishes the device-code login on its own; poll until it does or
  // the code runs out.
  const waiting = login !== null && !account?.loggedIn
  useEffect(() => {
    if (!waiting) return
    const poll = setInterval(() => {
      getAccount(agent)
        .then((a) => {
          setAccount(a)
          setError(null)
          if (a.loggedIn) setLogin(null)
        })
        .catch((e) => setError(describeError(e)))
    }, POLL_MS)
    const expire = setTimeout(() => {
      setLogin(null)
      setExpired(true)
    }, CODE_TTL_MS)
    return () => {
      clearInterval(poll)
      clearTimeout(expire)
    }
  }, [agent, waiting])

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(id)
  }, [copied])

  const request = useCallback(async () => {
    setError(null)
    setExpired(false)
    try {
      setLogin(await startLogin(agent))
    } catch (e) {
      setError(describeError(e))
    }
  }, [agent])
  const [signIn, requesting] = usePending(request)

  const name = agentName[agent]
  if (checked && checkFailed && !account && quietFailure) return null
  if (!checked || (checkFailed && !account)) {
    return (
      <div className="account">
        {checked ? (
          <LoadFailed
            onRetry={() => {
              setChecked(false)
              setAttempt((n) => n + 1)
            }}
          >{`Couldn't check the ${name} account: ${checkFailed}`}</LoadFailed>
        ) : (
          <LoadingLine>{`checking ${name} account…`}</LoadingLine>
        )}
      </div>
    )
  }

  const copy = () => {
    if (!login) return
    const write = navigator.clipboard?.writeText(login.userCode) ?? Promise.reject(new Error('The clipboard is not available here'))
    write.then(
      () => setCopied(true),
      (err: unknown) => fail("Couldn't copy the code", err, 'copy-code'),
    )
  }

  if (account?.cliMissing) {
    return (
      <div className="account">
        <span className="signed-in">
          <span className="account-missing">{`${name} CLI not found on PATH`}</span>
          <span className="account-hint">
            install: <code>{installHint[agent]}</code>
          </span>
        </span>
      </div>
    )
  }

  return (
    <div className="account">
      {account?.loggedIn ? (
        <span className="signed-in">
          <span className="account-agent">{name}</span>
          {account.email
            ? ` Signed in as ${account.email} (${account.plan || account.authMode})`
            : ` Signed in with the ${account.authMode === 'cli' ? 'CLI login' : account.authMode || 'CLI login'}`}
        </span>
      ) : agent !== 'codex' ? (
        <span className="signed-in">
          <span className="account-agent">{name}</span> not signed in · sign in with its CLI
        </span>
      ) : expired ? (
        <span className="code-expired">
          Code expired ·{' '}
          <button type="button" className="btn btn-xs" aria-busy={requesting || undefined} onClick={() => void signIn()}>
            {requesting ? 'Requesting code…' : 'New code'}
          </button>
        </span>
      ) : (
        !login && (
          <button className="btn sign-in" aria-busy={requesting || undefined} onClick={() => void signIn()}>
            {requesting ? 'Requesting code…' : 'Sign in to Codex'}
          </button>
        )
      )}
      {login && (
        <div className="device-code">
          <p>
            Enter code <code>{login.userCode}</code>
            <button
              type="button"
              className="btn btn-ghost btn-icon copy-code"
              aria-label="Copy code"
              title="Copy code"
              onClick={copy}
            >
              {copied ? <Check {...icon(14)} /> : <Copy {...icon(14)} />}
            </button>
            {copied && (
              <span className="copied" role="status">
                copied
              </span>
            )}
          </p>
          <p>
            at{' '}
            <a href={login.url} target="_blank" rel="noreferrer">
              {login.url}
            </a>
          </p>
          <p className="device-code-wait">
            <span className="busy-mark" aria-hidden="true" /> waiting for sign-in
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setLogin(null)}>
              Cancel
            </button>
          </p>
        </div>
      )}
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
