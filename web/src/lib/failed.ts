// failedTo is the one form every failure is told in: "Couldn't <verb>
// <noun>: <reason>". It leads with what the owner tried, and the reason
// follows when there is one.
export function failedTo(action: string, reason?: string | null): string {
  return reason ? `Couldn't ${action}: ${reason}` : `Couldn't ${action}`
}
