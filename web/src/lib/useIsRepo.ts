import { useEffect, useState } from 'react'
import { listFolders } from './api'

// parentOf splits an absolute folder path into its parent and its name;
// null for the root or a path that isn't absolute.
export function parentOf(path: string): { parent: string; name: string } | null {
  const p = path.trim().replace(/\/+$/, '')
  if (!p.startsWith('/')) return null
  const cut = p.lastIndexOf('/')
  return { parent: cut === 0 ? '/' : p.slice(0, cut), name: p.slice(cut + 1) }
}

// useIsRepo says whether a folder is a git repository, as the folder picker
// sees it: true, false, or null while unknown (still asking, not an
// absolute path, or the server couldn't say). It asks a moment after the
// path stops changing.
export function useIsRepo(path: string, enabled = true): boolean | null {
  const [known, setKnown] = useState<{ path: string; repo: boolean } | null>(null)
  const where = enabled ? parentOf(path) : null
  const key = where ? `${where.parent}/${where.name}` : null
  useEffect(() => {
    const at = key === null ? null : parentOf(key)
    if (!at) return
    let live = true
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => listFolders(at.parent, true))
        .then((listing) => {
          const entry = listing.folders.find((f) => f.name === at.name)
          if (live && entry) setKnown({ path: key!, repo: Boolean(entry.repo) })
        })
        // the server couldn't say: the answer stays unknown
        .catch(() => {})
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key])
  return known !== null && known.path === key ? known.repo : null
}
