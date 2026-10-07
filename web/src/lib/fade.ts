// fadeOf names the edges a scroll box still has more past: "start" when it
// is scrolled away from its start, "end" when more lies past its end.
export function fadeOf(scrollLeft: number, scrollWidth: number, clientWidth: number): string {
  const edges: string[] = []
  if (scrollLeft > 1) edges.push('start')
  if (scrollLeft + clientWidth < scrollWidth - 1) edges.push('end')
  return edges.join(' ')
}
