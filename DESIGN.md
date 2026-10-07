---
name: go-chamber
description: A local supervisor for Claude Code and Codex, set as a living specification.
colors:
  paper: "#f3f3f1"
  paper-2: "#e9e9e5"
  paper-3: "#dfdfda"
  ink: "#16171a"
  ink-2: "#45474d"
  ink-3: "#66686e"
  rule: "#d3d3cd"
  rule-strong: "#8c8c86"
  act: "#2433d6"
  act-ink: "#ffffff"
  act-wash: "rgba(36, 51, 214, 0.09)"
  act-ring: "rgba(36, 51, 214, 0.55)"
  req: "#8f5200"
  req-mark: "#b86a00"
  req-wash: "rgba(184, 106, 0, 0.1)"
  bad: "#b3261e"
  bad-wash: "rgba(179, 38, 30, 0.08)"
  paper-dark: "#0f1012"
  paper-2-dark: "#16171a"
  paper-3-dark: "#1e2023"
  ink-dark: "#e4e2dc"
  ink-2-dark: "#b3b1ab"
  ink-3-dark: "#8d8f95"
  rule-dark: "#2a2c30"
  rule-strong-dark: "#5e6066"
  act-dark: "#8c98ff"
  act-ink-dark: "#0f1012"
  req-dark: "#e3a33a"
  req-mark-dark: "#e3a33a"
  bad-dark: "#f07a6a"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.005em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.5
  transcript:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "tnum"
  body-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  masthead:
    fontFamily: "'PT Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "14px"
    fontWeight: 400
    letterSpacing: "0.01em"
  control:
    fontFamily: "'PT Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "12.5px"
    fontWeight: 400
  meta:
    fontFamily: "'PT Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
  label:
    fontFamily: "'PT Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "11.5px"
    fontWeight: 400
    letterSpacing: "0.06em"
rounded:
  mark: "1px"
  r: "2px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "14px"
  gutter: "20px"
  gutter-mobile: "14px"
  turn-margin: "56px"
  measure: "72ch"
components:
  button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    height: "30px"
    padding: "0 12px"
  button-primary:
    backgroundColor: "{colors.act}"
    textColor: "{colors.act-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    height: "30px"
    padding: "0 12px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.bad}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    height: "30px"
    padding: "0 12px"
  button-danger-hover:
    backgroundColor: "{colors.bad-wash}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
  button-xs:
    height: "24px"
    padding: "0 8px"
  field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r}"
    height: "32px"
    padding: "0 10px"
  chip:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-2}"
    typography: "{typography.meta}"
    rounded: "{rounded.r}"
    height: "24px"
    padding: "0 8px"
  count:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.r}"
    height: "18px"
    padding: "0 4px"
  count-request:
    backgroundColor: "{colors.req}"
    textColor: "{colors.paper}"
    rounded: "{rounded.r}"
    height: "18px"
  session-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.r}"
    padding: "6px 8px"
  session-row-active:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
  requires-block:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r}"
    padding: "12px 14px 14px"
  output-block:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink-2}"
    padding: "8px 12px"
  composer:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.r}"
    padding: "6px 6px 6px 12px"
---

# Design System: go-chamber

## Overview

**Creative North Star: "The Living Specification"**

Every session reads like an RFC that is still being written. The page is one sheet of cool paper printed in one ink; hairline rules divide it into regions, and nothing floats above it. PT Mono carries the structure (the masthead, section labels, turn numbers, metadata, normative keywords, and every button), while the system sans carries what people and agents actually say. The transcript is a numbered document: turn numbers hang in a left margin, user turns open a new ruled section with a vertical ink rule instead of a bubble, and tool output sits in indented plaintext blocks.

Colour is reserved for meaning, not mood. Ink-blue marks what you can press, amber marks what needs you, and red marks what broke or destroys. Everything else, including session state, is carried by the form of a small square mark. The world replaces an earlier dark glass and gradient look; that look is rejected, not softened.

Density is high but calm: long streamed sessions in Russian and English, several agents at once, a terminal alongside. Motion is short and typographic, with a little life where the owner is needed: items settle, requests spring in from the margin, a running mark breathes and a finished one lands, and an answered request is struck through and folds into a one-line record.

