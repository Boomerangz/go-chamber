---
version: 1
slug: "web-src-app-tsx"
primary_target: "web/src/App.tsx"
related_targets: ["web/src/index.css"]
---

# Surface: go-chamber app shell (sessions · chat · requests · terminal)

Mode: Operate. Audience/job per PRODUCT.md: one developer supervising Claude and Codex sessions,
mostly desktop, also phone and remote browser. Constraints: e2e class names and roles stay;
light + dark by system setting; offline (self-hosted fonts); reduced motion respected.

## Direction contract

THESIS: Every session reads as a living specification: numbered sections, normative keywords,
plaintext discipline. Refuses the category default of a dark glass dashboard with gradient chat
bubbles and neon accents.

OWN-WORLD: One sheet, one ink. Cool paper #F3F3F1 / ink #16171A (dark: #0F1012 / #E4E2DC),
hairline rules, ink-blue #2433D6 only for the actionable, amber #B86A00 only for REQUIRES.
Mono (Iosevka) carries structure: section numbers, labels, keywords, metadata, controls
in [brackets]. System sans carries prose. Square corners, no shadows, no gradients, no glass.
State is form: solid mark running, dashed waiting, struck stopped.

STORY: The user scans the TOC, sees which sessions run, wait or need them, opens one, reads
the transcript as numbered turns, and answers a REQUIRES block without hunting.

FIRST VIEWPORT: Left, the sessions TOC as a numbered outline (1. tmp / 1.1 hello…) in a fixed
label grid (title / agent / state / age). Centre, the transcript: turn numbers hung in the left
margin, user turns as ruled quotations, not bubbles; tool output in indented plaintext blocks.
A pending request sits as a boxed "REQUIRES: APPROVAL" block with [ Allow ] [ Deny ] directly
above the composer. Header: session title as the document title, path + agent + model as the
masthead line.

FORM: RFC / man-page plaintext specification standard; position 6 of the ordered list;
seed key 08a9a611. Raises: state by form (emission rail), "you stopped here" flag (cutting
bench), fixed label grid for session rows (sneaker boxes).

SIGNATURE: the REQUIRES block — enters from the margin with a drawn rule, holds the only amber
on screen, and resolves by striking through into a one-line record (APPROVED / DENIED).
Motion grammar: short, typographic: rules draw, marks morph, items settle 2px; nothing bounces.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
