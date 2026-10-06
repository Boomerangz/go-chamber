import './MidCut.css'

// tailOf is the part of a name that stays when it is cut: the extension and
// a few characters before it, where similar names usually differ.
function tailOf(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.length - dot : 0
  const keep = Math.max(ext + 8, 10)
  return keep >= name.length - 3 ? '' : name.slice(name.length - keep)
}

// MidCut shows a file name on one line; when it doesn't fit, its middle
// gives way ("…") and the end with the extension stays. Screen readers get
// the name whole, as one word.
export default function MidCut({ text, className }: { text: string; className?: string }) {
  const tail = tailOf(text)
  const cls = className ? `midcut ${className}` : 'midcut'
  if (!tail) return <span className={cls}>{text}</span>
  return (
    <span className={cls}>
      <span className="sr-only">{text}</span>
      <span className="midcut-head" aria-hidden="true">
        {text.slice(0, text.length - tail.length)}
      </span>
      <span className="midcut-tail" aria-hidden="true">
        {tail}
      </span>
    </span>
  )
}