**Key Characteristics:**
- One sheet, one ink, hairline rules; light and dark follow the system setting.
- Structure in PT Mono, prose in the system sans.
- State is form: solid, hollow, struck, dashed. No hue on state.
- Three signal colours, each with one job: act, requires, fails.
- Flat: no elevation shadows, 2px corners.
- The REQUIRES block is the signature; its answer stays in the transcript as a struck record.

## Colors

A near-neutral paper and ink pair with three narrow signal colours, each rationed to a single meaning. Dark mode swaps sheet and ink (`paper-dark`, `ink-dark`) and lifts the signals for contrast; the roles do not change.

### Primary
- **Ink Blue** (`act`): Only the actionable. Primary buttons, links, the Browse control, the "show more" link, the caret, focus rings (`act-ring`), focused field borders, the selected model and question option (`act-wash`), and the question variant of the REQUIRES block. Never decoration, never state.

### Secondary
- **Requisition Amber** (`req-mark`, text tone `req`): What needs the owner. The REQUIRES APPROVAL block's border, top rule and keyword; the pending-request counts in the sidebar, dock rail and mobile pane bar (printed on the deeper `req` tone so their small paper figures stay legible); the request tray's kind label and hover wash. The build also uses it on the interrupted-turn banner and on a quota meter nearing its limit, both of which are things that need the owner.

### Tertiary
- **Failure Red** (`bad`, wash `bad-wash`): Failure and destruction only. Deny, Stop, close-terminal on hover, stop-task, failed tool items, DENIED decisions, error text, toasts, the offline and unauthorized health marks, and a quota meter at its limit.

### Neutral
- **Cool Paper** (`paper`): The one sheet: page, panels, sidebar, dock, cards, fields and menus all share it.
- **Pressed Paper** (`paper-2`): Only for hover and active rows (session, terminal, folder, model option) and for plaintext output blocks (tool output, request input). It is never a panel background.
- **Deep Paper** (`paper-3`): The checked segment of the agent switch and the quota meter track.
- **Ink** (`ink`): Body text, headings, the running mark, the user-turn rule, the selected-tab underline, neutral counts, filled effort segment.
- **Ink 2 / Ink 3** (`ink-2`, `ink-3`): Secondary prose and metadata, then labels, placeholders, turn numbers and idle chrome.
- **Rule / Strong Rule** (`rule`, `rule-strong`): Hairlines that divide regions, then the borders of controls, fields, and output-block left edges. The strong rule holds 3:1 against the sheet in both schemes, so a field's edge is visible on its own.

### Named Rules
**The One Sheet Rule.** There is one surface colour. Regions are divided by 1px rules, never by a second panel tone; pressed paper appears only under a hovered or active row and behind output.

**The Act Rule.** Ink-blue means "you can press this" or "this has focus". If it cannot be pressed, it is not blue.

**The Needs-You Rule.** Amber means the owner is needed now. The REQUIRES block and pending counts hold it; nothing decorative ever does.

**The Broken Rule.** Red means something failed or will be destroyed. A Deny or Stop is red because it ends something, not for emphasis.

## Typography

**Display Font:** none; the system sans (`-apple-system`, SF Pro Text, system-ui, Segoe UI, Roboto) sets the few headings at weight 600.
**Body Font:** the system sans, 14px, tabular figures on by default.
**Label/Mono Font:** PT Mono 400, self-hosted through `@fontsource/pt-mono` (with ui-monospace, SF Mono, Menlo), so it works offline and renders Cyrillic.

**Character:** A man-page pairing. The mono is the typewritten apparatus of the document (numbers, keywords, paths, controls); the sans is the readable voice inside it.

### Hierarchy
- **Headline** (600, 20px, -0.005em): The session title as the document title in the chat header; the notice heading. The empty-state hero steps to 22px.
- **Title** (600, 15px): The REQUIRES block title; the terminal header title. The folder picker heading uses 16px.
- **Transcript** (400, 15px, 1.6; user turns 1.55): Assistant and user text, capped at a 72ch measure.
- **Body** (400, 14px, 1.5): Default UI prose.
- **Body small** (13px): Tool, command, file and subagent items; session titles (500); hints.
- **Masthead** (PT Mono 400, 14px, 0.01em): The product name in the top bar.
- **Control** (PT Mono 400, 12.5px; 12px at extra-small): Every `.btn`, the folder input, group names, terminal tabs, crumbs.
- **Meta** (PT Mono 400, 12px): Paths, model name, token usage, health, status words (lowercase), turn numbers.
- **Label** (PT Mono 400, 11.5px, 0.06em, uppercase): Section titles in panels, date buckets, the REQUIRES keyword (12px), the decision keyword, the unseen mark.

