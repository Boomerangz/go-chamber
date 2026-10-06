// formatUptime reads a duration in seconds as "1h 12m" (or "3d 2h").
export function formatUptime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

export type MarkForm = 'solid' | 'hollow' | 'struck' | 'dashed'

// linkMark is the form of a connection's square mark: solid when up, dashed
// while being made, struck when lost, hollow when paused.
export function linkMark(status: string): MarkForm {
  switch (status) {
    case 'online':
      return 'solid'
    case 'connecting':
    case 'reconnecting':
      return 'dashed'
    case 'paused':
      return 'hollow'
    default:
      return 'struck'
  }
}
