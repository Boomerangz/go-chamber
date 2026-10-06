// numberedParts splits a shell's title like "frontend-application 2" into
// the name, which may give way, and the number that tells shells apart.
export function numberedParts(title: string): { name: string; n: string } {
  const m = /^(.*\S)( \d+)$/.exec(title)
  return m ? { name: m[1]!, n: m[2]! } : { name: title, n: '' }
}
