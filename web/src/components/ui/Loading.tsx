// Shared quiet states: what is loading, what failed (with a way to try
// again), and dashed placeholders where rows will land.

export function LoadingLine({ children }: { children: string }) {
  return (
    <p className="loading-line" role="status" aria-live="polite">
      {children}
    </p>
  )
}

// LoadFailed says what failed and why, with Retry right after the reason:
// the last word and the button never part, so Retry never wraps alone.
export function LoadFailed({ children, onRetry }: { children: string; onRetry?: () => void }) {
  if (!onRetry) {
    return (
      <div className="load-failed" role="alert">
        <span>{children}</span>
      </div>
    )
  }
  const cut = children.trimEnd().lastIndexOf(' ') + 1
  return (
    <div className="load-failed" role="alert">
      <span>
        {children.slice(0, cut)}
        <span className="load-failed-tail">
          {children.slice(cut).trimEnd()}
          <button type="button" className="btn btn-xs" onClick={onRetry}>
            Retry
          </button>
        </span>
      </span>
    </div>
  )
}

const widths = ['72%', '48%', '64%', '40%', '58%']

export function Skeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" aria-hidden="true">
          <div className="skeleton-lines">
            <span className="skeleton-line" style={{ '--w': widths[i % widths.length] } as React.CSSProperties} />
            <span className="skeleton-line" style={{ '--w': '28%' } as React.CSSProperties} />
          </div>
        </div>
      ))}
    </div>
  )
}
