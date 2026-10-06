import { useHome } from '../../lib/home'
import { pathParts } from '../../lib/path'
import './PathText.css'

// PathText shows a folder path on one line, home as "~". When it doesn't
// fit, the start gives way ("…") and the last folder, the project's name,
// stays. The title and a copy keep the full path.
export default function PathText({ path, className }: { path: string; className?: string }) {
  const home = useHome()
  const { head, tail } = pathParts(path, home)
  return (
    <span className={className ? `path-text ${className}` : 'path-text'} title={path}>
      {head && (
        <span className="path-head">
          <bdi>{head}</bdi>
        </span>
      )}
      <span className="path-tail">{tail}</span>
    </span>
  )
}
