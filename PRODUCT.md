# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
One developer — the owner — running their own coding agents. Primary scene: long working
sessions at a desktop, often several agents in parallel with a terminal alongside. Secondary
scenes: steering the same sessions from a phone, and from a remote desktop/browser away from the
host machine.

## Product Purpose
A local, single-user web UI for running Claude Code and Codex CLI on the owner's own
subscriptions. It streams agent turns, surfaces agent requests (permissions, questions) for an
answer, shows subagents, hooks, quotas, model and effort, and hosts terminals and worktrees.
Success: the owner can drive and supervise agents without dropping into the raw CLI.

## Positioning
One place for both Claude and Codex, with one vocabulary (Session / Turn / Item / Request /
Quota) across agents, reachable from desktop, phone and remote browser. It runs the stock CLIs
with the user's own login — no tokens read or stored, one Go binary.

## Operating Context
- Served by the local Go binary; frontend embedded; must work offline (no CDN assets).
- Agent CLIs: `claude -p` (stream-json) and `codex app-server` (JSON-RPC).
- UI copy is English; chat content is frequently Russian (Cyrillic must render well, including in
  monospace).
- Chat and terminal content are long-running, streamed, and dense (code, diffs, tool output).

## Capabilities and Constraints
- Sessions list grouped by folder, chat with streaming items (assistant, user, tool, hook,
  subagent), request tray/cards, model & effort picker, folder picker, quota widget, account
  panel, docked and standalone terminals (xterm), mobile viewport.
- Playwright e2e and Vitest tests bind to existing class names and roles; they must keep passing.
- Undecided: PWA/push polish scope.

## Evidence on Hand
No testimonials, customers or metrics exist; do not fabricate any.

## Product Principles
1. Supervision first: what the agent is doing and what it needs from me must be obvious at a glance.
2. Agent-neutral: Claude and Codex are peers; neither is styled as the default.
3. Dense but calm: long sessions, lots of text — reduce fatigue, not information.
4. Same tool on every screen: desktop, phone and remote browser are equal citizens.

## Accessibility & Inclusion
Light and dark themes following the system setting are required. Respect reduced motion.
