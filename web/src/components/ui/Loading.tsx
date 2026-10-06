// Shared quiet states: what is loading, what failed (with a way to try
// again), and dashed placeholders where rows will land.

export function LoadingLine({ children }: { children: string }) {
  return (
    <p className="loading-line" role="status" aria-live="polite">
      {children}
    </p>
  )
}

export function LoadFailed({ children, onRetry }: { children: string; onRetry?: () => void }) {
  return (
    <div className="load-failed" role="alert">
      <span>{children}</span>
      {onRetry && (
        <button type="button" className="btn btn-xs" onClick={onRetry}>
          Retry
        </button>
      )}
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
