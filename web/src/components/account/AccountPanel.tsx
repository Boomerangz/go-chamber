import { Check, Copy } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { getAccount, startLogin, type AccountInfo, type AgentKind, type LoginChallenge } from '../../lib/api'
import { usePending } from '../../lib/pending'
import { describeError } from '../../stores/notices'
import { icon } from '../icon'
import { LoadingLine } from '../ui/Loading'
import './AccountPanel.css'

const POLL_MS = 3000
// Device codes are short-lived; stop asking well after one could be used.
const CODE_TTL_MS = 15 * 60_000
const COPIED_MS = 1500

// AccountPanel shows the Codex login state and the device-code flow.
export default function AccountPanel({ agent }: { agent: AgentKind }) {
  const [account, setAccount] = useState<AccountInfo | null>(null)
  const [checked, setChecked] = useState(false)
  const [login, setLogin] = useState<LoginChallenge | null>(null)
  const [expired, setExpired] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (agent !== 'codex') return
    let alive = true
    getAccount(agent)
      .then((a) => alive && setAccount(a))
      .catch((e) => alive && setError(describeError(e)))
      .finally(() => alive && setChecked(true))
    return () => {
      alive = false
    }
  }, [agent])

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

  if (agent !== 'codex') return null
  if (!checked) {
    return (
      <div className="account">
        <LoadingLine>checking account…</LoadingLine>
      </div>
    )
  }

  const copy = () => {
    if (!login) return
    navigator.clipboard?.writeText(login.userCode).then(
      () => setCopied(true),
      () => {},
    )
  }

  return (
    <div className="account">
      {account?.loggedIn ? (
        <span className="signed-in">
          Signed in as {account.email || 'unknown'} ({account.plan || account.authMode})
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
              {copied ? <Check {...icon(13)} /> : <Copy {...icon(13)} />}
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
