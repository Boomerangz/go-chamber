// BRANCH_PREFIX namespaces the branches go-chamber creates.
export const BRANCH_PREFIX = 'chamber/'
const MAX = 50

// slugify turns a typed name into the branch slug the server makes of it
// (internal/app/worktrees.go slugify): lowercase latin letters, digits, _
// and inner dots; anything else becomes one dash; cut to 50.
export function slugify(name: string): string {
  return cut(slugBody(name))
}

// slugBody is the slug before it is cut to length.
function slugBody(name: string): string {
  let out = ''
  let dash = false
  let rest = name.trim()
  if (rest.startsWith(BRANCH_PREFIX)) rest = rest.slice(BRANCH_PREFIX.length)
  for (const ch of rest.toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_' || (ch === '.' && out.length > 0)) {
      out += ch
      dash = false
    } else if (!dash && out.length > 0) {
      out += '-'
      dash = true
    }
  }
  return trim(out)
}

function cut(s: string): string {
  if (s.length > MAX) s = trim(s.slice(0, MAX))
  return s.replaceAll('..', '.')
}

const trim = (s: string) => s.replace(/^[-.]+|[-.]+$/g, '')

export interface BranchPreview {
  // branch is the branch the server will create.
  branch?: string
  // note says what the name lost on the way.
  note?: string
  // error refuses a name nothing can be made of.
  error?: string
}

// branchPreview says what a typed branch name becomes.
export function branchPreview(name: string): BranchPreview {
  if (!name.trim()) return {}
  const slug = slugify(name)
  if (!slug) return { error: 'Use latin letters or digits' }
  const out: BranchPreview = { branch: BRANCH_PREFIX + slug }
  // Letters outside the slug's alphabet (separators aside) are dropped.
  if (/[^a-z0-9_.\s/\-!?,:;'"()[\]]/i.test(name.trim())) out.note = 'only latin letters, digits, . and _ are kept'
  else if (slugBody(name).length > MAX) out.note = `cut to ${MAX} characters`
  return out
}

// branchError reads a refused worktree in the new-session form's words.
export function branchError(text: string): string | null {
  let m = /branch already exists: (\S+)/.exec(text)
  if (m) return `Branch ${m[1]} already exists`
  m = /worktree folder already exists: (.+)$/.exec(text)
  if (m) return `Its worktree folder ${m[1]} already exists`
  if (/invalid branch name/.test(text)) return 'Use latin letters or digits'
  m = /branch (\S+) is checked out at (.+)$/.exec(text)
  if (m) return `Branch ${m[1]} is checked out in ${m[2]}`
  m = /no such branch: (\S+)/.exec(text)
  if (m) return `Branch ${m[1]} is no longer there`
  return null
}

// continuable tells a refused branch that is there and checked out nowhere:
// the form offers to go on with it in a new worktree.
export function continuable(text: string | null): boolean {
  return text !== null && /branch already exists: /.test(text)
}

// folderError reads a server refusal of the folder a session was asked to
// start in, for the form to say under its folder field; null when the
// refusal isn't about the folder.
export function folderError(text: string): string | null {
  if (/^Folder .+ (doesn't exist|no longer exists)$/.test(text)) return text
  if (/not a git repository/.test(text)) return 'Not a git repository'
  return null
}
