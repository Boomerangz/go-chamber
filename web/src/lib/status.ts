import type { Session, SessionStatus } from './api'

// ShownStatus is the one state a session shows, the same in the chat
// header, the sessions list and the transcript tail.
export type ShownStatus = SessionStatus | 'waiting' | 'done' | 'failed'

export interface StatusFacts {
  // status is the session's own state.
  status: SessionStatus
  // started: the agent ran in this session at least once (it has a native
  // id). A session never started isn't detached from anything.
  started: boolean
  // waiting counts the requests open for the owner.
  waiting: number
  // failed: the last turn failed (known for the open session).
  failed?: boolean
  // finished: a turn just ended on its own (see useJustFinished).
  finished?: boolean
  // owed: the turn was cut off while it waited for the owner (owesAnswer).
  owed?: boolean
}

// owesAnswer tells an interrupted session whose turn was cut off while a
// question or permission waited for the owner (a restart, a crash): the
// request is gone, but the owner still has to come back to it.
export function owesAnswer(s: Pick<Session, 'status' | 'interruption'>): boolean {
  return s.status === 'interrupted' && !!s.interruption?.withRequest
}

// shownStatus derives what a session shows: a request waiting for the owner
// comes first, then a running or interrupted turn, then how the last turn
// ended; a session at rest is idle, or detached once its agent has gone.
export function shownStatus({ status, started, waiting, failed, finished, owed }: StatusFacts): ShownStatus {
  if (waiting > 0 || owed) return 'waiting'
  if (status === 'running' || status === 'interrupted') return status
  if (failed) return 'failed'
  if (finished) return 'done'
  if (status === 'detached' && !started) return 'idle'
  return status
}

// statusWord is the lowercase word printed beside the state mark.
export function statusWord(status: ShownStatus): string {
  return status === 'waiting' ? 'waiting for you' : status
}
