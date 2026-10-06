import { numberedParts } from './numbered'

// TermTitle shows a shell's title on one line: when it doesn't fit, the
// name gives way and a number like " 2" stays, so numbered shells of one
// folder stay apart.
export default function TermTitle({ title, className }: { title: string; className?: string }) {
  const { name, n } = numberedParts(title)
  const cls = className ? `numbered ${className}` : 'numbered'
  if (!n) {
    return (
      <span className={cls}>
        <span className="numbered-name">{name}</span>
      </span>
    )
  }
  // Screen readers get the title whole; the split is only for the eye.
  return (
    <span className={cls}>
      <span className="sr-only">{title}</span>
      <span className="numbered-name" aria-hidden="true">
        {name}
      </span>
      <span className="numbered-n" aria-hidden="true">
        {n}
      </span>
    </span>
  )
}