### Named Rules
**The Mono Carries Structure Rule.** Anything that names, numbers, labels or commands is set in PT Mono; anything someone wrote to be read is set in the sans. Buttons are commands, so buttons are mono.

**The Bracket Rule.** Tags and outcomes that annotate a line are printed in square brackets generated by CSS: model tags, hook outcomes, the repo badge. Buttons are not bracketed.

## Layout

A three-column document on desktop: a 300px sessions table of contents, the transcript, and a right dock (44px icon rail, expanding to a requests tray at minmax(300px, 26%) or a terminal at minmax(420px, 38%)). The top bar is 44px, a three-part grid with the masthead left, the Agents/Terminal mode switch centred, and health right. Terminal mode is its own two-column workspace (300px list, terminal).

The transcript column is capped at the 72ch measure plus a 56px left margin in which turn numbers hang, right-aligned in a 34px box. The REQUIRES block, the hint and the composer share that column so the request sits directly above the composer.

The sessions list is an outline: folder groups (name followed by `/` and a count in parentheses) with a 1px left rule indenting their sessions, and subagent children drawn with an L-shaped hairline connector. Each session row is a fixed label grid: agent box, then title over state, request count and age. Every row carries its state mark, idle and detached included (as the mark alone). Its "⋯" menu sits over the row's right edge on hover (always on phones, where the row keeps that edge clear). The list never scrolls sideways: long folder names and titles end in an ellipsis. The search, the folders, Archived and History read as one column that scrolls under the pinned search, so opening a section never squeezes the list. Archiving puts a session away, not its requests: an archived session that waits for you keeps its amber mark and count (the Archived fold carries the count too), stays in the Requests inbox, and its menu still stops a running turn; the archive itself says so in a notice with Undo.

Spacing works on small steps (4, 6, 8, 10, 12, 14px) with a 20px gutter. At 1100px the sidebar narrows to 260px and the dock grows to 40%. At 720px the layout becomes a single pane switched by a fixed 56px bottom pane bar (Sessions, Chat, Requests), the top bar is one 44px row with the mode switch in the masthead's place, the sessions pane scrolls as a whole (new-session form folded to one "Start a session" line, the account and quotas at the end), the gutter drops to 14px, turn numbers move inline, buttons grow to 36px, inputs go to 16px to avoid zoom, and the folder picker becomes an 88dvh bottom sheet. Safe-area insets are honoured.

## Elevation & Depth

The system is flat. Nothing is lifted: panels, menus, the folder picker and the toast sit on the same paper and are separated from what is underneath only by a rule (the picker by a 1px ink border over a 55% paper scrim). `box-shadow` appears only as a line: a 1px `act` ring around a focused field or composer, an inset 1px rule on the meter track, an inset 2px paper gap inside a selected radio (model or question option), a 1px amber line that doubles the frame of a focused permission card, and an inset 1px amber underline on a search hit.

### Named Rules
**The Flat Sheet Rule.** No elevation shadow, blur, glass or gradient fill anywhere. Depth is expressed by a rule, a border weight change (rule to ink), or pressed paper.

## Shapes

Corners are barely softened: 2px (`r`) on every control, block, row, count and menu; 1px on the small state marks and the model radio. Counts are numbers in a square, never a pill. Borders are 1px throughout; 2px appears only as the selected-tab underline (mode switch, terminal tabs, pane bar) and the 3px amber top rule of the REQUIRES block. Dashed lines carry a single meaning, something not yet settled: detached state, a connecting health mark, a streaming tool line, an open subagent's rail, reasoning, the device-code box and the unseen rule.

### Named Rules
**The State Is Form Rule.** Session and agent state is a small square mark next to a lowercase word, and only its form changes: solid ink square = running, hollow = idle, struck (a diagonal slash) = interrupted, dashed outline = detached. State never takes a hue.

## Components

