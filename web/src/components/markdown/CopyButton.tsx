import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { icon } from '../icon'
import { copyText } from '../../lib/clipboard'
import { usePending } from '../../lib/pending'

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
  const [copy, copying] = usePending(async () => {
    setCopied(false)
    if (await copyText(text, label.startsWith('Copy ') ? label.slice(5) : undefined)) setCopied(true)
  })
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])
  const name = copying ? 'Copying…' : copied ? 'Copied' : label
  return (
    <button
      type="button"
      className={`btn btn-ghost ${iconOnly ? 'btn-icon' : 'btn-xs'} copy-btn ${className}`}
      aria-label={iconOnly ? name : undefined}
      title={iconOnly ? name : undefined}
      aria-busy={copying || undefined}
      aria-disabled={copying || undefined}
      onClick={(e) => {
        e.stopPropagation()
        void copy()
      }}
    >
      {iconOnly ? (copied ? <Check {...icon(14)} /> : <Copy {...icon(14)} />) : name}
    </button>
  )
}
