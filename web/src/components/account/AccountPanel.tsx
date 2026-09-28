import { useEffect, useState } from 'react'
import { getAccount, startLogin, type AccountInfo, type AgentKind, type LoginChallenge } from '../../lib/api'

// AccountPanel shows the Codex login state and the device-code flow.
export default function AccountPanel({ agent }: { agent: AgentKind }) {
  const [account, setAccount] = useState<AccountInfo | null>(null)
  const [login, setLogin] = useState<LoginChallenge | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (agent !== 'codex') return
    let alive = true
    getAccount(agent)
      .then((a) => alive && setAccount(a))
      .catch((e) => alive && setError(message(e)))
    return () => {
      alive = false
    }
  }, [agent])

  // Codex finishes the device-code login on its own; poll until it does.
  const waiting = login !== null && !account?.loggedIn
  useEffect(() => {
    if (!waiting) return
    const id = setInterval(() => {
      getAccount(agent)
        .then((a) => {
          setAccount(a)
          if (a.loggedIn) setLogin(null)
        })
        .catch(() => {})
    }, 3000)
    return () => clearInterval(id)
  }, [agent, waiting])

  if (agent !== 'codex') return null

  return (
    <div className="account">
      {account?.loggedIn ? (
        <span className="signed-in">
          Signed in as {account.email || 'unknown'} ({account.plan || account.authMode})
        </span>
      ) : (
        <button
          className="btn sign-in"
          onClick={() => {
            startLogin(agent)
              .then(setLogin)
              .catch((e) => setError(message(e)))
          }}
        >
          Sign in to Codex
        </button>
      )}
      {login && (
        <div className="device-code">
          Enter code <code>{login.userCode}</code> at{' '}
          <a href={login.url} target="_blank" rel="noreferrer">
            {login.url}
          </a>
        </div>
      )}
      {error && <span className="error">{error}</span>}
    </div>
  )
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