### Buttons
Plain typed commands on paper.
- **Shape:** 2px corners, 1px border, 30px tall (36px on mobile), PT Mono 12.5px.
- **Default:** paper with a strong-rule border and ink text; hover darkens the border to ink; active presses to `paper-2`.
- **Primary:** solid ink-blue with white (dark: paper) text; hover swaps the border to ink. One primary per group (New session, Allow, Send/Steer).
- **Danger:** transparent with a red border and red text; hover adds `bad-wash`.
- **Ghost / Icon:** borderless and `ink-2` until hover shows a rule border; icon buttons are 28px square.
- **Disabled:** `ink-3` text on a plain rule border, on the sheet: a disabled primary loses its fill, and nothing disabled is faded with opacity. Borderless controls (agent segment, dock rail) rest at `ink-2` so their disabled `ink-3` reads apart.
- **Focus:** 2px `act-ring` outline, 1px offset, globally. A permission card that holds focus (so A/S/D answer it) draws its amber frame twice as heavy instead, never a ring a pixel outside its border.
- **Choices:** radios and checkboxes are 12px squares with 1px corners on the sheet, never the browser's control: checked is ink-blue, a radio with a 2px paper gap inside, a checkbox with a paper tick.

### Chips
- **Style:** 24px, PT Mono 12px, 2px corners, strong-rule border on paper, `ink-2` text; hover to an ink border and ink text. Used for recent folders and terminal projects.

### Cards / Containers
- **Corner Style:** 2px.
- **Background:** paper; output blocks inside them are `paper-2` with a 1px strong-rule left edge, max 220 to 280px tall and scrolling.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** 1px rule; the folder picker uses 1px ink.
- **Internal Padding:** 12 to 16px.

### Inputs / Fields
- **Style:** 32px, 1px strong-rule border, 2px corners, paper; selects draw their own 10px chevron.
- **Focus:** border turns ink-blue plus a 1px ink-blue ring. The session search is a bottom rule only, which turns blue on focus.
- **Composer:** the same field language wrapping an auto-growing textarea with the action buttons inside it, sharing the transcript column.

### Navigation
- **Mode switch:** sans 13px/500 text tabs the full height of the top bar; `ink-3` at rest, ink with a 2px ink underline when checked. On a wide bar a tab's count sits on its corner, in the padding after the word, so a count that comes or goes moves no tab.
- **Sessions TOC:** rows with a transparent 1px border; hover to `paper-2`; active to `paper-2` with a strong-rule border and ink title.
- **Dock rail:** 32px icon buttons with lucide icons at 1.5 stroke; pressed state is a 1px ink border. Counts sit on the corner: ink for neutral, amber for pending requests.
- **Mobile:** a three-button pane bar with a 2px ink top rule on the selected pane and an amber count on Requests.

### The REQUIRES Block (signature)
The only amber object on screen. A 2px-cornered paper block with a 1px amber border and a 3px amber rule across its top. The title line pairs the keyword `REQUIRES APPROVAL` (PT Mono uppercase, `req`) with the request name in 15px/600, then the prompt, `tool: Name`, the input in an output block, and Allow (primary), Allow for session (default), Deny (danger). A question is the same block in ink-blue with `REQUIRES ANSWER` and bordered option rows that take `act-wash` when checked. It enters from the left margin and scrolls itself into view.

### Decision Record (signature)
When a request is answered, the block strikes a 1px ink line across its title, fades and collapses, and a single line is written into the transcript: the outcome keyword (PT Mono uppercase, ink; red for DENIED) followed by the request name in `ink-3`, struck through only when denied (an approved name struck through reads as cancelled), with any answer text beneath. A skipped question and an answered one name nothing; the answer is the record. The transcript keeps what was decided.

### Unseen Mark
"new since you left": a PT Mono uppercase label in ink followed by a dashed ink rule running to the column edge, placed before the first unseen item.

### Transcript Items
Tool, command and file items are one mono line with a 13px lucide icon; pending and streaming lines take a dashed underline, failed ones turn red. Hooks are a single line with the hook name and a bracketed outcome; `[BLOCKED]` is struck through in ink, `[ERROR]` is red, success stays quiet. Reasoning folds behind a `+`/`−` summary with a dashed left rule. Subagents indent under a dashed rail that turns solid when finished.

### Meters
Quota meters are 4px bars: a `paper-3` track with an inset hairline and a solid ink fill, amber when nearing the limit and red at the limit.

