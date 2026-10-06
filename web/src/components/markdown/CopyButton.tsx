import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { icon } from '../icon'
import { copyText } from '../../lib/clipboard'

const COPIED_MS = 1500

// CopyButton copies text and says "Copied" for a moment. With iconOnly it is
// a square icon button whose name carries the label.
export default function CopyButton({
  text,
  label = 'Copy',
  className = '',
  iconOnly = false,
}: {
  text: string
  label?: string
  className?: string
  iconOnly?: boolean
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])
  const name = copied ? 'Copied' : label
  return (
    <button
      type="button"
      className={`btn btn-ghost ${iconOnly ? 'btn-icon' : 'btn-xs'} copy-btn ${className}`}
      aria-label={iconOnly ? name : undefined}
      title={iconOnly ? name : undefined}
      onClick={async (e) => {
        e.stopPropagation()
        if (await copyText(text)) setCopied(true)
      }}
    >
      {iconOnly ? (copied ? <Check {...icon(14)} /> : <Copy {...icon(14)} />) : name}
    </button>
  )
}
