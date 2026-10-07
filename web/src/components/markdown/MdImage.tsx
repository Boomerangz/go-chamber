import { useContext, useState } from 'react'
import { filePath, fileUrl, SessionFiles } from '../../lib/files'

// nameOf is the file an image address points at, for an image without alt text.
function nameOf(src: string): string {
  const path = src.replace(/[?#].*$/, '')
  return decodeSafe(path.slice(path.lastIndexOf('/') + 1)) || 'untitled'
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// MdImage draws an image in agent text. A remote one is a link, never
// fetched: loading it would tell its host the page was read, and the app
// works offline. A file of the session folder loads through the server, and
// one that can't be read says so instead of a broken-image icon.
export default function MdImage({ src, alt }: { src?: string; alt?: string }) {
  const sessionId = useContext(SessionFiles)
  const [failed, setFailed] = useState(false)
  const path = filePath(src)
  const name = alt?.trim() || (src ? nameOf(src) : 'untitled')
  if (src && path === null) {
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className="md-image-link" title={src}>
        image: {name} ↗
      </a>
    )
  }
  if (!sessionId || !path || failed) {
    return (
      <span className="md-image-missing" title={path ?? undefined}>
        image: {name}
        {failed && " · couldn't load"}
      </span>
    )
  }
  return <img className="md-image" src={fileUrl(sessionId, path)} alt={name} loading="lazy" onError={() => setFailed(true)} />
}