### Loading and Pending
Nothing on the way is shown as a spinner; it takes the "not yet settled" form. A dashed square that breathes (1.2s) leads a mono `ink-3` line ("loading sessions…", "searching messages…") or a busy button. A busy button keeps its colour and focus, sets `aria-busy`, guards against a second trigger, and swaps its label for the "…ing" form ("Starting…", "Allowing…", "Stopping…"). Controls that a success removes stay busy until they leave. Lists that have not loaded yet show dashed skeleton rows, never their empty state. A load that failed says so in red with a Retry. Choices such as the model or permission mode apply at once in the unsettled form (`ink-3`, dashed underline) and revert if the server refuses. While a turn runs and no reply streams (a tool or subagent may), the transcript tail reads "working · 0:42", or "waiting for you" when a request is open.

### Notices
Failures that can't be shown in place stack beside what is being read, at most three: in the open chat, off the transcript column (whose messages carry their actions), in the margin to its right under the chat header when a sheet fits there, else at the transcript's end just above the composer; with no session open, the empty workspace's top right corner; with neither on screen, bottom right clear of the dock rail on desktop and just above the pane bar on phones. A notice never sits on a control, and the stack takes no clicks outside its sheets. Each is a paper sheet with a 1px rule (red for errors): a mono uppercase title naming what failed ("COULDN'T FORK THE SESSION"), the reason in sans, and a lucide X. Errors stay until dismissed; a quiet confirmation ("Path copied") fades after 4s, or 8s when it offers one action as a quiet button ("Archived … · Undo"). A later unrelated success never clears an unread error.

### Keyboard
⌘K opens a switcher over sessions and terminals, with what waits for the owner first. `?` lists every shortcut. Single keys (j/k, r, /, c, n, f, t, 1–3) act only when the owner isn't typing and never inside the terminal; Escape in an empty, idle composer leaves it. Key hints are drawn as `kbd`: mono 11px in a 1px strong-rule square, one key per box (⇧ and ↵ are two boxes), alternatives set apart by "·", and the word after the same small gap everywhere.

### Motion
Short and typographic. Hover and colour changes take 120ms; transcript entries take 200ms on `cubic-bezier(0.16, 1, 0.3, 1)` and settle 2px up while fading in. What needs the owner and what reorders springs: a request (its block and its tray line) springs 16px in from the left margin and the sessions list settles on a spring of 320ms visual duration with a 0.22 bounce, a slight overshoot and never a wobble. A running state mark breathes (opacity to 40% and back over 2.4s); a turn that ends on its own shows `done` for 1.5s while its mark lands (scales down from 1.7x through 0.85x to rest, then turns hollow). An answered request is struck through, then fades and collapses in 450ms; meters fill in 400ms. Sound is opt-in and off by default: a rising two-note sine chime (E5, A5) when an agent needs a decision and one soft D5 when a turn ends, about 0.35s each at low volume, synthesized with no audio files; a burst of events makes one chime. Under reduced motion, entries are a 120ms linear fade and nothing travels or breathes, and a global guard in the stylesheet removes all CSS transitions and animations.

## Do's and Don'ts

### Do:
- **Do** divide regions with 1px `rule` hairlines on the one `paper` sheet.
- **Do** show state with the square mark's form (solid, hollow, struck, dashed) and a lowercase mono word.
- **Do** reserve `act` for pressable controls, links and focus; `req-mark` for what needs the owner; `bad` for failure and destruction.
- **Do** set buttons, labels, paths, numbers and keywords in PT Mono 400, and prose in the system sans.
- **Do** keep 2px corners and 1px borders; draw counts as squares.
- **Do** record every answered request as a decision line in the transcript.
- **Do** give every new motion a reduced-motion variant that only fades.
- **Do** keep light and dark on the same roles, switched by `prefers-color-scheme`.

### Don't:
- **Don't** use elevation shadows, blur, glass, or gradient fills; `box-shadow` is allowed only as a 1px focus ring or inset hairline.
- **Don't** put a hue on session or terminal state.
- **Don't** use amber or ink-blue decoratively, or red for emphasis.
- **Don't** use `paper-2` as a panel or card background.
- **Don't** draw chat bubbles; user turns are ruled sections.
- **Don't** use pill shapes or radii above 2px.
- **Don't** load fonts from a CDN; the UI must work offline.
- **Don't** style Claude or Codex as the default; both are a letter in the same box.
