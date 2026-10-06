import { useEffect, useState } from 'react'
import { listFolders } from './api'

// parentOf splits an absolute folder path into its parent and its name;
// null for the root or a path that isn't absolute.
export function parentOf(path: string): { parent: string; name: string } | null {
  const p = path.trim().replace(/\/+$/, '')
  if (!p.startsWith('/') || p === '') return null
  const cut = p.lastIndexOf('/')
  return { parent: cut === 0 ? '/' : p.slice(0, cut), name: p.slice(cut + 1) }
}

// useIsRepo says whether a folder is a git repository, as the folder picker
// sees it: true, false, or null while unknown (still asking, not an
// absolute path, or the server couldn't say). It asks a moment after the
// path stops changing.
export function useIsRepo(path: string, enabled = true): boolean | null {
  const [known, setKnown] = useState<{ path: string; repo: boolean | null }>({ path: '', repo: null })
  const where = enabled ? parentOf(path) : null
  const parent = where?.parent
  const name = where?.name
  useEffect(() => {
    if (parent === undefined || name === undefined) return
    let live = true
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => listFolders(parent, true))
        .then(
          (listing) => {
            const entry = listing?.folders?.find((f) => f.name === name)
            if (live) setKnown({ path: `${parent}/${name}`, repo: entry ? Boolean(entry.repo) : null })
          },
          () => live && setKnown({ path: `${parent}/${name}`, repo: null }),
        )
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [parent, name])
  if (parent === undefined || name === undefined) return null
  return known.path === `${parent}/${name}` ? known.repo : null
}
